import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { resolveContentType } from '../functions/utils/fileTypes.js';

const enhancerSource = fs.readFileSync('js/document-preview-enhancer.js', 'utf8');

function element(tagName = 'div') {
    return {
        tagName: tagName.toUpperCase(), children: [], listeners: {}, isConnected: true,
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        appendChild(child) { this.children.push(child); return child; },
        querySelector(selector) {
            if (selector === '.doc-preview-consent') return this.consent ||= element();
            return null;
        },
    };
}

function loadEnhancer(fetchImpl) {
    const document = {
        getElementById: () => ({}), querySelectorAll: () => [],
        createElement: element, addEventListener() {}, readyState: 'complete',
        head: element('head'), body: element('body'),
    };
    const sandbox = {
        document, fetch: fetchImpl, URL, Headers, Response, Uint8Array, ArrayBuffer,
        TextDecoder, AbortController, console, setTimeout: () => 1, clearTimeout() {},
        location: { origin: 'https://img.example', href: 'https://img.example/dashboard' },
    };
    vm.createContext(sandbox);
    // Exercise renderer functions directly without introducing a production test API.
    const source = enhancerSource.replace('getDocCategory: getDocCategory,',
        'getDocCategory: getDocCategory, renderOfficePreview: renderOfficePreview,');
    vm.runInContext(source, sandbox);
    return sandbox.DocumentPreviewEnhancer;
}

function loadWorker() {
    const messages = [];
    const sandbox = {
        ArrayBuffer, Uint8Array, DataView, TextDecoder, Promise, console,
        setTimeout, clearTimeout, setImmediate, clearImmediate,
        postMessage(message) { messages.push(message); },
    };
    sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    sandbox.importScripts = (...files) => {
        for (const file of files) vm.runInContext(fs.readFileSync(path.join('js', file), 'utf8'), context, { filename: file });
    };
    vm.runInContext(fs.readFileSync('js/document-office-worker.js', 'utf8'), context);
    return { sandbox, messages };
}

