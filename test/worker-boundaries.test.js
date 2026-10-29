import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { UploadDurableObject } from '../src/uploadDurableObject.js';
import { forwardToUploadDO } from '../src/uploadDispatcher.js';
import {
    createSerialExecutor, extractRouteUploadId, extractUploadId, getUploadRequestMethodRejection,
    MAX_MERGE_FORM_DATA_BYTES, resolveUploadDurableObject,
} from '../src/uploadRequestRouting.js';
import { enforceRequestBodyLimit, MAX_METADATA_BODY_BYTES } from '../src/requestBodyPolicy.js';
import { MAX_HF_COMPLETION_BODY_BYTES } from '../functions/upload/huggingface/multipartProtocol.js';
import {
    applyCorsToResponse, appendVary, buildCorsHeaders, buildPreflightResponse,
    getCorsRequestRejection, FILE_EXPOSED_HEADERS,
} from '../functions/utils/cors.js';
import { isRequestBodyTooLargeError, limitRequestBody } from '../functions/utils/requestLimits.js';
import { buildGeneratedOptionsResponse, getOnly, postOnly } from '../src/pagesAdapter.js';

const ORIGIN = 'https://img.example';
const UI_ORIGIN = 'https://documents.example';
const tick = () => new Promise(resolve => setImmediate(resolve));
const encoder = new TextEncoder();

function makeEnv(initial = {}) {
    const entries = new Map(Object.entries(initial));
    const calls = { get: 0, put: 0 };
    const img_url = {
        async get(key) { calls.get++; return entries.get(key) ?? null; },
        async getWithMetadata() { return { value: null, metadata: null }; },
        async put(key, value) { calls.put++; entries.set(key, value); },
        async delete(key) { entries.delete(key); },
        async list({ prefix = '' } = {}) {
            return { list_complete: true, keys: [...entries.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })) };
        },
    };
    return { env: { img_url }, entries, calls };
}

function streamedRequest(path, chunks, headers = {}) {
    const state = { cancelled: false, pulled: 0 };
    let index = 0;
    const body = new ReadableStream({
        pull(controller) {
            state.pulled++;
            if (index < chunks.length) controller.enqueue(typeof chunks[index] === 'string' ? encoder.encode(chunks[index++]) : chunks[index++]);
            else controller.close();
        },
        cancel() { state.cancelled = true; },
    });
    return { request: new Request(ORIGIN + path, { method: 'POST', headers, body, duplex: 'half' }), state };
}

const runtimeContext = () => ({ waitUntil() {}, passThroughOnException() {} });

