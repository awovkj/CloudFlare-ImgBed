import assert from 'node:assert/strict';
import { getUploadConfig, onRequest } from '../functions/api/manage/sysConfig/upload.js';

function binding(token, repo) {
    let raw = JSON.stringify({ huggingface: { channels: [{ name: 'documents', enabled: true, token, repo }] } });
    let reads = 0;
    return {
        async get() { reads++; return raw; },
        async put(_key, value) { raw = value; },
        get reads() { return reads; },
    };
}

describe('upload configuration cache isolation', () => {
    it('never shares storage credentials between different database bindings', async () => {
        const a = binding('fixture-a', 'fixtures/a');
        const b = binding('fixture-b', 'fixtures/b');
        const first = await getUploadConfig(a, {});
        const second = await getUploadConfig(b, {});
        assert.equal(first.huggingface.channels[0].token, 'fixture-a');
        assert.equal(second.huggingface.channels[0].token, 'fixture-b');
        assert.equal(second.huggingface.channels[0].repo, 'fixtures/b');
        await getUploadConfig(a, {});
        assert.equal(a.reads, 1);
        assert.equal(b.reads, 1);
    });

    it('rebuilds objects so request-local filtering cannot mutate cached configuration', async () => {
        const db = binding('fixture-token', 'fixtures/documents');
        const first = await getUploadConfig(db, {});
        first.huggingface.channels[0].token = 'changed';
        first.huggingface.channels = [];
        const second = await getUploadConfig(db, {});
        assert.equal(second.huggingface.channels[0].token, 'fixture-token');
        assert.equal(db.reads, 1);
    });

    it('invalidates only the changed binding immediately after configuration writes', async () => {
        const db = binding('fixture-old', 'fixtures/documents');
        const env = { img_url: db };
        const get = () => onRequest({ env, request: new Request('https://img.example/api/manage/sysConfig/upload') });
        assert.equal((await (await get()).json()).huggingface.channels[0].token, 'fixture-old');
        await onRequest({ env, request: new Request('https://img.example/api/manage/sysConfig/upload', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ huggingface: { channels: [{ name: 'documents', token: 'fixture-new', repo: 'fixtures/documents', enabled: true }] } }),
        }) });
        assert.equal((await (await get()).json()).huggingface.channels[0].token, 'fixture-new');
        assert.equal(db.reads, 2);
    });
});
