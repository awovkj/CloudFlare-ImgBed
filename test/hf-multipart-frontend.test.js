import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { patchHfMultipartCommit, redactHfUploadInfo } from '../scripts/patch-hf-multipart-completion.mjs';

const oldExpression = 'n.length>0&&(r.multipartParts=n,r.uploadAction=i.uploadAction);';
const newExpression = 'n.length>0&&(r.multipartParts=n);';

describe('bounded HF multipart frontend commit metadata', () => {
    it('patches only the commit replay and remains deterministic and idempotent', () => {
        const before = 'start;' + oldExpression + 'end;';
        const after = 'start;' + newExpression + 'end;';
        assert.equal(patchHfMultipartCommit(before), after);
        assert.equal(patchHfMultipartCommit(after), after);
        for (const unsupported of ['', oldExpression + oldExpression, newExpression + oldExpression]) {
            assert.throws(() => patchHfMultipartCommit(unsupported), /exactly one supported/);
        }
    });

    it('sends every completed part without replaying thousands of signed upload URLs', () => {
        const bundle = fs.readFileSync('js/274.9b7364f3.js', 'utf8');
        assert.ok(bundle.includes(newExpression));
        assert.equal(bundle.includes(oldExpression), false);
        const parts = Array.from({ length: 10000 }, (_, i) => ({ partNumber: i + 1, etag: 'a'.repeat(128) }));
        const issued = { uploadAction: { href: 'https://img.example/upload/huggingface/completeMultipart',
            header: { chunk_size: String(5 * 1024 * 1024), '1': 'https://storage.example/part?secret=signed-capability' } } };
        const commit = new Function('n', 'i', 'r', newExpression + 'return r;');
        const payload = commit(parts, issued, { fullId: 'issued-report.pdf', sha256: 'b'.repeat(64), fileSize: 1024 ** 4,
            fileName: 'report.pdf', fileType: 'application/pdf', channelName: 'hf-channel' });
        assert.equal(payload.multipartParts, parts);
        assert.equal(payload.fileSize, 1024 ** 4);
        assert.equal(Object.hasOwn(payload, 'uploadAction'), false);
        const json = JSON.stringify(payload);
        assert.doesNotMatch(json, /signed-capability|storage\.example/);
        assert.ok(Buffer.byteLength(json) < 2 * 1024 * 1024);
        const basic = commit([], issued, { fullId: 'basic.pdf' });
        assert.equal(Object.hasOwn(basic, 'multipartParts'), false);
    });

    it('applies the maintained patch on every asset build and leaves the checked-in bundle unchanged', () => {
        assert.match(fs.readFileSync('scripts/copy-assets.mjs', 'utf8'), /patch-hf-multipart-completion\.mjs/);
        const before = fs.readFileSync('js/274.9b7364f3.js', 'utf8');
        execFileSync(process.execPath, ['scripts/patch-hf-multipart-completion.mjs'], { stdio: 'pipe' });
        assert.equal(fs.readFileSync('js/274.9b7364f3.js', 'utf8'), before);
    });

    it('logs only the transfer mode instead of exposing signed part URLs or completion capabilities', () => {
        const oldLog = 'console.log("Upload info:",i)';
        const patched = redactHfUploadInfo(oldLog);
        assert.equal(redactHfUploadInfo(patched), patched);
        assert.throws(() => redactHfUploadInfo(oldLog + oldLog), /exactly one supported/);
        const calls = [];
        const log = new Function('i', 'console', patched);
        log({ uploadAction: { href: 'https://provider.example/?secret=private-capability', header: { chunk_size: '5242880' } } },
            { log(...args) { calls.push(args); } });
        assert.deepEqual(calls, [['LFS upload mode:', 'multipart']]);
        assert.equal(fs.readFileSync('js/274.9b7364f3.js', 'utf8').includes(oldLog), false);
    });
});