describe('exact-origin Worker CORS boundaries', () => {
    it('keeps wildcard compatibility credential-free even when the credential toggle is set', () => {
        const request = new Request(ORIGIN + '/api/check', { headers: { Origin: UI_ORIGIN } });
        const headers = buildCorsHeaders({ request, env: { CORS_ALLOW_CREDENTIALS: 'true' } });
        assert.equal(headers['Access-Control-Allow-Origin'], '*');
        assert.equal(headers['Access-Control-Allow-Credentials'], undefined);
    });

    it('reflects only an exact configured origin and preserves cache variation', () => {
        const request = new Request(ORIGIN + '/api/check', { headers: { Origin: UI_ORIGIN } });
        const env = { CORS_ALLOWED_ORIGINS: UI_ORIGIN, CORS_ALLOW_CREDENTIALS: 'true' };
        const response = applyCorsToResponse(new Response('data', { headers: { Vary: 'Accept-Encoding, Cookie', 'Access-Control-Allow-Origin': '*' } }), request, env);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), UI_ORIGIN);
        assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
        assert.equal(response.headers.get('Vary'), 'Accept-Encoding, Cookie, Origin');
    });

    it('does not accept null origins, suffix matches, or invalid allowlist entries', () => {
        const env = { CORS_ALLOWED_ORIGINS: `${UI_ORIGIN}, *, https://user:password@documents.example, ${UI_ORIGIN}/private` };
        for (const origin of ['null', 'https://documents.example.attacker.example', 'https://other.example']) {
            const request = new Request(ORIGIN + '/file/a.pdf', { headers: { Origin: origin } });
            assert.equal(getCorsRequestRejection(request, env).status, 403);
            assert.equal(buildCorsHeaders({ request, env })['Access-Control-Allow-Origin'], undefined);
        }
    });

    it('keeps same-origin requests and clients without Origin usable under an allowlist', () => {
        const env = { CORS_ALLOWED_ORIGINS: UI_ORIGIN };
        assert.equal(getCorsRequestRejection(new Request(ORIGIN + '/api/check', { headers: { Origin: ORIGIN } }), env), null);
        const response = applyCorsToResponse(new Response('data'), new Request(ORIGIN + '/file/a.pdf'), env);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
        assert.equal(response.headers.get('Vary'), 'Origin');
    });

    it('normalizes legacy permissions for file HEAD without changing entity headers', () => {
        const request = new Request(ORIGIN + '/file/a.pdf', { method: 'HEAD', headers: { Origin: UI_ORIGIN } });
        const response = applyCorsToResponse(new Response('must not be sent', {
            headers: { 'Content-Length': '99', 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 0-98/100',
                ETag: '"v1"', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Cookie',
                'Access-Control-Allow-Credentials': 'true' },
        }), request, { CORS_ALLOWED_ORIGINS: UI_ORIGIN });
        assert.equal(response.body, null);
        assert.equal(response.headers.get('Content-Length'), '99');
        assert.equal(response.headers.get('Content-Range'), 'bytes 0-98/100');
        assert.equal(response.headers.get('ETag'), '"v1"');
        assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
        assert.match(response.headers.get('Access-Control-Allow-Headers'), /Range/);
        assert.equal(response.headers.get('Access-Control-Expose-Headers'), FILE_EXPOSED_HEADERS);
        assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
    });

    it('preserves streaming bytes and multiple Set-Cookie fields when wrapping', async () => {
        const headers = new Headers({ Vary: '*' });
        headers.append('Set-Cookie', 'a=one; HttpOnly');
        headers.append('Set-Cookie', 'b=two; HttpOnly');
        const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('streamed')); controller.close(); } });
        const response = applyCorsToResponse(new Response(body, { status: 206, headers }), new Request(ORIGIN + '/file/a.pdf'), { CORS_ALLOWED_ORIGINS: UI_ORIGIN });
        assert.equal(response.status, 206);
        assert.deepEqual(response.headers.getSetCookie(), ['a=one; HttpOnly', 'b=two; HttpOnly']);
        assert.equal(response.headers.get('Vary'), '*');
        assert.equal(await response.text(), 'streamed');
    });

    it('adds Origin only once and respects a wildcard Vary', () => {
        const headers = new Headers({ Vary: 'Accept-Encoding, origin' });
        appendVary(headers, 'Origin');
        assert.equal(headers.get('Vary'), 'Accept-Encoding, origin');
        headers.set('Vary', '*');
        appendVary(headers, 'Origin');
        assert.equal(headers.get('Vary'), '*');
    });

    it('rejects disallowed preflight origins before reading the body', () => {
        const request = new Request(ORIGIN + '/upload', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
        assert.equal(buildPreflightResponse({ request, env: { CORS_ALLOWED_ORIGINS: UI_ORIGIN } }).status, 403);
        assert.equal(request.bodyUsed, false);
    });

    it('serves PDF range preflight without database or Durable Object bindings', async () => {
        const response = await worker.fetch(new Request(ORIGIN + '/file/a.pdf', {
            method: 'OPTIONS', headers: { Origin: UI_ORIGIN, 'Access-Control-Request-Method': 'HEAD', 'Access-Control-Request-Headers': 'Range, Authorization' },
        }), { CORS_ALLOWED_ORIGINS: UI_ORIGIN, CORS_ALLOW_CREDENTIALS: 'true' }, runtimeContext());
        assert.equal(response.status, 204);
        assert.equal(response.body, null);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), UI_ORIGIN);
        assert.match(response.headers.get('Access-Control-Allow-Methods'), /HEAD/);
        assert.match(response.headers.get('Access-Control-Allow-Headers'), /Range/);
    });

    it('rejects cross-origin writes before authentication/storage and emits no body on HEAD denial', async () => {
        const { env, calls } = makeEnv();
        env.CORS_ALLOWED_ORIGINS = UI_ORIGIN;
        for (const method of ['POST', 'HEAD']) {
            const response = await worker.fetch(new Request(ORIGIN + '/upload', {
                method, headers: { Origin: 'https://evil.example' }, body: method === 'POST' ? 'do not parse' : undefined,
            }), env, runtimeContext());
            assert.equal(response.status, 403);
            if (method === 'HEAD') assert.equal(response.body, null);
        }
        assert.equal(calls.get, 0);
        assert.equal(calls.put, 0);
    });

    it('permits every supported file validator in cross-origin file and temporary-link preflights', async () => {
        const validators = ['Range', 'If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'];
        for (const pathname of ['/file/report.pdf', '/temp/private-token']) {
            const response = await worker.fetch(new Request(ORIGIN + pathname, {
                method: 'OPTIONS', headers: { Origin: UI_ORIGIN,
                    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': validators.join(', ') },
            }), { CORS_ALLOWED_ORIGINS: UI_ORIGIN }, runtimeContext());
            assert.equal(response.status, 204);
            const allowed = response.headers.get('Access-Control-Allow-Headers').toLowerCase().split(',').map(value => value.trim());
            for (const name of validators) assert.ok(allowed.includes(name.toLowerCase()), name);
        }
        const defaults = buildCorsHeaders()['Access-Control-Allow-Headers'].toLowerCase().split(',').map(value => value.trim());
        for (const name of validators) assert.ok(defaults.includes(name.toLowerCase()), name);
    });

    it('marks successful cookie-producing authentication responses as private/no-store', async () => {
        const { env } = makeEnv();
        env.CORS_ALLOWED_ORIGINS = UI_ORIGIN;
        env.CORS_ALLOW_CREDENTIALS = 'true';
        const response = await worker.fetch(new Request(ORIGIN + '/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: UI_ORIGIN }, body: '{}',
        }), env, runtimeContext());
        assert.equal(response.status, 200);
        assert.ok(response.headers.get('Set-Cookie'));
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    });

    it('preserves file HEAD length while using R2 head rather than opening an object stream', async () => {
        const { env } = makeEnv();
        env.img_url.getWithMetadata = async () => ({ value: '', metadata: {
            Channel: 'CloudflareR2', FileName: 'report.pdf', FileType: 'application/octet-stream', FileSizeBytes: 10,
            ListType: 'None', Label: 'None', TimeStamp: 1,
        } });
        let headCalls = 0;
        env.img_r2 = {
            async head() { headCalls++; return { size: 10, etag: 'v1', httpEtag: '"v1"', uploaded: new Date('2026-01-01'), writeHttpMetadata() {} }; },
            async get() { throw new Error('HEAD must not open an object body'); },
        };
        const response = await worker.fetch(new Request(ORIGIN + '/file/report.pdf', { method: 'HEAD' }), env, runtimeContext());
        assert.equal(response.status, 200);
        assert.equal(response.body, null);
        assert.equal(response.headers.get('Content-Length'), '10');
        assert.equal(response.headers.get('Content-Type'), 'application/pdf');
        assert.equal(headCalls, 1);
    });
});

