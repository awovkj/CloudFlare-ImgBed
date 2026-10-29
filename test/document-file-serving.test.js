import assert from 'node:assert/strict';
import fs from 'node:fs';
import { onRequest as serveFile } from '../functions/file/[[path]].js';
import { onRequest as serveTemporaryFile } from '../functions/temp/[[path]].js';
import { createSession } from '../functions/utils/auth/sessionManager.js';
import * as fileTools from '../functions/file/fileTools.js';
import { resolveContentType } from '../functions/utils/fileTypes.js';
import { createServerErrorResponse } from '../functions/utils/response.js';

const bytes = new TextEncoder().encode('0123456789');
const uploaded = new Date('2026-01-01T00:00:00Z');

function byteStream(value) {
    return new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } });
}

function createBucket(value = bytes) {
    const calls = { head: 0, get: [] };
    const metadata = () => ({
        size: value.length,
        etag: 'version-1',
        httpEtag: '"version-1"',
        uploaded,
        writeHttpMetadata(headers) {
            headers.set('Content-Type', 'application/octet-stream');
            headers.set('Content-Disposition', 'attachment');
        },
    });
    return {
        calls,
        async head() { calls.head++; return metadata(); },
        async get(_key, options = {}) {
            calls.get.push(options);
            const offset = options.range?.offset ?? 0;
            const length = options.range?.length ?? value.length;
            const segment = value.slice(offset, offset + length);
            return { ...metadata(), body: byteStream(segment), range: options.range ? { offset, length: segment.length } : undefined };
        },
    };
}

function fixture({ fileId = 'document.pdf', channel = 'CloudflareR2', metadata = {}, uploadConfig = {}, vars = {} } = {}) {
    const values = new Map();
    const records = new Map([[fileId, {
        value: '',
        metadata: { Channel: channel, FileName: 'document.pdf', FileType: 'application/octet-stream', FileSizeBytes: bytes.length, ...metadata },
    }]]);
    values.set('manage@sysConfig@upload', JSON.stringify(uploadConfig));
    const bucket = createBucket();
    const env = {
        BASIC_USER: 'fixture-admin',
        BASIC_PASS: 'fixture-password-not-for-production',
        ...vars,
        img_r2: bucket,
        img_url: {
            async get(key) { return values.get(key) ?? null; },
            async getWithMetadata(key) { return records.get(key) ?? null; },
            async put(key, value) { values.set(key, value); },
            async delete(key) { values.delete(key); },
            async list() { return { keys: [], list_complete: true }; },
        },
    };
    function context({ method = 'GET', headers = {}, search = '?preview=1', path = fileId } = {}) {
        const encoded = encodeURIComponent(path.split('/').join(','));
        return {
            request: new Request(`https://img.example/file/${encoded}${search}`, { method, headers }),
            env,
            params: { path: encoded },
            data: {},
            waitUntil() {},
        };
    }
    return { env, bucket, records, values, context };
}

