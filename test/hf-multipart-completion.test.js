import assert from 'node:assert/strict';
import { onRequestPost as initialize } from '../functions/upload/huggingface/getUploadUrl.js';
import { onRequestPost as commit } from '../functions/upload/huggingface/commitUpload.js';
import { onRequestPost as complete, validateMultipartBody } from '../functions/upload/huggingface/completeMultipart.js';
import { getDirectUploadSession } from '../functions/upload/huggingface/directUploadSession.js';
import { extractIssuedMultipartDescriptor, validateMultipartParts, MAX_HF_COMPLETION_BODY_BYTES } from '../functions/upload/huggingface/multipartProtocol.js';
import { enforceRequestBodyLimit, MAX_METADATA_BODY_BYTES } from '../src/requestBodyPolicy.js';
import { isRequestBodyTooLargeError } from '../functions/utils/requestLimits.js';
import { HuggingFaceAPI } from '../functions/utils/huggingfaceAPI.js';

const OID = 'a'.repeat(64);
const CHUNK_SIZE = 5 * 1024 * 1024;
const COMPLETION_URL = 'https://huggingface.co/api/complete_multipart?providerBinding=issued';
const INPUT = { fileName: 'archive.unknown', fileType: 'application/x-custom', sha256: OID,
    fileSize: 2 * CHUNK_SIZE, fileSample: 'AQID', uploadNameType: 'origin' };
const sessionKey = fullId => `manage@direct-upload@hf@${fullId}`;
const receiptKey = fullId => `${sessionKey(fullId)}@multipart-completion`;
const parts = (count, etag = '"0123456789abcdef0123456789abcdef"') =>
    Array.from({ length: count }, (_, index) => ({ partNumber: index + 1, etag }));

function uploadInfo(fileSize) {
    const count = Math.ceil(fileSize / CHUNK_SIZE);
    const header = { chunk_size: String(CHUNK_SIZE), uploadId: 'issued-provider-capability', key: 'issued-key', bucket: 'issued-bucket' };
    for (let i = 1; i <= count; i++) header[i] = `https://storage.hf.example/part/${i}?signature=never-persist-part-urls`;
    return { needsLfs: true, alreadyExists: false, oid: OID, isMultipart: true,
        uploadAction: { href: COMPLETION_URL, header } };
}