describe('stream-counted request envelope limits', () => {
    it('counts actual bytes and cancels an over-limit stream without Content-Length', async () => {
        const { request, state } = streamedRequest('/upload', ['ab', 'cd', 'ef']);
        assert.equal(request.headers.has('Content-Length'), false);
        await assert.rejects(() => limitRequestBody(request, 3).text(), isRequestBodyTooLargeError);
        await tick();
        assert.equal(state.cancelled, true);
    });

    it('does not trust a smaller declared Content-Length', async () => {
        const { request } = streamedRequest('/upload', ['abcd'], { 'Content-Length': '1' });
        await assert.rejects(() => limitRequestBody(request, 3).arrayBuffer(), isRequestBodyTooLargeError);
    });

    it('rejects large or malformed declared lengths before consuming any body', () => {
        for (const length of ['4', '-1', 'NaN', 'Infinity', '']) {
            const request = new Request(ORIGIN + '/upload', { method: 'POST', headers: { 'Content-Length': length }, body: 'abc' });
            assert.throws(() => limitRequestBody(request, 3), isRequestBodyTooLargeError);
            assert.equal(request.bodyUsed, false);
        }
    });

    it('retains explicit control-body limits while passing ordinary/chunk upload requests through unchanged', async () => {
        assert.equal(await limitRequestBody(streamedRequest('/upload', ['abc']).request, 3).text(), 'abc');
        const env = { UPLOAD_MAX_SINGLE_BYTES: '8', UPLOAD_MAX_CHUNK_BYTES: '4', UPLOAD_MAX_TOTAL_BYTES: '100' };
        for (const path of ['/upload', '/upload?chunked=true', '/upload?chunked=true&uploadId=stable']) {
            const request = streamedRequest(path, [new Uint8Array(64 * 1024 + 32)], {
                'Content-Length': String(100 * 1024 ** 3), 'Content-Type': 'application/octet-stream',
            }).request;
            assert.equal(enforceRequestBodyLimit(request, env), request);
            assert.equal((await request.arrayBuffer()).byteLength, 64 * 1024 + 32);
        }
    });

    it('caps initialization, merge, HF metadata, and proxy JSON independently of file limits', async () => {
        for (const path of ['/upload?initChunked=true', '/upload?chunked=true&merge=true', '/upload/huggingface/getUploadUrl', '/api/huggingface/getUploadUrl']) {
            const request = streamedRequest(path, [new Uint8Array(MAX_METADATA_BODY_BYTES + 1)]).request;
            await assert.rejects(() => enforceRequestBodyLimit(request, {}).arrayBuffer(), isRequestBodyTooLargeError, path);
        }
        const proxy = streamedRequest('/api/fetchRes', [new Uint8Array(16 * 1024 + 1)]).request;
        await assert.rejects(() => enforceRequestBodyLimit(proxy, {}).arrayBuffer(), isRequestBodyTooLargeError);
    });

    it('gives HF multipart completion and commit a bounded schema budget instead of the small initialization budget', async () => {
        const body = JSON.stringify({ oid: 'a'.repeat(64), parts: Array.from({ length: 1500 }, (_, i) => ({
            partNumber: i + 1, etag: 'b'.repeat(32),
        })) });
        assert.ok(encoder.encode(body).byteLength > MAX_METADATA_BODY_BYTES);
        for (const path of ['/api/huggingface/commitUpload', '/upload/huggingface/commitUpload', '/upload/huggingface/completeMultipart']) {
            const request = streamedRequest(path, [body]).request;
            assert.equal(await enforceRequestBodyLimit(request, {}).text(), body);
            const oversized = streamedRequest(path, [new Uint8Array(MAX_HF_COMPLETION_BODY_BYTES + 1)]).request;
            await assert.rejects(() => enforceRequestBodyLimit(oversized, {}).arrayBuffer(), isRequestBodyTooLargeError, path);
        }
    });

    it('caps unauthenticated login metadata before JSON parsing', async () => {
        for (const path of ['/api/login', '/api/auth/login', '/api/auth/adminLogin', '/api/manage/login', '/api/music/login']) {
            const request = streamedRequest(path, [new Uint8Array(16 * 1024 + 1)]).request;
            await assert.rejects(() => enforceRequestBodyLimit(request, {}).arrayBuffer(), isRequestBodyTooLargeError, path);
        }
    });

    it('returns 413 rather than malformed-JSON 400 when login streams cross their cap', async () => {
        const { env } = makeEnv({
            'manage@sysConfig@others': JSON.stringify({ musicPlayer: { enabled: true, passwordHash: 'test-password' } }),
        });
        for (const path of ['/api/login', '/api/auth/login', '/api/auth/adminLogin', '/api/music/login']) {
            const request = new Request(ORIGIN + path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ authCode: 'x'.repeat(17 * 1024), password: 'test-password' }),
            });
            assert.equal(request.headers.get('Content-Length'), null);
            const response = await worker.fetch(request, env, runtimeContext());
            assert.equal(response.status, 413, path);
            assert.equal((await response.json()).code, 'REQUEST_BODY_TOO_LARGE');
        }
    });

    it('still bounds initialization metadata at both Worker and DO entry points', async () => {
        const { env } = makeEnv();
        env.UPLOAD_MAX_SINGLE_BYTES = '8';
        const body = new FormData();
        body.append('originalFileName', 'x'.repeat(MAX_METADATA_BODY_BYTES + 1));
        const path = ORIGIN + '/upload?initChunked=true';
        const response = await worker.fetch(new Request(path, { method: 'POST', body }), env, runtimeContext());
        assert.equal(response.status, 413);
        const durable = new UploadDurableObject(runtimeContext(), env);
        const second = await durable.fetch(new Request(path, { method: 'POST', body }));
        assert.equal(second.status, 413);
    });

    it('accepts real ordinary R2 form uploads at Worker and DO boundaries despite obsolete size/type limits', async () => {
        const { env } = makeEnv();
        Object.assign(env, { UPLOAD_MAX_SINGLE_BYTES: '1', UPLOAD_MAX_TOTAL_BYTES: '1', UPLOAD_MAX_CHUNK_BYTES: '1',
            UPLOAD_ALLOWED_EXTENSIONS: 'png', UPLOAD_ALLOWED_MIME_TYPES: 'image/png' });
        const pending = [];
        const runtime = { waitUntil(promise) { pending.push(promise); }, passThroughOnException() {} };
        let stored = 0;
        env.img_r2 = { async put(_key, file) { stored++; assert.equal(file.size, 64 * 1024 + 32); } };
        const body = new FormData();
        body.append('file', new Blob([new Uint8Array(64 * 1024 + 32)], { type: 'application/x-custom' }), 'application.exe');
        const path = ORIGIN + '/upload?uploadChannel=cfr2';
        const first = await worker.fetch(new Request(path, { method: 'POST', body }), env, runtime);
        assert.equal(first.status, 200);
        const durable = new UploadDurableObject(runtime, env);
        const second = await durable.fetch(new Request(path, { method: 'POST', body }));
        assert.equal(second.status, 200);
        assert.equal(stored, 2);
        await Promise.all(pending);
    });
});