describe('document file delivery', () => {
    let originalFetch;
    let originalCaches;
    let originalFixedLengthStream;
    let lengthCalls;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalCaches = globalThis.caches;
        originalFixedLengthStream = globalThis.FixedLengthStream;
        lengthCalls = [];
        globalThis.caches = { default: { async match() {}, async put() {} } };
        globalThis.fetch = async () => new Response(new Uint8Array([0, 1]), { headers: { 'Content-Type': 'image/png' } });
        globalThis.FixedLengthStream = class extends TransformStream {
            constructor(length) {
                let seen = 0;
                lengthCalls.push(length);
                super({
                    transform(chunk, controller) {
                        seen += chunk.byteLength;
                        if (seen > length) throw new Error('Overlong fixed-length body');
                        controller.enqueue(chunk);
                    },
                    flush() { if (seen !== length) throw new Error('Short fixed-length body'); },
                });
            }
        };
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
        globalThis.FixedLengthStream = originalFixedLengthStream;
    });

    it('corrects legacy octet-stream metadata and overrides R2 attachment headers for PDF', async () => {
        const f = fixture();
        const response = await serveFile(f.context());
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'application/pdf');
        assert.match(response.headers.get('Content-Disposition'), /^inline;/);
        assert.match(response.headers.get('Access-Control-Expose-Headers'), /Content-Range/);
        assert.equal(response.headers.get('ETag'), '"version-1"');
        assert.equal(response.headers.get('Cache-Control'), fileTools.FILE_CACHE_CONTROL.PUBLIC);
        assert.equal(await response.text(), '0123456789');
        assert.deepEqual(lengthCalls, [10]);
    });

    for (const [range, expected, contentRange] of [
        ['bytes=2-5', '2345', 'bytes 2-5/10'],
        ['bytes=5-', '56789', 'bytes 5-9/10'],
        ['bytes=-4', '6789', 'bytes 6-9/10'],
        ['bytes=8-100', '89', 'bytes 8-9/10'],
    ]) {
        it(`streams the exact R2 range ${range}`, async () => {
            const f = fixture();
            const response = await serveFile(f.context({ headers: { Range: range } }));
            assert.equal(response.status, 206);
            assert.equal(response.headers.get('Content-Range'), contentRange);
            assert.equal(response.headers.get('Content-Length'), String(expected.length));
            assert.equal(await response.text(), expected);
            assert.equal(f.bucket.calls.head, 1);
            assert.equal(f.bucket.calls.get.length, 1);
            assert.deepEqual(f.bucket.calls.get[0].onlyIf, { etagMatches: 'version-1' });
        });
    }

    for (const range of ['bytes=0-1,4-5', 'bytes=-0', 'bytes=10-', 'bytes=5-4', 'xbytes=0-1', 'bytes=1.5-3']) {
        it(`rejects unsupported or unsatisfiable R2 ranges: ${range}`, async () => {
            const f = fixture();
            const response = await serveFile(f.context({ headers: { Range: range } }));
            assert.equal(response.status, 416);
            assert.equal(response.headers.get('Content-Range'), 'bytes */10');
            assert.match(response.headers.get('Cache-Control'), /no-store/);
            assert.equal(f.bucket.calls.get.length, 0);
        });
    }

    it('handles HEAD with metadata only and ignores Range on HEAD', async () => {
        const f = fixture();
        const response = await serveFile(f.context({ method: 'HEAD', headers: { Range: 'bytes=2-5' } }));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Length'), '10');
        assert.equal(response.headers.get('Content-Range'), null);
        assert.equal(await response.text(), '');
        assert.equal(f.bucket.calls.head, 1);
        assert.equal(f.bucket.calls.get.length, 0);
        assert.deepEqual(lengthCalls, []);
    });

    it('handles empty R2 objects and unsatisfiable ranges without fetching a body', async () => {
        const f = fixture();
        f.env.img_r2 = createBucket(new Uint8Array());
        const head = await serveFile(f.context({ method: 'HEAD' }));
        assert.equal(head.headers.get('Content-Length'), '0');
        const range = await serveFile(f.context({ headers: { Range: 'bytes=0-' } }));
        assert.equal(range.status, 416);
        assert.equal(range.headers.get('Content-Range'), 'bytes */0');
        assert.equal(f.env.img_r2.calls.get.length, 0);
    });

    it('recognizes the real KV missing-object shape before trying an upstream request', async () => {
        const f = fixture();
        f.records.set('document.pdf', { value: null, metadata: null });
        globalThis.fetch = () => { throw new Error('must not fetch an absent file'); };
        assert.equal((await serveFile(f.context())).status, 404);
    });

    for (const condition of [{ 'If-None-Match': 'W/"version-1"' }, { 'If-None-Match': '*' }, { 'If-Modified-Since': uploaded.toUTCString() }]) {
        it(`returns 304 without opening a body for ${JSON.stringify(condition)}`, async () => {
            const f = fixture();
            const response = await serveFile(f.context({ headers: condition }));
            assert.equal(response.status, 304);
            assert.equal(response.headers.get('Content-Length'), null);
            assert.equal(f.bucket.calls.get.length, 0);
        });
    }

    it('gives If-None-Match precedence over If-Modified-Since', async () => {
        const f = fixture();
        const response = await serveFile(f.context({ headers: { 'If-None-Match': '"different"', 'If-Modified-Since': uploaded.toUTCString() } }));
        assert.equal(response.status, 200);
        await response.arrayBuffer();
    });

    for (const [ifRange, status] of [['"version-1"', 206], ['"different"', 200], ['W/"version-1"', 200], [uploaded.toUTCString(), 206]]) {
        it(`honors If-Range ${ifRange} with status ${status}`, async () => {
            const f = fixture();
            const response = await serveFile(f.context({ headers: { Range: 'bytes=2-5', 'If-Range': ifRange } }));
            assert.equal(response.status, status);
            assert.equal(await response.text(), status === 206 ? '2345' : '0123456789');
        });
    }

    it('returns 412 without reading a body when If-Match fails', async () => {
        const f = fixture();
        const response = await serveFile(f.context({ headers: { 'If-Match': '"different"' } }));
        assert.equal(response.status, 412);
        assert.equal(f.bucket.calls.get.length, 0);
    });

    it('does not return a partial body from a replaced object version', async () => {
        const f = fixture();
        const get = f.bucket.get.bind(f.bucket);
        f.bucket.get = async (key, options = {}) => options.onlyIf
            ? { size: 10, etag: 'version-2' } : get(key, options);
        const response = await serveFile(f.context({ headers: { Range: 'bytes=2-5', 'If-Range': '"version-1"' } }));
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '0123456789');
    });

    it('makes truncated streams observable instead of returning silent corruption', async () => {
        const f = fixture();
        const get = f.bucket.get.bind(f.bucket);
        f.bucket.get = async (...args) => ({ ...(await get(...args)), body: byteStream(bytes.slice(0, 9)) });
        const response = await serveFile(f.context());
        await assert.rejects(response.arrayBuffer(), /Short fixed-length body/);
    });

    it('does not treat a forged same-origin Referer as an admin credential', async () => {
        const f = fixture({ metadata: { ListType: 'Block' } });
        const response = await serveFile(f.context({ search: '?from=admin&preview=1', headers: { Referer: 'https://img.example/admin' } }));
        assert.equal(response.status, 403);
        assert.match(response.headers.get('Cache-Control'), /no-store/);
        assert.equal(f.bucket.calls.get.length, 0);
    });

    it('preserves authenticated admin previews without caching past session revocation', async () => {
        const f = fixture({ metadata: { ListType: 'Block' } });
        const session = await createSession(f.env, 'admin');
        const options = { search: '?from=admin&preview=1', headers: { Cookie: session.cookie.split(';')[0] } };
        const authorized = await serveFile(f.context(options));
        assert.equal(authorized.status, 200);
        assert.match(authorized.headers.get('Cache-Control'), /no-store/);
        await authorized.arrayBuffer();
        f.values.delete(`manage@session@${session.token}`);
        assert.equal((await serveFile(f.context(options))).status, 403);
    });

    for (const method of ['GET', 'HEAD']) {
        it(`recognizes a real admin session without a from query on ${method}`, async () => {
            const f = fixture({ metadata: { ListType: 'Block' } });
            const session = await createSession(f.env, 'admin');
            const response = await serveFile(f.context({ method, search: '?preview=1', headers: { Cookie: session.cookie.split(';')[0] } }));
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Content-Type'), 'application/pdf');
            assert.match(response.headers.get('Cache-Control'), /no-store/);
            assert.equal(await response.text(), method === 'HEAD' ? '' : '0123456789');
        });
    }

    it('lets only a real admin session preview documents outside whitelist mode', async () => {
        const f = fixture();
        f.values.set('manage@sysConfig@security', JSON.stringify({ access: { whiteListMode: true } }));
        assert.equal((await serveFile(f.context())).status, 403);
        const session = await createSession(f.env, 'admin');
        const response = await serveFile(f.context({ headers: { Cookie: session.cookie.split(';')[0] } }));
        assert.equal(response.status, 200);
        await response.arrayBuffer();
    });

    it('does not upgrade low-privilege API tokens into access to blocked documents', async () => {
        const f = fixture({ metadata: { ListType: 'Block' } });
        f.values.set('manage@sysConfig@security', JSON.stringify({ apiTokens: { tokens: { fixture: { token: 'fixture-token', permissions: ['upload', 'list'] } } } }));
        const response = await serveFile(f.context({ headers: { Authorization: 'Bearer fixture-token' }, search: '?from=admin&preview=1' }));
        assert.equal(response.status, 403);
        assert.equal(f.bucket.calls.get.length, 0);
    });

    it('requires an explicit admin permission for API-token document previews', async () => {
        const f = fixture({ metadata: { ListType: 'Block' } });
        f.values.set('manage@sysConfig@security', JSON.stringify({ apiTokens: { tokens: { fixture: { token: 'fixture-token', permissions: ['admin'] } } } }));
        const response = await serveFile(f.context({ headers: { Authorization: 'Bearer fixture-token' } }));
        assert.equal(response.status, 200);
        assert.match(response.headers.get('Cache-Control'), /no-store/);
        await response.arrayBuffer();
    });

    it('does not inherit authCore open setup mode for hints or fake credentials', async () => {
        const f = fixture({ metadata: { ListType: 'Block' }, vars: { BASIC_USER: '', BASIC_PASS: '' } });
        assert.equal((await serveFile(f.context({ search: '?from=admin&preview=1' }))).status, 403);
        assert.equal((await serveFile(f.context({ headers: { Authorization: 'Bearer fake-token' } }))).status, 403);
        assert.equal((await serveFile(f.context({ headers: { Cookie: 'admin_session=fake-session' } }))).status, 403);
        assert.equal(f.bucket.calls.get.length, 0);
    });

    it('serves temporary document links with no-store and re-checks expiration on every range', async () => {
        const f = fixture({ fileId: 'folder/100% complete?.pdf', metadata: { ListType: 'Block' } });
        const token = 'a1'.repeat(16);
        const key = `temp_link:${token}`;
        f.values.set(key, JSON.stringify({ fileId: 'folder/100% complete?.pdf', expiresAt: Date.now() + 60000 }));
        const context = () => ({
            request: new Request(`https://img.example/temp/${token}?preview=1`, { headers: { Range: 'bytes=-4' } }),
            env: f.env, params: { path: token }, waitUntil() {},
        });
        const allowed = await serveTemporaryFile(context());
        assert.equal(allowed.status, 206);
        assert.equal(await allowed.text(), '6789');
        assert.match(allowed.headers.get('Cache-Control'), /no-store/);
        f.values.set(key, JSON.stringify({ fileId: 'folder/100% complete?.pdf', expiresAt: Date.now() - 1 }));
        assert.equal((await serveTemporaryFile(context())).status, 410);
        assert.equal(f.bucket.calls.get.length, 1);
    });

    it('keeps active HTML/XML/SVG content from executing during preview', () => {
        for (const [name, type, disposition] of [
            ['page.html', 'image/png', 'attachment'],
            ['icon.svg', 'text/html', 'inline'],
            ['data.xml', '', 'inline'],
        ]) {
            const headers = new Headers();
            const mime = resolveContentType(name, type);
            fileTools.setCommonHeaders(headers, encodeURIComponent(name), mime, fileTools.FILE_CACHE_CONTROL.PUBLIC, { disposition: 'inline' });
            assert.match(headers.get('Content-Disposition'), new RegExp(`^${disposition};`));
            assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
            if (disposition === 'inline') assert.match(headers.get('Content-Security-Policy'), /sandbox/);
        }
    });

    for (const type of ['application/atom+xml', 'application/rss+xml', 'application/vnd.example+xml', 'text/xsl']) {
        it(`sandboxes XML-family MIME types even with unknown extensions: ${type}`, () => {
            const headers = new Headers();
            const mime = resolveContentType('feed.unknown', type);
            fileTools.setCommonHeaders(headers, 'feed.unknown', mime, fileTools.FILE_CACHE_CONTROL.PUBLIC, { disposition: 'inline' });
            assert.equal(headers.get('Content-Type'), type);
            assert.match(headers.get('Content-Security-Policy'), /default-src 'none'.*sandbox/);
            assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
        });
    }

    it('normalizes Office metadata without confusing OOXML documents with zip archives', () => {
        for (const [name, type] of [
            ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
            ['report.docm', 'application/vnd.ms-word.document.macroenabled.12'],
            ['template.dotx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'],
            ['template.dotm', 'application/vnd.ms-word.template.macroenabled.12'],
            ['table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
            ['table.xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12'],
            ['table.xlsb', 'application/vnd.ms-excel.sheet.binary.macroenabled.12'],
            ['template.xltx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template'],
            ['template.xltm', 'application/vnd.ms-excel.template.macroenabled.12'],
            ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
            ['slides.pptm', 'application/vnd.ms-powerpoint.presentation.macroenabled.12'],
            ['template.potx', 'application/vnd.openxmlformats-officedocument.presentationml.template'],
            ['template.potm', 'application/vnd.ms-powerpoint.template.macroenabled.12'],
            ['show.ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'],
            ['show.ppsm', 'application/vnd.ms-powerpoint.slideshow.macroenabled.12'],
        ]) {
            assert.equal(resolveContentType(name, 'application/x-zip-compressed'), type);
            const headers = new Headers();
            fileTools.setCommonHeaders(headers, name, type);
            assert.match(headers.get('Content-Disposition'), /^inline;/);
        }
        assert.equal(resolveContentType('unknown', 'application/pdf\r\nX-Test: injected'), 'application/octet-stream');
    });

    for (const channel of ['S3', 'Discord', 'HuggingFace', 'WebDAV']) {
        it(`uses a real upstream HEAD and forwards validators, not browser credentials (${channel})`, async () => {
            const name = 'fixture-channel';
            const config = {
                s3: { channels: [{ name, endpoint: 'https://s3.example', bucketName: 'fixture-bucket', cdnDomain: 'https://cdn.example', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' }] },
                discord: { channels: [{ name, botToken: 'fixture-bot', channelId: 'fixture-chat' }] },
                huggingface: { channels: [{ name, repo: 'fixture/documents', isPrivate: false }] },
                webdav: { channels: [{ name, baseUrl: 'https://dav.example', username: 'fixture-user', password: 'fixture-password' }] },
            };
            const f = fixture({ channel, uploadConfig: config, metadata: { ChannelName: name, S3FileKey: 'document.pdf', DiscordMessageId: 'fixture-message', HfFilePath: 'document.pdf', WebDAVFilePath: 'document.pdf' } });
            const requests = [];
            globalThis.fetch = async (input, options) => {
                if (String(input).includes('/api/v10/')) return new Response(JSON.stringify({ attachments: [{ url: 'https://cdn.discordapp.com/document.pdf' }] }));
                requests.push(options);
                return new Response(null, { headers: { 'Content-Length': '777', ETag: '"upstream-version"', 'Last-Modified': uploaded.toUTCString() } });
            };
            const response = await serveFile(f.context({ method: 'HEAD', headers: { Range: 'bytes=2-5', 'If-Range': '"old"', 'If-None-Match': '"old"', Cookie: 'browser-cookie=secret', Authorization: 'Bearer browser-secret' } }));
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Content-Length'), '777');
            assert.equal(response.headers.get('ETag'), '"upstream-version"');
            assert.equal(await response.text(), '');
            assert.equal(requests.length, 1);
            assert.equal(requests[0].method, 'HEAD');
            const forwarded = new Headers(requests[0].headers);
            assert.equal(forwarded.get('Range'), null);
            assert.equal(forwarded.get('If-Range'), null);
            assert.equal(forwarded.get('If-None-Match'), '"old"');
            assert.equal(forwarded.get('Cookie'), null);
            assert.notEqual(forwarded.get('Authorization'), 'Bearer browser-secret');
        });
    }

    function privateHuggingFaceFixture() {
        const name = 'fixture-private-hf';
        return fixture({
            channel: 'HuggingFace',
            metadata: { ChannelName: name, HfRepo: 'fixture/documents', HfIsPrivate: true, HfFilePath: 'document.pdf' },
            uploadConfig: { huggingface: { channels: [{ name, repo: 'fixture/documents', isPrivate: true, token: 'fixture-hf-token' }] } },
        });
    }

    for (const method of ['GET', 'HEAD']) {
        it(`follows a private HuggingFace ${method} redirect without leaking its token to the CDN`, async () => {
            const f = privateHuggingFaceFixture();
            const requests = [];
            const cancelled = [];
            globalThis.fetch = async (input, options) => {
                requests.push({ url: new URL(input), method: options.method, headers: new Headers(options.headers), redirect: options.redirect });
                if (requests.length === 1) {
                    const body = method === 'HEAD' ? null : new ReadableStream({
                        start(controller) { controller.enqueue(new Uint8Array([1])); },
                        cancel() { cancelled.push('hub'); },
                    });
                    return new Response(body, { status: 307, headers: { Location: 'https://cdn.example/document.pdf?signed=fixture' } });
                }
                return method === 'HEAD'
                    ? new Response(null, { headers: { 'Content-Length': '10', ETag: '"cdn-version"' } })
                    : new Response(bytes.slice(2, 6), { status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10', ETag: '"cdn-version"' } });
            };
            const response = await serveFile(f.context({ method, headers: {
                Range: 'bytes=2-5', 'If-Range': '"cdn-version"', 'If-None-Match': '"old-version"',
                Cookie: 'browser-cookie=secret', 'Proxy-Authorization': 'Bearer browser-proxy-secret',
            } }));
            assert.equal(response.status, method === 'HEAD' ? 200 : 206);
            assert.equal(await response.text(), method === 'HEAD' ? '' : '2345');
            assert.equal(requests.length, 2);
            assert.equal(requests[0].headers.get('Authorization'), 'Bearer fixture-hf-token');
            assert.equal(requests[1].headers.get('Authorization'), null);
            for (const request of requests) {
                assert.equal(request.method, method);
                assert.equal(request.redirect, 'manual');
                assert.equal(request.headers.get('Cookie'), null);
                assert.equal(request.headers.get('Proxy-Authorization'), null);
                assert.equal(request.headers.get('Range'), method === 'GET' ? 'bytes=2-5' : null);
                assert.equal(request.headers.get('If-Range'), method === 'GET' ? '"cdn-version"' : null);
                assert.equal(request.headers.get('If-None-Match'), '"old-version"');
            }
            assert.equal(requests[1].url.hostname, 'cdn.example');
            if (method === 'GET') assert.deepEqual(cancelled, ['hub']);
        });
    }

    it('retains private HuggingFace authorization only across same-origin redirects', async () => {
        const f = privateHuggingFaceFixture();
        const requests = [];
        globalThis.fetch = async (input, options) => {
            requests.push({ url: new URL(input), headers: new Headers(options.headers) });
            if (requests.length === 1) return new Response(null, { status: 302, headers: { Location: '/datasets/fixture/documents/resolve/main/document.pdf?next=1' } });
            if (requests.length === 2) return new Response(null, { status: 303, headers: { Location: 'https://cdn.example/document.pdf' } });
            return new Response(bytes);
        };
        const response = await serveFile(f.context());
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        assert.equal(requests.length, 3);
        assert.equal(requests[1].url.hostname, 'huggingface.co');
        assert.equal(requests[0].headers.get('Authorization'), 'Bearer fixture-hf-token');
        assert.equal(requests[1].headers.get('Authorization'), 'Bearer fixture-hf-token');
        assert.equal(requests[2].headers.get('Authorization'), null);
    });

    for (const target of ['http://cdn.example/document.pdf', 'https://user:password@cdn.example/document.pdf', 'https://127.0.0.1/private', 'https://[::ffff:127.0.0.1]/private', 'javascript:alert(1)', 'https://']) {
        it(`rejects an unsafe HuggingFace redirect without making its next request: ${target}`, async () => {
            const f = privateHuggingFaceFixture();
            let requests = 0;
            let cancelled = false;
            globalThis.fetch = async () => {
                requests++;
                return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { Location: target } });
            };
            const response = await serveFile(f.context());
            assert.equal(response.status, 502);
            assert.match(response.headers.get('Cache-Control'), /no-store/);
            assert.equal(requests, 1);
            assert.equal(cancelled, true);
        });
    }

    it('bounds HuggingFace redirect loops and cancels every intermediate response', async () => {
        const f = privateHuggingFaceFixture();
        let requests = 0;
        let cancelled = 0;
        globalThis.fetch = async (_input, options) => {
            requests++;
            assert.equal(options.redirect, 'manual');
            return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 308, headers: { Location: '/redirect-loop' } });
        };
        const response = await serveFile(f.context());
        assert.equal(response.status, 502);
        assert.equal(requests, 6);
        assert.equal(cancelled, 6);
    });

    it('rejects a HuggingFace redirect without a Location rather than exposing its body', async () => {
        const f = privateHuggingFaceFixture();
        globalThis.fetch = async () => new Response('upstream-private-detail', { status: 302 });
        const response = await serveFile(f.context());
        assert.equal(response.status, 502);
        assert.doesNotMatch(await response.text(), /upstream-private-detail/);
    });

    it('passes Range and If-Range to authenticated WebDAV and preserves its 416', async () => {
        const name = 'fixture-channel';
        const f = fixture({ channel: 'WebDAV', uploadConfig: { webdav: { channels: [{ name, baseUrl: 'https://dav.example', username: 'fixture-user', password: 'fixture-password' }] } }, metadata: { ChannelName: name, WebDAVFilePath: 'document.pdf' } });
        globalThis.fetch = async (_url, options) => {
            const headers = new Headers(options.headers);
            assert.equal(headers.get('Range'), 'bytes=50-');
            assert.equal(headers.get('If-Range'), '"version-1"');
            assert.match(headers.get('Authorization'), /^Basic /);
            return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */10' } });
        };
        const response = await serveFile(f.context({ headers: { Range: 'bytes=50-', 'If-Range': '"version-1"' } }));
        assert.equal(response.status, 416);
        assert.equal(response.headers.get('Content-Range'), 'bytes */10');
        assert.match(response.headers.get('Cache-Control'), /no-store/);
    });

    it('does not mislabel an ignored upstream Range as partial content', async () => {
        const f = fixture({ channel: 'Telegraph' });
        globalThis.fetch = async (_url, options) => {
            assert.equal(new Headers(options.headers).get('If-Range'), '"old"');
            return new Response(bytes, { headers: { 'Content-Length': '10' } });
        };
        const response = await serveFile(f.context({ headers: { Range: 'bytes=2-5', 'If-Range': '"old"' } }));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Range'), null);
        assert.equal(await response.text(), '0123456789');
    });

    it('rejects malformed upstream partial responses instead of corrupting PDF ranges', async () => {
        const f = fixture({ channel: 'Telegraph' });
        globalThis.fetch = async () => new Response(bytes, { status: 206, headers: { 'Content-Range': 'bytes 5-4/10' } });
        const response = await serveFile(f.context({ headers: { Range: 'bytes=2-5' } }));
        assert.equal(response.status, 502);
    });

    it('returns 304 with preview/CORS headers intact for an upstream validator', async () => {
        const f = fixture({ channel: 'Telegraph' });
        globalThis.fetch = async () => new Response(null, { status: 304, headers: { ETag: '"upstream-version"' } });
        const response = await serveFile(f.context({ headers: { 'If-None-Match': '"upstream-version"' } }));
        assert.equal(response.status, 304);
        assert.equal(response.headers.get('Content-Type'), 'application/pdf');
        assert.match(response.headers.get('Access-Control-Expose-Headers'), /Content-Range/);
        assert.equal(response.headers.get('ETag'), '"upstream-version"');
        assert.equal(await response.text(), '');
    });

    function telegramChunks(f, count) {
        f.env.TG_BOT_TOKEN = 'fixture-bot';
        const record = f.records.get('document.pdf');
        record.metadata.Channel = 'TelegramNew';
        record.metadata.ChannelName = 'Telegram_env';
        record.metadata.IsChunked = true;
        record.metadata.TotalChunks = count;
        record.metadata.TimeStamp = 123;
        record.value = JSON.stringify(Array.from({ length: count }, (_, index) => ({ index, size: 4, fileId: `chunk-${index}` })));
        const downloads = [];
        globalThis.fetch = async input => {
            const url = new URL(input);
            if (url.pathname.endsWith('/getFile')) {
                return new Response(JSON.stringify({ ok: true, result: { file_path: url.searchParams.get('file_id') } }));
            }
            downloads.push(url.pathname.split('/').pop());
            return new Response(new TextEncoder().encode('abcd'));
        };
        return downloads;
    }

    it('supports suffix ranges and If-Range across Telegram chunk boundaries', async () => {
        const f = fixture();
        const downloads = telegramChunks(f, 2);
        const partial = await serveFile(f.context({ headers: { Range: 'bytes=-5', 'If-Range': '"123-8"' } }));
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get('Content-Range'), 'bytes 3-7/8');
        assert.equal(await partial.text(), 'dabcd');
        assert.deepEqual(downloads, ['chunk-0', 'chunk-1']);
        const complete = await serveFile(f.context({ headers: { Range: 'bytes=-5', 'If-Range': '"different"' } }));
        assert.equal(complete.status, 200);
        assert.equal(await complete.text(), 'abcdabcd');
    });

    for (const headers of [
        { 'If-Match': '"different"' },
        { 'If-Match': 'W/"123-8"' },
        { 'If-Unmodified-Since': 'Wed, 31 Dec 1969 23:59:59 GMT' },
        { 'If-Match': '"different"', 'If-None-Match': '"123-8"' },
    ]) {
        it(`returns 412 without fetching chunks for failed preconditions: ${JSON.stringify(headers)}`, async () => {
            const f = fixture();
            const downloads = telegramChunks(f, 2);
            const response = await serveFile(f.context({ headers: { ...headers, Range: 'bytes=2-5' } }));
            assert.equal(response.status, 412);
            assert.equal(response.headers.get('Content-Length'), '0');
            assert.match(response.headers.get('Cache-Control'), /no-store/);
            assert.deepEqual(downloads, []);
        });
    }

    it('gives If-Match precedence over If-Unmodified-Since for chunked documents', async () => {
        const f = fixture();
        telegramChunks(f, 2);
        const response = await serveFile(f.context({ headers: {
            Range: 'bytes=2-5', 'If-Match': '"123-8"', 'If-Unmodified-Since': 'Wed, 31 Dec 1969 23:59:59 GMT',
        } }));
        assert.equal(response.status, 206);
        assert.equal(await response.text(), 'cdab');
    });

    it('does not prefetch an entire reconstructed file for a stalled or cancelled client', async () => {
        const f = fixture();
        const downloads = telegramChunks(f, 100);
        const response = await serveFile(f.context());
        await new Promise(setImmediate);
        assert.ok(downloads.length <= 2, `prefetched ${downloads.length} chunks without a consumer`);
        await response.body.cancel();
        const count = downloads.length;
        await new Promise(setImmediate);
        assert.equal(downloads.length, count);
    });

    it('rejects duplicate indices or oversized historical chunk manifests before fetching', async () => {
        const f = fixture();
        const downloads = telegramChunks(f, 2);
        const record = f.records.get('document.pdf');
        record.value = JSON.stringify([{ index: 0, size: 4 }, { index: 0, size: 4 }]);
        assert.equal((await serveFile(f.context())).status, 500);
        record.value = JSON.stringify([{ index: 0, size: 33 * 1024 * 1024 }, { index: 1, size: 4 }]);
        assert.equal((await serveFile(f.context())).status, 500);
        assert.deepEqual(downloads, []);
    });

    it('does not forward local preview parameters or authCode to Telegraph', async () => {
        const f = fixture({ channel: 'Telegraph' });
        globalThis.fetch = async input => {
            const url = new URL(input);
            for (const name of ['preview', 'download', 'disposition', 'from', 'authCode']) assert.equal(url.searchParams.has(name), false);
            assert.equal(url.searchParams.get('width'), '200');
            return new Response(bytes);
        };
        const response = await serveFile(f.context({ search: '?preview=1&from=admin&authCode=local-secret&width=200' }));
        await response.arrayBuffer();
    });

    for (const externalLink of ['http://127.0.0.1/private', 'https://user:password@example.com/document.pdf', 'javascript:alert(1)']) {
        it(`rejects unsafe historical external links: ${externalLink}`, async () => {
            const f = fixture({ channel: 'External', metadata: { ExternalLink: externalLink } });
            assert.equal((await serveFile(f.context())).status, 400);
        });
    }

    it('honors the optional external host allowlist for historical redirects', async () => {
        const f = fixture({ channel: 'External', metadata: { ExternalLink: 'https://docs.example/document.pdf' }, vars: { EXTERNAL_ALLOWED_HOSTS: 'docs.example' } });
        const response = await serveFile(f.context());
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('Location'), 'https://docs.example/document.pdf');
        f.env.EXTERNAL_ALLOWED_HOSTS = 'different.example';
        assert.equal((await serveFile(f.context())).status, 400);
    });
});