function fixture() {
    const values = new Map();
    const records = new Map();
    const events = [];
    const pending = [];
    const failures = { receipt: false, metadata: false, commit: false };
    const env = { HF_TOKEN: 'fixture-token', HF_REPO: 'fixtures/multipart-documents', HF_PRIVATE: 'true',
        UPLOAD_MAX_TOTAL_BYTES: '1', UPLOAD_ALLOWED_EXTENSIONS: 'png',
        img_url: {
            async get(key) { return values.get(key) ?? null; },
            async put(key, value, options = {}) {
                if (key.endsWith('@multipart-completion')) {
                    const state = JSON.parse(value);
                    if (state.status === 'completed' && failures.receipt) throw new Error('private receipt storage failure');
                    events.push(`receipt:${state.status}`);
                }
                if (options.metadata) {
                    if (failures.metadata) throw new Error('private final metadata failure');
                    events.push('final-metadata');
                }
                values.set(key, value);
                records.set(key, { value, metadata: options.metadata });
            },
            async getWithMetadata(key) { return records.get(key) ?? { value: null, metadata: null }; },
            async delete(key) { values.delete(key); records.delete(key); },
            async list({ prefix = '' } = {}) {
                return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })), list_complete: true };
            },
        } };
    const context = (path, body, { raw, boundary = false } = {}) => {
        let request = new Request(`https://img.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: raw === undefined ? JSON.stringify(body) : raw });
        if (boundary) request = enforceRequestBodyLimit(request, env);
        return { env, request, data: {}, waitUntil(promise) { pending.push(promise.catch(() => {})); } };
    };
    return { env, values, records, events, pending, failures, context,
        async initialize(count = 2) {
            const input = { ...INPUT, fileSize: count * CHUNK_SIZE };
            const response = await initialize(context('/api/huggingface/getUploadUrl', input));
            assert.equal(response.status, 200, await response.clone().text());
            const issued = await response.json();
            return { input, issued, body: { ...input, fullId: issued.fullId, filePath: issued.filePath, channelName: issued.channelName } };
        },
    };
}

describe('HuggingFace multipart descriptor and protocol validation', () => {
    it('stores only a bounded completion descriptor, not thousands of signed part URLs', () => {
        const descriptor = extractIssuedMultipartDescriptor(uploadInfo(10000 * CHUNK_SIZE), 10000 * CHUNK_SIZE, OID);
        assert.equal(descriptor.partCount, 10000);
        assert.equal(descriptor.chunkSize, CHUNK_SIZE);
        assert.equal(descriptor.completionUrl, COMPLETION_URL);
        assert.equal(descriptor.metadata.uploadId, 'issued-provider-capability');
        assert.doesNotMatch(JSON.stringify(descriptor), /never-persist-part-urls|storage\.hf\.example|chunk_size/);
    });

    it('rejects unsafe completion URLs, inconsistent layouts and reserved completion metadata', () => {
        const invalid = [
            info => { info.uploadAction.href = 'http://huggingface.co/api/complete_multipart'; },
            info => { info.uploadAction.href = 'https://huggingface.co.evil.example/api/complete_multipart'; },
            info => { info.uploadAction.href = 'https://user:secret@huggingface.co/api/complete_multipart'; },
            info => { info.uploadAction.href = 'https://huggingface.co/api/complete_multipart#fragment'; },
            info => { info.uploadAction.header.chunk_size = '1suffix'; },
            info => { delete info.uploadAction.header['2']; },
            info => { info.uploadAction.header['0'] = info.uploadAction.header['1']; },
            info => { info.uploadAction.header['02'] = info.uploadAction.header['2']; delete info.uploadAction.header['2']; },
            info => { info.uploadAction.header.oid = 'must-not-override'; },
            info => { info.uploadAction.header.Parts = 'must-not-override'; },
            info => { info.uploadAction.header.uploadId = 'x'.repeat(8193); },
            info => { info.oid = 'b'.repeat(64); },
        ];
        for (const mutate of invalid) {
            const info = uploadInfo(INPUT.fileSize);
            mutate(info);
            assert.throws(() => extractIssuedMultipartDescriptor(info, INPUT.fileSize, OID), /Invalid issued/);
        }
    });

    it('validates canonical numbered parts and bounded opaque ETags', () => {
        assert.deepEqual(validateMultipartParts(OID, [{ partNumber: '2', etag: '"b"' }, { partNumber: 1, etag: '"a"' }]),
            [{ partNumber: 1, etag: '"a"' }, { partNumber: 2, etag: '"b"' }]);
        const invalid = [null, [], [null], [{ partNumber: 1, etag: '' }], [{ partNumber: 1, etag: 'x'.repeat(129) }],
            [{ partNumber: true, etag: 'x' }], [{ partNumber: [1], etag: 'x' }], [{ partNumber: '01', etag: 'x' }],
            [{ partNumber: '1suffix', etag: 'x' }], [{ partNumber: 1.5, etag: 'x' }], [{ partNumber: 0, etag: 'x' }],
            [{ partNumber: 1, etag: 'x\n' }], [{ partNumber: 1, etag: '\u00e9' }], [{ partNumber: 2, etag: 'x' }],
            [{ partNumber: 1, etag: 'x' }, { partNumber: 1, etag: 'y' }], parts(10001)];
        for (const values of invalid) assert.throws(() => validateMultipartParts(OID, values), /multipart/i);
        assert.throws(() => validateMultipartBody(JSON.stringify({ oid: 'wrong-oid', parts: parts(2) })), /hash/i);
    });
});

describe('session-bound HuggingFace multipart handlers', () => {
    const originalGet = HuggingFaceAPI.prototype.getLfsUploadInfo;
    const originalCommit = HuggingFaceAPI.prototype.commitLfsFile;
    const originalBatch = HuggingFaceAPI.prototype.lfsBatch;
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const originalLog = console.log;
    let current;
    let network;
    let commitCalls;
    let batchCalls;
    let getOverride;
    let completionFailure;
    beforeEach(() => {
        network = []; commitCalls = []; batchCalls = []; getOverride = null; completionFailure = null;
        current = fixture();
        console.error = () => {};
        console.log = () => {};
        HuggingFaceAPI.prototype.getLfsUploadInfo = async function (fileSize) { return getOverride ?? uploadInfo(fileSize); };
        HuggingFaceAPI.prototype.commitLfsFile = async function (...args) {
            current.events.push('commit');
            commitCalls.push(args);
            if (current.failures.commit) throw new Error('private commit capability');
            return { ok: true };
        };
        HuggingFaceAPI.prototype.lfsBatch = async function (oid, size) {
            batchCalls.push({ oid, size });
            return { objects: [{ oid, size }] };
        };
        globalThis.fetch = async (url, options) => {
            assert.equal(url, COMPLETION_URL);
            current.events.push('complete');
            network.push({ url, options, body: JSON.parse(options.body) });
            if (completionFailure === 'http') return new Response('private upstream failure', { status: 400 });
            if (typeof completionFailure === 'number') return new Response('private upstream failure after application', { status: completionFailure });
            if (completionFailure === 'network') throw new Error('private provider timeout');
            if (completionFailure === 'redirect') return new Response(null, { status: 307, headers: { Location: 'https://attacker.example/' } });
            if (completionFailure === 'oversized-response') return new Response(new Uint8Array(64 * 1024 + 1));
            return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'provider=must-not-forward' } });
        };
    });
    afterEach(async () => {
        await Promise.all(current.pending);
        HuggingFaceAPI.prototype.getLfsUploadInfo = originalGet;
        HuggingFaceAPI.prototype.commitLfsFile = originalCommit;
        HuggingFaceAPI.prototype.lfsBatch = originalBatch;
        globalThis.fetch = originalFetch;
        console.error = originalError;
        console.log = originalLog;
    });

    it('persists the original provider descriptor before rewriting the client completion URL', async () => {
        const { issued } = await current.initialize(1500);
        const stored = await getDirectUploadSession(current.env, issued.fullId);
        assert.equal(stored.multipart.completionUrl, COMPLETION_URL);
        assert.equal(stored.multipart.partCount, 1500);
        assert.equal(stored.uploadMode, 'multipart');
        assert.equal(stored.multipart.metadata.uploadId, 'issued-provider-capability');
        assert.doesNotMatch(JSON.stringify(stored), /never-persist-part-urls/);
        const clientUrl = new URL(issued.uploadAction.href);
        assert.equal(clientUrl.origin, 'https://img.example');
        assert.equal(clientUrl.searchParams.get('fullId'), issued.fullId);
        assert.equal(clientUrl.searchParams.has('target'), false);
        assert.equal(current.records.has(issued.fullId), false);
    });

    for (const count of [1500, 10000]) {
        it(`completes ${count} large-file parts before committing and publishing metadata`, async () => {
            const { body, issued } = await current.initialize(count);
            const payload = { ...body, multipartParts: parts(count, 'x'.repeat(128)),
                uploadAction: { href: 'https://attacker.example/ssrf', header: { uploadId: 'client-override' } } };
            assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < MAX_HF_COMPLETION_BODY_BYTES);
            const response = await commit(current.context('/api/huggingface/commitUpload', payload, { boundary: true }));
            assert.equal(response.status, 200, await response.clone().text());
            assert.equal(response.headers.get('Cache-Control'), 'no-store');
            assert.equal(network.length, 1);
            assert.equal(network[0].options.redirect, 'manual');
            assert.ok(network[0].options.signal instanceof AbortSignal);
            assert.equal(network[0].options.headers.Authorization, undefined);
            assert.equal(network[0].body.parts.length, count);
            assert.equal(network[0].body.uploadId, 'issued-provider-capability');
            assert.equal(network[0].body.oid, OID);
            assert.equal(commitCalls.length, 1);
            assert.ok(current.events.indexOf('complete') < current.events.indexOf('receipt:completed'));
            assert.ok(current.events.indexOf('receipt:completed') < current.events.indexOf('commit'));
            assert.ok(current.events.indexOf('commit') < current.events.indexOf('final-metadata'));
            const metadata = current.records.get(issued.fullId).metadata;
            assert.equal(metadata.FileSizeBytes, count * CHUNK_SIZE);
            assert.equal(metadata.FileType, 'application/x-custom');
            assert.doesNotMatch(JSON.stringify(metadata), /issued-provider-capability|providerBinding|completionUrl|multipartCompletion|partsDigest/);
            assert.equal(response.headers.get('Set-Cookie'), null);
        });
    }

    it('binds the independent completion endpoint to the issued session and reuses its receipt in commit', async () => {
        const { body, issued } = await current.initialize();
        const response = await complete(current.context(new URL(issued.uploadAction.href).pathname + new URL(issued.uploadAction.href).search,
            { oid: OID, parts: parts(2), uploadId: 'issued-provider-capability', key: 'issued-key', bucket: 'issued-bucket' }));
        assert.equal(response.status, 200);
        assert.equal(network.length, 1);
        assert.equal(commitCalls.length, 0);
        assert.equal(current.records.has(issued.fullId), false);
        assert.equal((await commit(current.context('/upload/huggingface/commitUpload', body))).status, 200);
        assert.equal(network.length, 1);
        assert.equal(commitCalls.length, 1);
    });

    it('rejects client target, object hash and completion metadata substitution without network activity', async () => {
        const { issued } = await current.initialize();
        const path = `/upload/huggingface/completeMultipart?fullId=${encodeURIComponent(issued.fullId)}`;
        for (const [query, body] of [
            ['&target=' + encodeURIComponent('https://attacker.example/'), { oid: OID, parts: parts(2) }],
            ['&target=' + encodeURIComponent('https://huggingface.co/api/complete_multipart?providerBinding=other'), { oid: OID, parts: parts(2) }],
            ['', { oid: 'b'.repeat(64), parts: parts(2) }],
            ['', { oid: OID, parts: parts(2), uploadId: 'client-override' }],
            ['', { oid: OID, parts: parts(2), fullId: 'another.pdf' }],
            ['', { oid: OID, parts: parts(2), unknownMetadata: 'unsupported' }],
        ]) {
            assert.equal((await complete(current.context(path + query, body))).status, 400);
        }
        assert.equal((await complete(current.context('/upload/huggingface/completeMultipart?target=' + encodeURIComponent(COMPLETION_URL),
            { oid: OID, parts: parts(2) }))).status, 409);
        assert.equal(network.length, 0);
        assert.equal(commitCalls.length, 0);
    });

    it('rejects missing, duplicate, malformed and excessive part declarations before completion or commit', async () => {
        const { body, issued } = await current.initialize();
        for (const multipartParts of [undefined, [], parts(1), [{ partNumber: 1, etag: 'x' }, { partNumber: 1, etag: 'y' }],
            [{ partNumber: '1suffix', etag: 'x' }, { partNumber: 2, etag: 'y' }], parts(2, 'x'.repeat(129)), parts(10001)]) {
            const response = await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts }));
            assert.equal(response.status, 400);
        }
        assert.equal(network.length, 0);
        assert.equal(commitCalls.length, 0);
        assert.equal(current.records.has(issued.fullId), false);
        assert.equal(current.pending.length, 0);
    });

    it('does not accept multipart arguments for a legacy session without an issued descriptor', async () => {
        const { body, issued } = await current.initialize();
        const stored = await getDirectUploadSession(current.env, issued.fullId);
        delete stored.multipart;
        delete stored.uploadMode;
        stored.schemaVersion = 1;
        current.values.set(sessionKey(issued.fullId), JSON.stringify(stored));
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts: parts(2) }))).status, 409);
        assert.equal(network.length, 0);
        assert.equal(commitCalls.length, 0);
    });

    for (const mode of ['basic', 'already-exists']) {
        it(`keeps ${mode} uploads working without a multipart completion step`, async () => {
            getOverride = mode === 'basic' ? { needsLfs: true, alreadyExists: false, oid: OID,
                uploadAction: { href: 'https://storage.hf.example/basic?signature=not-persisted', header: {} } }
                : { needsLfs: true, alreadyExists: true, oid: OID };
            const { body, issued } = await current.initialize();
            assert.equal((await commit(current.context('/api/huggingface/commitUpload', body))).status, 200);
            assert.equal(network.length, 0);
            assert.equal(commitCalls.length, 1);
            assert.equal(current.records.has(issued.fullId), true);
        });
    }

    it('never commits or publishes metadata after a provider completion rejection, and retries explicit failures safely', async () => {
        const { body, issued } = await current.initialize();
        completionFailure = 'http';
        const first = await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts: parts(2) }));
        assert.equal(first.status, 502);
        assert.doesNotMatch(await first.text(), /private upstream/);
        assert.equal(current.values.has(receiptKey(issued.fullId)), false);
        assert.equal(commitCalls.length, 0);
        assert.equal(current.records.has(issued.fullId), false);
        assert.equal(current.pending.length, 0);
        completionFailure = null;
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts: parts(2) }))).status, 200);
        assert.equal(network.length, 2);
        assert.equal(commitCalls.length, 1);
    });

    it('retains the completion receipt when the later LFS commit fails, so retry never completes twice', async () => {
        const { body, issued } = await current.initialize();
        current.failures.commit = true;
        const payload = { ...body, multipartParts: parts(2) };
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 500);
        assert.equal(JSON.parse(current.values.get(receiptKey(issued.fullId))).status, 'completed');
        assert.equal(current.records.has(issued.fullId), false);
        assert.equal(current.pending.length, 0);
        current.failures.commit = false;
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 200);
        assert.equal(network.length, 1);
        assert.equal(commitCalls.length, 2);
        assert.equal(current.events.filter(event => event === 'final-metadata').length, 1);
        const saved = await getDirectUploadSession(current.env, issued.fullId);
        assert.equal(saved.multipartCompletion.status, 'completed');
    });

    for (const status of [500, 502, 504, 408, 429, 202, 206]) {
        it(`probes the applied object after an ambiguous HTTP ${status} rather than repeating its completion POST`, async () => {
            const { body, issued } = await current.initialize();
            const payload = { ...body, multipartParts: parts(2) };
            completionFailure = status;
            assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 502);
            assert.equal(JSON.parse(current.values.get(receiptKey(issued.fullId))).status, 'completing');
            assert.equal(commitCalls.length, 0);
            completionFailure = null;
            assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 200);
            assert.equal(network.length, 1);
            assert.equal(batchCalls.length, 1);
        });
    }

    it('keeps completion idempotent when publishing final metadata fails', async () => {
        const { body } = await current.initialize();
        current.failures.metadata = true;
        const payload = { ...body, multipartParts: parts(2) };
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 500);
        assert.equal(current.pending.length, 0);
        current.failures.metadata = false;
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 200);
        assert.equal(network.length, 1);
    });

    for (const failure of ['network', 'oversized-response']) {
        it(`reconciles an ambiguous ${failure} outcome before retry instead of blindly repeating completion`, async () => {
            const { body, issued } = await current.initialize();
            const payload = { ...body, multipartParts: parts(2) };
            completionFailure = failure;
            assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 502);
            assert.equal(JSON.parse(current.values.get(receiptKey(issued.fullId))).status, 'completing');
            assert.equal(commitCalls.length, 0);
            completionFailure = null;
            assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 200);
            assert.equal(network.length, 1);
            assert.equal(batchCalls.length, 1);
        });
    }

    it('reconciles a completed object when persisting the completion receipt failed', async () => {
        const { body, issued } = await current.initialize();
        const payload = { ...body, multipartParts: parts(2) };
        current.failures.receipt = true;
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 500);
        assert.equal(JSON.parse(current.values.get(receiptKey(issued.fullId))).status, 'completing');
        assert.equal(commitCalls.length, 0);
        current.failures.receipt = false;
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 200);
        assert.equal(network.length, 1);
        assert.equal(batchCalls.length, 1);
    });

    it('requires reinitialization when a previous ambiguous completion cannot be confirmed', async () => {
        const { body } = await current.initialize();
        const payload = { ...body, multipartParts: parts(2) };
        completionFailure = 'network';
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 502);
        HuggingFaceAPI.prototype.lfsBatch = async () => ({ objects: [{ oid: OID, size: body.fileSize, actions: { upload: { href: 'new-upload' } } }] });
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', payload))).status, 409);
        assert.equal(network.length, 1);
        assert.equal(commitCalls.length, 0);
    });

    it('never follows completion redirects', async () => {
        const { body } = await current.initialize();
        completionFailure = 'redirect';
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts: parts(2) }))).status, 502);
        assert.equal(network.length, 1);
        assert.equal(commitCalls.length, 0);
    });

    it('keeps the completion deadline active through a stalled response body and cancels its reader', async () => {
        const { body } = await current.initialize();
        const originalSetTimeout = globalThis.setTimeout;
        let cancelled = false;
        globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 30000 ? 10 : delay, ...args);
        globalThis.fetch = async () => new Response(new ReadableStream({
            pull() { return new Promise(() => {}); },
            cancel() { cancelled = true; },
        }));
        try {
            const response = await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts: parts(2) }));
            assert.equal(response.status, 502);
            assert.equal(cancelled, true);
            assert.equal(commitCalls.length, 0);
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }
    });

    it('coalesces concurrent identical completion calls within the same binding/isolate', async () => {
        const { issued } = await current.initialize();
        const path = new URL(issued.uploadAction.href).pathname + new URL(issued.uploadAction.href).search;
        const payload = { oid: OID, parts: parts(2) };
        const previousFetch = globalThis.fetch;
        globalThis.fetch = async (...args) => { await new Promise(resolve => setTimeout(resolve, 10)); return previousFetch(...args); };
        const responses = await Promise.all([complete(current.context(path, payload)), complete(current.context(path, payload))]);
        assert.deepEqual(responses.map(response => response.status), [200, 200]);
        assert.equal(network.length, 1);
        assert.equal(commitCalls.length, 0);
    });

    it('rejects changed parts after a completed receipt without a second provider request', async () => {
        const { body } = await current.initialize();
        current.failures.commit = true;
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts: parts(2) }))).status, 500);
        current.failures.commit = false;
        assert.equal((await commit(current.context('/api/huggingface/commitUpload', { ...body, multipartParts: parts(2, 'different-etag') }))).status, 409);
        assert.equal(network.length, 1);
        assert.equal(commitCalls.length, 1);
    });

    it('rejects malformed JSON bodies with structured non-cacheable errors', async () => {
        const { body } = await current.initialize();
        for (const raw of ['null', '[]', '{not-json']) {
            const response = await commit(current.context('/api/huggingface/commitUpload', body, { raw }));
            assert.equal(response.status, 400);
            assert.equal((await response.json()).code, 'INVALID_REQUEST_BODY');
            assert.equal(response.headers.get('Cache-Control'), 'no-store');
        }
        assert.equal(network.length, 0);
    });

    it('rejects a stored session under the wrong fullId before standalone completion', async () => {
        const { issued } = await current.initialize();
        const stored = await getDirectUploadSession(current.env, issued.fullId);
        stored.fullId = 'other-upload.pdf';
        current.values.set(sessionKey(issued.fullId), JSON.stringify(stored));
        const path = new URL(issued.uploadAction.href).pathname + new URL(issued.uploadAction.href).search;
        assert.equal((await complete(current.context(path, { oid: OID, parts: parts(2) }))).status, 400);
        assert.equal(network.length, 0);
        assert.equal(commitCalls.length, 0);
    });

    it('enforces the 2 MiB body budget on the session-bound completion endpoint', async () => {
        const { issued } = await current.initialize();
        const path = new URL(issued.uploadAction.href).pathname + new URL(issued.uploadAction.href).search;
        const response = await complete(current.context(path, { oid: OID, parts: parts(2), padding: 'x'.repeat(MAX_HF_COMPLETION_BODY_BYTES) }));
        assert.equal(response.status, 413);
        assert.equal(network.length, 0);
        assert.equal(commitCalls.length, 0);
    });
});

describe('bounded multipart control payload budgets', () => {
    it('uses 2 MiB for commit/completion while leaving initialization control bodies at 64 KiB', async () => {
        for (const path of ['/api/huggingface/commitUpload', '/upload/huggingface/commitUpload', '/upload/huggingface/completeMultipart']) {
            const request = new Request(`https://img.example${path}`, { method: 'POST', body: new Uint8Array(MAX_METADATA_BODY_BYTES + 1) });
            assert.equal((await enforceRequestBodyLimit(request, {}).arrayBuffer()).byteLength, MAX_METADATA_BODY_BYTES + 1);
            const large = new Request(`https://img.example${path}`, { method: 'POST', body: new Uint8Array(MAX_HF_COMPLETION_BODY_BYTES + 1) });
            await assert.rejects(() => enforceRequestBodyLimit(large, {}).arrayBuffer(), isRequestBodyTooLargeError);
        }
        for (const path of ['/api/huggingface/getUploadUrl', '/upload/huggingface/getUploadUrl']) {
            const request = new Request(`https://img.example${path}`, { method: 'POST', body: new Uint8Array(MAX_METADATA_BODY_BYTES + 1) });
            await assert.rejects(() => enforceRequestBodyLimit(request, {}).arrayBuffer(), isRequestBodyTooLargeError);
        }
    });

    it('enforces the stream-counted 2 MiB cap inside commit handlers too', async () => {
        const f = fixture();
        const response = await commit(f.context('/api/huggingface/commitUpload', null, {
            raw: JSON.stringify({ padding: 'x'.repeat(MAX_HF_COMPLETION_BODY_BYTES) }),
        }));
        assert.equal(response.status, 413);
        assert.equal((await response.json()).code, 'REQUEST_BODY_TOO_LARGE');
        assert.equal(f.pending.length, 0);
    });
});