describe('upload routing without body replay', () => {
    it('extracts query/header upload identifiers without parsing or cloning file bodies', async () => {
        for (const headers of [{ 'X-Upload-Id': 'upload-stable' }, {}]) {
            const path = headers['X-Upload-Id'] ? '/upload?chunked=true' : '/upload?chunked=true&uploadId=upload-stable';
            const request = new Request(ORIGIN + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=none' }, body: 'not a multipart form' });
            assert.equal(await extractUploadId(request), 'upload-stable');
            assert.equal(request.bodyUsed, false);
            assert.equal(await request.text(), 'not a multipart form');
        }
        const legacy = new Request(ORIGIN + '/upload?chunked=true', { method: 'POST', body: 'large legacy chunk' });
        assert.equal(await extractUploadId(legacy), null);
        assert.equal(legacy.bodyUsed, false);
    });

    it('parses only bounded merge metadata and preserves the original body for the DO', async () => {
        const body = new FormData();
        body.append('uploadId', 'upload-stable');
        body.append('totalChunks', '2');
        const request = new Request(ORIGIN + '/upload?chunked=true&merge=true', { method: 'POST', body });
        assert.equal(await extractUploadId(request), 'upload-stable');
        assert.equal(request.bodyUsed, false);
        assert.equal((await request.formData()).get('uploadId'), 'upload-stable');
    });

    it('rejects disagreeing route/header/body upload identities without dispatching', async () => {
        const queryMismatch = new Request(ORIGIN + '/upload?uploadId=one', { headers: { 'X-Upload-Id': 'two' } });
        assert.throws(() => extractRouteUploadId(queryMismatch), error => error.code === 'ROUTE_UPLOAD_ID_MISMATCH');
        const body = new FormData();
        body.append('uploadId', 'two');
        const request = new Request(ORIGIN + '/upload?merge=true&uploadId=one', { method: 'POST', body });
        await assert.rejects(() => extractUploadId(request), error => error.code === 'ROUTE_UPLOAD_ID_MISMATCH');
    });

    it('rejects oversized merge metadata with no declared length', async () => {
        const body = new FormData();
        body.append('uploadId', 'upload-stable');
        body.append('file', new Blob([new Uint8Array(MAX_MERGE_FORM_DATA_BYTES + 1)]), 'must-not-be-merged.bin');
        const request = new Request(ORIGIN + '/upload?merge=true', { method: 'POST', body });
        assert.equal(request.headers.has('Content-Length'), false);
        await assert.rejects(() => extractUploadId(request), isRequestBodyTooLargeError);
    });

    it('selects a stable DO for modern identifiers while keeping legacy file bodies local', () => {
        const selected = [];
        const namespace = { idFromName(name) { selected.push(name); return name; }, newUniqueId() { return 'unique'; }, get(id) { return { id }; } };
        assert.equal(resolveUploadDurableObject(namespace, new Request(ORIGIN + '/upload?chunked=true'), null), null);
        assert.equal(resolveUploadDurableObject(namespace, new Request(ORIGIN + '/upload?chunked=true'), 'stable').id, 'stable');
        assert.deepEqual(selected, ['stable']);
    });

    it('does not retry in the Worker after a DO consumes the body and fails', async () => {
        const { env, calls } = makeEnv();
        let dispatched = 0;
        env.UPLOAD_DO = { idFromName(name) { return name; }, get() { return { async fetch(request) {
            dispatched++;
            assert.equal(await request.text(), 'file payload');
            throw new Error('private-endpoint credential=private-secret');
        } }; } };
        const request = new Request(ORIGIN + '/upload?chunked=true&uploadId=stable', { method: 'POST', body: 'file payload' });
        const previous = console.error;
        console.error = () => {};
        try {
            const response = await forwardToUploadDO({ request, env, data: {} });
            assert.equal(response.status, 502);
            assert.doesNotMatch(await response.text(), /private-endpoint|private-secret/);
            assert.equal(dispatched, 1);
            assert.equal(calls.get, 0);
            assert.equal(request.bodyUsed, true);
        } finally { console.error = previous; }
    });

    it('enforces method guards and answers preflight without a DO binding', async () => {
        for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
            assert.equal(getUploadRequestMethodRejection(new Request(ORIGIN + '/upload', { method })).status, 405);
        }
        assert.equal(getUploadRequestMethodRejection(new Request(ORIGIN + '/upload?cleanup=true')), null);
        const response = await forwardToUploadDO({ request: new Request(ORIGIN + '/upload', { method: 'OPTIONS' }), env: {} });
        assert.equal(response.status, 204);
    });

    it('checks method/preflight before the busy DO merge lock', async () => {
        const { env } = makeEnv();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const previousGet = env.img_url.get;
        env.img_url.get = async key => key === 'manage@sysConfig@security' ? gate : previousGet(key);
        const durable = new UploadDurableObject(runtimeContext(), env);
        const body = new FormData();
        body.append('uploadId', 'unknown');
        body.append('totalChunks', '1');
        body.append('originalFileName', 'a.pdf');
        const pending = durable.fetch(new Request(ORIGIN + '/upload?merge=true', { method: 'POST', body }));
        try {
            await tick();
            assert.ok(durable.activeMergePromise);
            assert.equal((await durable.fetch(new Request(ORIGIN + '/upload?merge=true', { method: 'OPTIONS' }))).status, 204);
            assert.equal((await durable.fetch(new Request(ORIGIN + '/upload?merge=true', { method: 'PUT' }))).status, 405);
            const busy = await durable.fetch(new Request(ORIGIN + '/upload?merge=true', { method: 'POST', body }));
            assert.equal(busy.status, 409);
            assert.equal((await busy.json()).code, 'MERGE_IN_PROGRESS');
        } finally { release(null); await pending; }
    });

    it('blocks cleanup while the DO owns a live merge even when KV could show a stale lease', async () => {
        const { env, calls } = makeEnv({ upload_session_stable: JSON.stringify({ status: 'initialized', totalChunks: 1 }) });
        const durable = new UploadDurableObject(runtimeContext(), env);
        let release;
        let handled = 0;
        durable._handleRequest = async () => {
            handled++;
            return new Promise(resolve => { release = () => resolve(new Response('merged')); });
        };
        const pending = durable.fetch(new Request(ORIGIN + '/upload?merge=true&uploadId=stable', { method: 'POST' }));
        try {
            assert.ok(durable.activeMergePromise);
            for (const method of ['GET', 'POST']) {
                const response = await durable.fetch(new Request(ORIGIN + '/upload?cleanup=true&uploadId=stable&totalChunks=1', { method }));
                assert.equal(response.status, 409);
                assert.equal((await response.json()).code, 'MERGE_IN_PROGRESS');
                assert.equal(response.headers.get('Cache-Control'), 'no-store');
            }
            assert.equal(handled, 1);
            assert.equal(calls.get, 0);
        } finally { release(); await pending; }
        assert.equal(durable.activeMergePromise, null);
    });

    it('rechecks the live merge lock when queued cleanup reaches execution', async () => {
        const durable = new UploadDurableObject(runtimeContext(), {});
        let releaseChunk;
        let releaseMerge;
        let cleaned = false;
        durable._handleRequest = async request => {
            const url = new URL(request.url);
            if (url.searchParams.has('merge')) {
                return new Promise(resolve => { releaseMerge = () => resolve(new Response('merged')); });
            }
            if (url.searchParams.has('cleanup')) { cleaned = true; return new Response('cleaned'); }
            return new Promise(resolve => { releaseChunk = () => resolve(new Response('uploaded')); });
        };
        const chunk = durable.fetch(new Request(ORIGIN + '/upload?chunked=true', { method: 'POST' }));
        await tick();
        const cleanup = durable.fetch(new Request(ORIGIN + '/upload?cleanup=true'));
        const merge = durable.fetch(new Request(ORIGIN + '/upload?merge=true', { method: 'POST' }));
        try {
            assert.ok(durable.activeMergePromise);
            releaseChunk();
            await chunk;
            const response = await cleanup;
            assert.equal(response.status, 409);
            assert.equal((await response.json()).code, 'MERGE_IN_PROGRESS');
            assert.equal(cleaned, false);
            assert.equal(durable.activeCleanupPromise, null);
        } finally { releaseMerge(); await merge; }
    });

    it('prevents a merge from starting while cleanup awaits remote work', async () => {
        const durable = new UploadDurableObject(runtimeContext(), {});
        let release;
        let handled = 0;
        durable._handleRequest = async () => {
            handled++;
            return new Promise(resolve => { release = () => resolve(new Response('cleaned')); });
        };
        const cleanup = durable.fetch(new Request(ORIGIN + '/upload?cleanup=true'));
        await tick();
        try {
            assert.ok(durable.activeCleanupPromise);
            const response = await durable.fetch(new Request(ORIGIN + '/upload?merge=true', { method: 'POST' }));
            assert.equal(response.status, 409);
            assert.equal((await response.json()).code, 'CLEANUP_IN_PROGRESS');
            assert.equal(response.headers.get('Cache-Control'), 'no-store');
            assert.equal(handled, 1);
            assert.equal(durable.activeMergePromise, null);
        } finally { release(); await cleanup; }
        assert.equal(durable.activeCleanupPromise, null);
    });

    it('releases cleanup ownership after rejection so subsequent merges can proceed', async () => {
        const durable = new UploadDurableObject(runtimeContext(), {});
        durable._handleRequest = async request => {
            if (new URL(request.url).searchParams.has('cleanup')) throw new Error('cleanup failed');
            return new Response('merged');
        };
        await assert.rejects(durable.fetch(new Request(ORIGIN + '/upload?cleanup=true')), /cleanup failed/);
        assert.equal(durable.activeCleanupPromise, null);
        assert.equal((await durable.fetch(new Request(ORIGIN + '/upload?merge=true', { method: 'POST' }))).status, 200);
    });

    it('serializes tasks without poisoning the queue after a rejection', async () => {
        const run = createSerialExecutor();
        const order = [];
        let release;
        const first = run(async () => { order.push('first'); await new Promise(resolve => { release = resolve; }); throw new Error('first failed'); });
        const second = run(async () => { order.push('second'); return 2; });
        await tick();
        assert.deepEqual(order, ['first']);
        release();
        await assert.rejects(first, /first failed/);
        assert.equal(await second, 2);
        assert.deepEqual(order, ['first', 'second']);
    });
});

describe('Pages adapter HTTP method contracts', () => {
    it('does not call POST/GET handlers for unsupported methods and supplies Allow', async () => {
        let called = false;
        for (const [wrap, allowed, method] of [[postOnly, 'POST', 'GET'], [getOnly, 'GET', 'POST']]) {
            const response = await wrap(() => { called = true; return new Response('unexpected'); })({ request: new Request(ORIGIN + '/api/example', { method }), env: {} });
            assert.equal(response.status, 405);
            assert.match(response.headers.get('Allow'), new RegExp(allowed));
            assert.match(response.headers.get('Allow'), /OPTIONS/);
        }
        assert.equal(called, false);
    });

    it('includes an explicitly exported HEAD handler in generated preflight', () => {
        const response = buildGeneratedOptionsResponse({ onRequestHead() { return new Response(null); } }, new Request(ORIGIN + '/api/example', { method: 'OPTIONS' }), {});
        assert.equal(response.status, 204);
        assert.match(response.headers.get('Access-Control-Allow-Methods'), /HEAD/);
    });
});