async function zipBuffer(worker, contents) {
    const zip = new worker.sandbox.JSZip();
    for (const [name, value] of Object.entries(contents)) zip.file(name, value);
    return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('document preview UI', () => {
    it('classifies metadata MIME and original names instead of assuming every file is an image', () => {
        const api = loadEnhancer();
        assert.equal(api.getDocCategory('folder/报告.PDF?preview=1'), 'pdf');
        assert.equal(api.getDocCategory('folder/report%2Edocx'), 'office');
        assert.equal(api.getDocCategory({ fileId: 'opaque-id', fileName: 'contract.docx', mimeType: 'application/octet-stream' }), 'office');
        assert.equal(api.getDocCategory('opaque-id', 'application/pdf; charset=binary'), 'pdf');
        assert.equal(api.getDocCategory('opaque-id', 'text/plain; charset=utf-8'), 'text');
        assert.equal(api.getDocCategory('portrait.png', 'image/png'), null);
        assert.equal(api.getOfficeFormat({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'docx');
        assert.equal(api.getOfficeFormat({ fileName: 'report.xlsm' }), 'sheet');
        assert.equal(api.getOfficeFormat({ fileName: 'slides.pptx' }), 'online');
    });

    it('extracts the stored filename and MIME from the Element Plus details dialog', () => {
        const api = loadEnhancer();
        const labels = ['文件名', '文件类型'].map((textContent, index) => ({
            textContent,
            nextElementSibling: { textContent: ['private.docx', 'application/octet-stream'][index], querySelector: () => null },
        }));
        const dialog = {
            querySelector: () => null,
            querySelectorAll(selector) {
                if (selector.includes('.el-tabs')) return [{ value: 'https://img.example/file/opaque-id?from=admin' }];
                if (selector.includes('.el-descriptions')) return labels;
                return [];
            },
        };
        const info = api.extractFileUrlFromDialog(dialog);
        assert.equal(info.fileId, 'opaque-id');
        assert.equal(info.fileName, 'private.docx');
        assert.equal(api.getDocCategory(info), 'office');
    });

    it('routes macro-enabled, template and slideshow formats consistently with backend MIME inference', () => {
        const api = loadEnhancer();
        for (const [format, extensions] of [
            ['docx', ['docx', 'docm', 'dotx', 'dotm']],
            ['sheet', ['xls', 'xlt', 'xlsx', 'xltx', 'xlsm', 'xltm', 'xlsb', 'ods']],
            ['online', ['doc', 'dot', 'ppt', 'pot', 'pps', 'pptx', 'potx', 'ppsx', 'pptm', 'potm', 'ppsm']],
        ]) {
            for (const ext of extensions) {
                const fileName = 'sample.' + ext.toUpperCase();
                const mimeType = resolveContentType(fileName, 'application/x-zip-compressed');
                assert.equal(api.getDocCategory({ fileName }), 'office', ext);
                assert.equal(api.getOfficeFormat({ fileName }), format, ext);
                assert.equal(api.getDocCategory('opaque-id', mimeType), 'office', mimeType);
                assert.equal(api.getOfficeFormat({ mimeType }), format, mimeType);
            }
        }
    });

    it('uses mutually exclusive preview/download intent without treating from=admin as a credential', () => {
        const api = loadEnhancer();
        const preview = new URL(api.withIntent('/file/report.pdf?from=admin&download=1&token=private', 'preview'));
        assert.equal(preview.searchParams.get('preview'), '1');
        assert.equal(preview.searchParams.get('download'), null);
        assert.equal(preview.searchParams.get('from'), null);
        assert.equal(preview.searchParams.get('token'), 'private');
        const download = new URL(api.withIntent(preview.href, 'download'));
        assert.equal(download.searchParams.get('preview'), null);
        assert.equal(download.searchParams.get('download'), '1');
        for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://user:secret@img.example/file/a.pdf']) {
            assert.equal(api.withIntent(url, 'preview'), null);
        }
    });

    it('replaces stale explicit disposition when switching between preview and download', () => {
        const api = loadEnhancer();
        for (const disposition of ['inline', 'attachment']) {
            const original = '/file/report.pdf?disposition=' + disposition + '&token=private';
            const preview = new URL(api.withIntent(original, 'preview'));
            assert.equal(preview.searchParams.get('disposition'), null);
            assert.equal(preview.searchParams.get('preview'), '1');
            assert.equal(preview.searchParams.get('token'), 'private');
            const download = new URL(api.withIntent(original, 'download'));
            assert.equal(download.searchParams.get('disposition'), null);
            assert.equal(download.searchParams.get('download'), '1');
            assert.equal(download.searchParams.get('token'), 'private');
        }
    });

    it('does not share temporary, credential-bearing, non-HTTPS or private-network URLs with Office Online', () => {
        const api = loadEnhancer();
        assert.equal(api.canShareWithOffice('https://img.example/file/report.pptx?preview=1'), true);
        for (const url of [
            'https://img.example/temp/secret.pptx?preview=1',
            'https://img.example/file/report.pptx?token=secret&preview=1',
            'https://img.example/file/report.pptx?authCode=secret',
            'https://img.example/file/report.pptx#secret',
            'http://img.example/file/report.pptx',
            'https://localhost/file/report.pptx',
            'https://server.local/file/report.pptx',
            'https://192.168.1.2/file/report.pptx',
            'https://[::1]/file/report.pptx',
        ]) assert.equal(api.canShareWithOffice(url), false, url);
    });

    it('does not issue an anonymous request or embed Microsoft before explicit consent', () => {
        let requests = 0;
        const api = loadEnhancer(async () => { requests++; return new Response(null); });
        const body = element();
        api.renderOfficePreview(body, { url: 'https://img.example/file/slides.pptx', fileId: 'slides.pptx' });
        assert.equal(requests, 0);
        assert.doesNotMatch(body.innerHTML, /<iframe/);
        assert.match(body.consent.children[0].textContent, /我同意 Microsoft/);
    });

    it('refuses private Office files even after consent, without sending their URL to Microsoft', async () => {
        const requests = [];
        const api = loadEnhancer(async (url, options) => {
            requests.push({ url, options });
            return new Response(null, { status: 403 });
        });
        const body = element();
        api.renderOfficePreview(body, { url: 'https://img.example/file/slides.pptx', fileId: 'slides.pptx' });
        body.consent.children[0].listeners.click();
        await new Promise(setImmediate);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].options.credentials, 'omit');
        assert.equal(requests[0].options.method, 'HEAD');
        assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
        assert.doesNotMatch(body.innerHTML, /<iframe/);
        assert.match(body.innerHTML, /未向 Microsoft 发送链接/);
    });

    it('embeds a public Office document only after consent and a successful anonymous HEAD', async () => {
        const api = loadEnhancer(async () => new Response(null, { headers: { 'Content-Type': 'application/vnd.ms-powerpoint' } }));
        const body = element();
        api.renderOfficePreview(body, { url: 'https://img.example/file/slides.pptx', fileId: 'slides.pptx' });
        body.consent.children[0].listeners.click();
        await new Promise(setImmediate);
        assert.match(body.innerHTML, /view\.officeapps\.live\.com/);
        assert.match(body.innerHTML, /referrerpolicy="no-referrer"/);
    });

    it('resolves opaque file IDs by same-origin authenticated HEAD and filename metadata', async () => {
        let options;
        const api = loadEnhancer(async (_url, value) => {
            options = value;
            return new Response(null, { headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': "inline; filename*=UTF-8''report%2Edocx",
            } });
        });
        const info = { url: 'https://img.example/file/opaque-id', fileId: 'opaque-id' };
        assert.equal(await api.resolvePreviewCategory(info), 'office');
        assert.equal(info.fileName, 'report.docx');
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.redirect, 'error');
    });

    it('bounds streamed text reads even when Content-Length is missing or dishonest', async () => {
        const api = loadEnhancer();
        let cancelled = false;
        const response = new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); },
            cancel() { cancelled = true; },
        }), { headers: { 'Content-Length': '1' } });
        await assert.rejects(api.readBoundedResponse(response, 10), /大小上限/);
        assert.equal(cancelled, true);
        const bytes = await api.readBoundedResponse(new Response('small'), 10);
        assert.equal(new TextDecoder().decode(bytes), 'small');
    });

    it('cancels oversized bodies before reading when the server supplies their length', async () => {
        const api = loadEnhancer();
        let cancelled = false;
        const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': '100' } });
        await assert.rejects(api.readBoundedResponse(response, 10), /大小上限/);
        assert.equal(cancelled, true);
    });

    it('isolates DOCX rendering and disables active HTML, links, scripts and remote resources', () => {
        const frame = fs.readFileSync('document-preview.html', 'utf8');
        const renderer = fs.readFileSync('js/document-docx-frame.js', 'utf8');
        assert.match(enhancerSource, /setAttribute\('sandbox', 'allow-scripts'\)/);
        assert.doesNotMatch(enhancerSource, /allow-same-origin/);
        assert.match(frame, /connect-src 'none'/);
        assert.match(frame, /img-src data: blob:/);
        assert.match(frame, /form-action 'none'/);
        assert.match(renderer, /renderAltChunks: false/);
        assert.match(renderer, /ignoreFonts: true/);
        assert.match(renderer, /stripActiveContent\(content\)/);
        assert.match(renderer, /link, meta, base/);
        assert.match(renderer, /foreignObject, animate, animateTransform, set/);
        assert.match(renderer, /event\.source !== global\.parent/);
        assert.match(renderer, /event\.origin !== new URL\(global\.location\.href\)\.origin/);
        assert.doesNotMatch(enhancerSource, /https:\/\/(cdn\.jsdelivr|unpkg)/);
    });

    it('accepts DOCX render messages only from the embedding application origin and parent window', async () => {
        let renderMessage;
        let calls = 0;
        const parent = { postMessage() {} };
        const sandbox = {
            URL, location: { href: 'https://img.example/document-preview.html' }, parent,
            addEventListener(_type, callback) { renderMessage = callback; },
            docx: { async renderAsync() { calls++; } },
            DocumentArchiveGuards: { inspectZip() {} },
            document: {
                addEventListener() {},
                createElement() { return { querySelectorAll: () => [] }; },
                getElementById() { return { appendChild() {}, remove() {} }; },
            },
        };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync('js/document-docx-frame.js', 'utf8'), sandbox);
        const data = { source: 'doc-preview-host', type: 'render', buffer: new ArrayBuffer(1) };
        await renderMessage({ source: parent, origin: 'https://attacker.example', data });
        await renderMessage({ source: {}, origin: 'https://img.example', data });
        assert.equal(calls, 0);
        await renderMessage({ source: parent, origin: 'https://img.example', data });
        assert.equal(calls, 1);
    });
});