describe('S3 document read commands', () => {
    const source = fs.readFileSync('functions/file/[[path]].js', 'utf8');
    function handler(onCommand) {
        class GetObjectCommand { constructor(input) { this.input = input; } }
        class HeadObjectCommand { constructor(input) { this.input = input; } }
        const dependencies = {
            ...fileTools,
            GetObjectCommand,
            HeadObjectCommand,
            S3Client: class { async send(command) { return onCommand(command); } },
            getDatabase: () => ({}),
            resolveS3Credentials: async () => ({ endpoint: 'https://s3.example', bucketName: 'fixture-bucket', key: 'document.pdf' }),
            createServerErrorResponse,
        };
        const executable = source.slice(source.indexOf('export async function onRequest')).replace('export async function onRequest', 'async function onRequest');
        const names = Object.keys(dependencies);
        const helpers = new Function(...names, `${executable}\nreturn { handleS3FileViaAPI, readChunkBytes };`)(...names.map(name => dependencies[name]));
        return { compiled: helpers.handleS3FileViaAPI, readChunkBytes: helpers.readChunkBytes, GetObjectCommand, HeadObjectCommand };
    }
    it('uses HeadObjectCommand rather than opening GetObject streams on HEAD', async () => {
        let commands = 0;
        const h = handler(command => {
            assert.ok(command instanceof h.HeadObjectCommand);
            assert.equal(command.input.Range, undefined);
            commands++;
            return { ContentLength: 123, ETag: '"version-1"' };
        });
        const context = { request: new Request('https://img.example/file/document.pdf', { method: 'HEAD', headers: { Range: 'bytes=2-5' } }), env: {} };
        const response = await h.compiled(context, { FileSizeBytes: 10 }, 'document.pdf', 'application/pdf');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Length'), '123');
        assert.equal(await response.text(), '');
        assert.equal(commands, 1);
    });
    it('maps S3 InvalidRange to 416 rather than an internal server error', async () => {
        const h = handler(() => { throw { $metadata: { httpStatusCode: 416 } }; });
        const context = { request: new Request('https://img.example/file/document.pdf', { headers: { Range: 'bytes=50-' } }), env: {} };
        const response = await h.compiled(context, { FileSizeBytes: 10 }, 'document.pdf', 'application/pdf');
        assert.equal(response.status, 416);
        assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    });

    it('stops reading an oversized upstream chunk instead of buffering it whole', async () => {
        const h = handler(() => {});
        let cancelled = false;
        const stream = new ReadableStream({
            pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
            cancel() { cancelled = true; },
        });
        await assert.rejects(h.readChunkBytes(new Response(stream), 4), /exceeds 4 bytes/);
        assert.equal(cancelled, true);
    });

    it('rejects a truncated upstream chunk before appending it to the reconstructed file', async () => {
        const h = handler(() => {});
        await assert.rejects(h.readChunkBytes(new Response(new Uint8Array([1, 2])), 4), /expected 4, got 2/);
    });
});
