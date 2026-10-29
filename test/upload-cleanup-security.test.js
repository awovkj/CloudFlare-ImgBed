import assert from 'node:assert/strict';
import { onRequest } from '../functions/upload/index.js';
import { cleanupFailedMultipartUploads, forceCleanupUpload, handleCleanupRequest } from '../functions/upload/chunkUpload.js';

const UPLOAD_ID = 'upload-cleanup-fixture';
const SESSION_KEY = `upload_session_${UPLOAD_ID}`;
const MANIFEST_KEY = `upload_manifest_${UPLOAD_ID}`;
const MULTIPART_KEY = `multipart_${UPLOAD_ID}`;
const RECEIPT_KEY = `upload_merge_result_${UPLOAD_ID}`;
const chunkKey = index => `chunk_${UPLOAD_ID}_${index.toString().padStart(3, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ totalChunks = 2, sessionPatch = {}, sessionData, missingSession = false, multipart = false,
    failRead = false, failDelete, failAbort = false, delayDeletes = false, authenticated = false } = {}) {
    const session = { uploadId: UPLOAD_ID, totalChunks, originalFileName: 'report.pdf', originalFileType: 'application/pdf',
        uploadChannel: 'cfr2', status: 'initialized', updatedAt: Date.now(), expiresAt: Date.now() + 60000, ...sessionPatch };
    const entries = new Map([
        [MANIFEST_KEY, JSON.stringify({ uploadId: UPLOAD_ID, totalChunks })],
        [RECEIPT_KEY, JSON.stringify({ mergeResult: [{ src: '/file/final-report.pdf' }] })],
        ['final-report.pdf', 'must keep the final file record'],
    ]);
    if (!missingSession) entries.set(SESSION_KEY, sessionData === undefined ? JSON.stringify(session) : sessionData);
    for (let i = 0; i < totalChunks; i++) entries.set(chunkKey(i), 'pending chunk');
    if (multipart) entries.set(MULTIPART_KEY, JSON.stringify({ uploadId: 'remote-upload', key: 'final-report.pdf' }));
    const reads = [];
    const deleted = [];
    const aborted = [];
    let currentDeletes = 0;
    let maxDeletes = 0;
    let failureEnabled = true;
    const env = { AUTH_CODE: authenticated ? 'required-fixture-credential' : '', img_url: {
        async get(key) {
            reads.push(key);
            if (key === SESSION_KEY && failRead) throw new Error('private database endpoint');
            return entries.get(key) ?? null;
        },
        async put(key, value) { entries.set(key, value); },
        async delete(key) {
            currentDeletes++;
            maxDeletes = Math.max(maxDeletes, currentDeletes);
            try {
                if (delayDeletes) await tick();
                if (key === failDelete && failureEnabled) throw new Error('private deletion credential');
                deleted.push(key);
                entries.delete(key);
            } finally {
                currentDeletes--;
            }
        },
        async list() { return { keys: [], list_complete: true }; },
    }, img_r2: {
        resumeMultipartUpload(key, uploadId) {
            return { async abort() {
                aborted.push({ key, uploadId });
                if (failAbort && failureEnabled) throw new Error('private abort credential');
            } };
        },
        async delete() { throw new Error('Cleanup must not delete finalized R2 objects'); },
    } };
    return { env, entries, reads, deleted, aborted, session,
        get maxDeletes() { return maxDeletes; },
        retry() { failureEnabled = false; },
    };
}

function context(f, { uploadId = UPLOAD_ID, totalChunks, method = 'GET' } = {}) {
    const url = new URL('https://img.example/upload?cleanup=true');
    if (uploadId !== null) url.searchParams.set('uploadId', uploadId);
    if (totalChunks !== undefined) url.searchParams.set('totalChunks', totalChunks);
    return { env: f.env, request: new Request(url, { method }), url, data: {}, waitUntil() {} };
}

describe('upload cleanup request validation and storage-bound workload', () => {
    it('requires upload authentication before reading cleanup state or deleting anything', async () => {
        const f = fixture({ authenticated: true });
        const response = await onRequest(context(f));
        assert.equal(response.status, 401);
        assert.equal(f.reads.includes(SESSION_KEY), false);
        assert.deepEqual(f.deleted, []);
        assert.deepEqual(f.aborted, []);
    });

    it('rejects missing, unsafe and overlong IDs without reading or deleting storage', async () => {
        for (const id of [null, '', '../other-upload', 'a,b', 'a/b', 'a\n', 'x'.repeat(129)]) {
            const f = fixture();
            const response = await handleCleanupRequest(context(f), id);
            assert.equal(response.status, 400, String(id));
            assert.equal((await response.json()).code, 'INVALID_UPLOAD_ID');
            assert.deepEqual(f.reads, []);
            assert.deepEqual(f.deleted, []);
        }
    });

    it('keeps the raw query value so malformed or excessive counts cannot be parseInt-normalized', async () => {
        for (const count of ['1suffix', '-1', '1.5', '', 'NaN', 'Infinity', '10001', '99999999999999999999']) {
            const f = fixture();
            const response = await onRequest(context(f, { totalChunks: count }));
            assert.equal(response.status, 400, count);
            assert.equal((await response.json()).code, 'INVALID_TOTAL_CHUNKS');
            assert.equal(f.reads.includes(SESSION_KEY), false);
            assert.deepEqual(f.deleted, []);
            assert.deepEqual(f.aborted, []);
        }
    });

    it('does not expand or truncate work using a mismatched caller count', async () => {
        for (const count of ['1', '3', '10000']) {
            const f = fixture({ multipart: true });
            const response = await onRequest(context(f, { totalChunks: count }));
            assert.equal(response.status, 400, count);
            assert.equal((await response.json()).code, 'SESSION_PARAMETERS_MISMATCH');
            assert.deepEqual(f.deleted, []);
            assert.deepEqual(f.aborted, []);
        }
    });

    it('uses the stored count for omitted counts and the legacy unknown-count zero', async () => {
        for (const count of [undefined, '0', '2']) {
            const f = fixture({ multipart: true });
            const response = await onRequest(context(f, { totalChunks: count }));
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Cache-Control'), 'no-store');
            assert.equal((await response.json()).cleanedChunks, 2);
            assert.ok(f.deleted.includes(chunkKey(0)));
            assert.ok(f.deleted.includes(chunkKey(1)));
            assert.equal(f.deleted.some(key => key === chunkKey(2)), false);
            assert.equal(f.entries.has(SESSION_KEY), false);
            assert.equal(f.entries.has(MANIFEST_KEY), false);
            assert.equal(f.entries.has(RECEIPT_KEY), true);
            assert.equal(f.entries.has('final-report.pdf'), true);
            assert.deepEqual(f.aborted, [{ key: 'final-report.pdf', uploadId: 'remote-upload' }]);
        }
    });

    it('is idempotent for missing sessions without deleting guessed chunks or multipart state', async () => {
        const f = fixture({ missingSession: true, multipart: true });
        const response = await onRequest(context(f, { totalChunks: '10000' }));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).cleanedChunks, 0);
        assert.deepEqual(f.deleted, []);
        assert.deepEqual(f.aborted, []);
        assert.equal(f.entries.has(chunkKey(0)), true);
        assert.equal(f.entries.has(MULTIPART_KEY), true);
    });

    it('bounds helper deletion concurrency using only a validated stored layout', async () => {
        const f = fixture({ totalChunks: 33, delayDeletes: true });
        const result = await forceCleanupUpload(context(f), UPLOAD_ID);
        assert.equal(result.cleanedChunks, 33);
        assert.ok(f.maxDeletes > 1);
        assert.ok(f.maxDeletes <= 8, `saw ${f.maxDeletes} concurrent deletes`);
        assert.equal(f.deleted.filter(key => key.startsWith('chunk_')).length, 33);
        assert.equal(f.deleted.at(-1), SESSION_KEY);
    });

    it('fails closed on malformed sessions and missing or invalid merge timing', async () => {
        const badSessions = ['not-json', 'null', '[]', JSON.stringify({ ...fixture().session, totalChunks: 10001 }),
            JSON.stringify({ ...fixture().session, uploadId: 'different-upload' }),
            JSON.stringify({ ...fixture().session, status: 'unexpected-state' }),
            JSON.stringify({ ...fixture().session, status: 'merging', updatedAt: undefined }),
            JSON.stringify({ ...fixture().session, status: 'merging', mergeLeaseUntil: 'invalid-time' }),
            JSON.stringify({ ...fixture().session, status: 'waiting_chunks', mergeResumeAfter: undefined })];
        for (const sessionData of badSessions) {
            const f = fixture({ sessionData, multipart: true });
            const response = await handleCleanupRequest(context(f), UPLOAD_ID);
            assert.equal(response.status, 500, sessionData);
            assert.deepEqual(f.deleted, []);
            assert.deepEqual(f.aborted, []);
        }
    });

    it('fails closed if the session read fails', async () => {
        const f = fixture({ failRead: true, multipart: true });
        const response = await handleCleanupRequest(context(f), UPLOAD_ID);
        assert.equal(response.status, 500);
        assert.doesNotMatch(await response.text(), /private database/);
        assert.deepEqual(f.deleted, []);
        assert.deepEqual(f.aborted, []);
    });
});

describe('upload cleanup merge protection, failures and safe retry', () => {
    it('protects active merge and scheduled retry states from deletion and abort', async () => {
        for (const sessionPatch of [
            { status: 'merging', mergeLeaseUntil: Date.now() + 60000 },
            { status: 'waiting_chunks', mergeResumeAfter: Date.now() + 60000 },
        ]) {
            const f = fixture({ sessionPatch, multipart: true });
            const response = await handleCleanupRequest(context(f), UPLOAD_ID);
            assert.equal(response.status, 409);
            assert.equal((await response.json()).code, 'MERGE_IN_PROGRESS');
            assert.equal(response.headers.get('Cache-Control'), 'no-store');
            assert.deepEqual(f.deleted, []);
            assert.deepEqual(f.aborted, []);
        }
    });

    it('permits cleanup of expired merge leases and failed sessions', async () => {
        for (const sessionPatch of [
            { status: 'merging', mergeLeaseUntil: Date.now() - 1000 },
            { status: 'waiting_chunks', mergeResumeAfter: Date.now() - 1000 },
            { status: 'merge_failed' },
        ]) {
            const f = fixture({ sessionPatch, multipart: true });
            const response = await handleCleanupRequest(context(f), UPLOAD_ID);
            assert.equal(response.status, 200);
            assert.equal(f.entries.has(SESSION_KEY), false);
            assert.equal(f.aborted.length, 1);
        }
    });

    it('retains successful merge sessions and receipts and never aborts or deletes final objects', async () => {
        const f = fixture({ sessionPatch: { status: 'merge_success', mergeResult: [{ src: '/file/final-report.pdf' }] }, multipart: true });
        const response = await handleCleanupRequest(context(f), UPLOAD_ID);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).cleanedChunks, 2);
        assert.deepEqual(f.aborted, []);
        assert.equal(f.entries.has(SESSION_KEY), true);
        assert.equal(f.entries.has(RECEIPT_KEY), true);
        assert.equal(f.entries.has('final-report.pdf'), true);
        assert.equal(f.entries.has(MULTIPART_KEY), false);
    });

    it('does not swallow multipart abort failures or discard retry state', async () => {
        const f = fixture({ multipart: true, failAbort: true });
        const response = await handleCleanupRequest(context(f), UPLOAD_ID);
        assert.equal(response.status, 500);
        assert.doesNotMatch(await response.text(), /private abort/);
        assert.deepEqual(f.deleted, []);
        assert.equal(f.entries.has(SESSION_KEY), true);
        assert.equal(f.entries.has(MULTIPART_KEY), true);
        f.retry();
        assert.equal((await handleCleanupRequest(context(f), UPLOAD_ID)).status, 200);
    });

    it('does not swallow missing S3 channel failures or delete the multipart record', async () => {
        const f = fixture({ multipart: true });
        const ctx = { ...context(f), uploadConfig: { s3: { channels: [], loadBalance: { enabled: false } } } };
        await assert.rejects(() => cleanupFailedMultipartUploads(ctx, UPLOAD_ID, 's3'), /no longer available/);
        assert.deepEqual(f.deleted, []);
        assert.equal(f.entries.has(MULTIPART_KEY), true);
    });

    it('keeps cleanup discoverable after a chunk deletion failure and retries safely', async () => {
        const f = fixture({ totalChunks: 20, failDelete: chunkKey(3), delayDeletes: true });
        const response = await handleCleanupRequest(context(f), UPLOAD_ID);
        assert.equal(response.status, 500);
        assert.doesNotMatch(await response.text(), /private deletion/);
        assert.equal(f.entries.has(SESSION_KEY), true);
        assert.equal(f.entries.has(MANIFEST_KEY), true);
        assert.equal(f.entries.has(chunkKey(8)), true);
        assert.ok(f.maxDeletes <= 8);
        f.retry();
        const retried = await handleCleanupRequest(context(f), UPLOAD_ID);
        assert.equal(retried.status, 200);
        assert.equal((await retried.json()).cleanedChunks, 20);
        assert.equal(f.entries.has(SESSION_KEY), false);
    });

    it('reports final state deletion failures rather than claiming success', async () => {
        const f = fixture({ failDelete: SESSION_KEY });
        const response = await handleCleanupRequest(context(f), UPLOAD_ID);
        assert.equal(response.status, 500);
        assert.equal(f.entries.has(SESSION_KEY), true);
        assert.equal(f.entries.has(RECEIPT_KEY), true);
        f.retry();
        assert.equal((await handleCleanupRequest(context(f), UPLOAD_ID)).status, 200);
    });

    it('accepts an already-aborted multipart resource as an idempotent retry', async () => {
        const f = fixture({ multipart: true });
        f.env.img_r2.resumeMultipartUpload = () => ({ async abort() {
            throw Object.assign(new Error('No remote upload remains'), { name: 'NoSuchUpload' });
        } });
        const response = await handleCleanupRequest(context(f), UPLOAD_ID);
        assert.equal(response.status, 200);
        assert.equal(f.entries.has(MULTIPART_KEY), false);
        assert.equal(f.entries.has(SESSION_KEY), false);
    });
});