describe('local document parser safeguards', function () {
    this.timeout(20000);

    it('parses real XLSX data in the worker and caps worksheet rows and columns', async () => {
        const worker = loadWorker();
        worker.sandbox.importScripts('vendor/xlsx-0.20.3.full.min.js');
        const { XLSX } = worker.sandbox;
        assert.equal(XLSX.version, '0.20.3');
        const book = XLSX.utils.book_new();
        const values = Array.from({ length: 310 }, (_, row) => Array.from({ length: 52 }, (_, col) => `${row}:${col}`));
        values[0][0] = '<img src=x onerror=alert(1)>';
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), 'First');
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Second sheet']]), 'Second');
        const buffer = XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true });
        await worker.sandbox.onmessage({ data: { type: 'open', format: 'sheet', buffer, id: 1 } });
        const first = worker.messages[0];
        assert.equal(first.type, 'sheet', first.message);
        assert.equal(first.rows.length, 300);
        assert.equal(first.columns.length, 50);
        assert.equal(first.rows[0][0], '<img src=x onerror=alert(1)>');
        assert.equal(first.limited, true);
        await worker.sandbox.onmessage({ data: { type: 'sheet', sheet: 'Second', id: 2 } });
        assert.equal(worker.messages[1].rows[0][0], 'Second sheet');
    });

    it('validates Office ZIPs before passing DOCX data to the sandbox renderer', async () => {
        const worker = loadWorker();
        const buffer = await zipBuffer(worker, { '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document/>' });
        const inspected = worker.sandbox.DocumentArchiveGuards.inspectZip(buffer);
        assert.equal(inspected.entries.filter(entry => !entry.name.endsWith('/')).length, 2);
        await worker.sandbox.onmessage({ data: { type: 'open', format: 'docx', buffer, id: 1 } });
        assert.equal(worker.messages[0].type, 'docx', worker.messages[0].message);
    });

    it('rejects ZIP path traversal, extreme expansion and malformed directory entries', async () => {
        const worker = loadWorker();
        const traversal = await zipBuffer(worker, { '../word/document.xml': '<document/>' });
        assert.throws(() => worker.sandbox.DocumentArchiveGuards.inspectZip(traversal), /Unsafe/);
        const bomb = await zipBuffer(worker, { 'word/document.xml': 'A'.repeat(2 * 1024 * 1024) });
        assert.throws(() => worker.sandbox.DocumentArchiveGuards.inspectZip(bomb), /expansion limit/);
        assert.throws(() => worker.sandbox.DocumentArchiveGuards.inspectZip(new ArrayBuffer(22)), /Invalid/);
    });

    it('counts actual expanded bytes instead of trusting forged ZIP length metadata', async () => {
        const worker = loadWorker();
        const buffer = await zipBuffer(worker, { 'word/document.xml': 'A'.repeat(10000) });
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        for (let i = 0; i < bytes.length - 46; i++) {
            if (view.getUint32(i, true) === 0x02014b50) {
                const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + view.getUint16(i + 28, true)));
                if (name === 'word/document.xml') { view.setUint32(i + 24, 10, true); break; }
            }
        }
        await worker.sandbox.onmessage({ data: { type: 'open', format: 'docx', buffer, id: 1 } });
        assert.equal(worker.messages[0].type, 'error');
        assert.match(worker.messages[0].message, /size|expanded/i);
    });

    it('refuses oversized documents before loading a workbook or decompressing', async () => {
        const worker = loadWorker();
        await worker.sandbox.onmessage({ data: { type: 'open', format: 'sheet', buffer: new ArrayBuffer(15 * 1024 * 1024 + 1), id: 1 } });
        assert.equal(worker.messages[0].type, 'error');
        assert.match(worker.messages[0].message, /15 MiB/);
    });

    it('keeps pinned, licensed, locally served renderer assets byte-for-byte reproducible', () => {
        const hashes = {
            'jszip-3.10.1.min.js': 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e',
            'docx-preview-0.3.6.min.js': '3573b8d993442316042e95c782338b503b2a7cd573d336db894b87799c9d3097',
            'xlsx-0.20.3.full.min.js': 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41',
            'marked-11.2.0.min.js': 'e479cd780b6f4fe1494c6b4087505fa987f27f5ba6e0730a588e8398a07ee6e1',
        };
        for (const [file, expected] of Object.entries(hashes)) {
            assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join('js/vendor', file))).digest('hex'), expected, file);
        }
        for (const file of ['jszip-LICENSE.txt', 'docx-preview-LICENSE.txt', 'xlsx-LICENSE.txt', 'marked-LICENSE.txt']) {
            assert.ok(fs.readFileSync(path.join('js/vendor', file), 'utf8').length > 1000, file);
        }
    });
});
