import assert from 'node:assert/strict';
import { createJsonResponse, createTextResponse, createNoStoreTextResponse, createServerErrorResponse } from '../functions/utils/response.js';

describe('response helpers', () => {
    for (const [label, headers] of [
        ['object', { 'X-Test': 'yes' }],
        ['Headers', new Headers({ 'X-Test': 'yes' })],
        ['tuples', [['X-Test', 'yes']]],
    ]) {
        it('preserves ' + label + ' headers', async () => {
            const json = createJsonResponse({ ok: true }, { status: 201, headers });
            assert.equal(json.status, 201);
            assert.equal(json.headers.get('x-test'), 'yes');
            assert.equal(json.headers.get('content-type'), 'application/json');
            assert.deepEqual(await json.json(), { ok: true });
            assert.equal(createTextResponse('ok', { headers }).headers.get('x-test'), 'yes');
            assert.equal(createNoStoreTextResponse('ok', 200, 'OK', headers).headers.get('x-test'), 'yes');
        });
    }
    it('computes Content-Length in UTF-8 bytes, not UTF-16 characters', async () => {
        const body = '\u4e2d\u6587\ud83d\ude80';
        const response = createNoStoreTextResponse(body, 200, 'OK');
        assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body)));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(await response.text(), body);
    });
    it('overrides default headers case-insensitively', () => {
        const response = createJsonResponse({}, { headers: { 'content-type': 'application/problem+json' } });
        assert.equal(response.headers.get('content-type'), 'application/problem+json');
    });
    it('redacts production errors and retains supplied Headers', async () => {
        const original = console.error;
        console.error = () => {};
        try {
            const response = createServerErrorResponse({}, new Error('secret'), { headers: new Headers({ 'X-Test': 'yes' }) });
            assert.equal(response.status, 500);
            assert.equal(response.headers.get('x-test'), 'yes');
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const payload = await response.json();
            assert.ok(payload.requestId);
            assert.equal(payload.message, undefined);
        } finally { console.error = original; }
    });
});
