import assert from 'node:assert/strict';
import { onRequest } from '../functions/upload/chunkStatus.js';

function fixture({ authenticated = false, expired = false } = {}) {
    const session = { uploadId: 'upload-status-test', totalChunks: 1, status: 'initialized', originalFileName: 'report.pdf',
        uploadChannel: 'telegram', expiresAt: Date.now() + (expired ? -1000 : 60000), uploadIp: 'private-ip', secret: 'private-value' };
    let chunkReads = 0;
    const env = { AUTH_CODE: authenticated ? 'required-credential' : '', img_url: {
        async get(key) { return key === 'upload_session_upload-status-test' ? JSON.stringify(session) : null; },
        async getWithMetadata() {
            chunkReads++;
            return { value: '', metadata: { status: 'completed', uploadResult: { size: 1 }, uploadTime: Date.now() } };
        },
    } };
    return { env, get chunkReads() { return chunkReads; } };
}

const request = query => new Request(`https://img.example/upload/chunkStatus?uploadId=upload-status-test${query}`);

describe('chunk status access and work amplification guards', () => {
    it('requires upload authorization before reading a session or parts', async () => {
        const f = fixture({ authenticated: true });
        const response = await onRequest({ env: f.env, request: request('') });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(f.chunkReads, 0);
    });

    it('never lets caller-supplied totalChunks expand the stored session workload', async () => {
        const f = fixture();
        for (const count of ['10000', '-1', '1suffix', '1.5', '']) {
            const response = await onRequest({ env: f.env, request: request(`&totalChunks=${count}`) });
            assert.equal(response.status, 400, count);
        }
        assert.equal(f.chunkReads, 0);
    });

    it('rejects expired sessions without reading parts', async () => {
        const f = fixture({ expired: true });
        assert.equal((await onRequest({ env: f.env, request: request('') })).status, 410);
        assert.equal(f.chunkReads, 0);
    });

    it('returns only safe session fields and never caches successful status JSON', async () => {
        const f = fixture();
        const response = await onRequest({ env: f.env, request: request('&totalChunks=1') });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const payload = await response.json();
        assert.deepEqual(payload.uploadedChunks, [0]);
        assert.equal(payload.sessionInfo.secret, undefined);
        assert.equal(payload.sessionInfo.uploadIp, undefined);
        assert.equal(f.chunkReads, 1);
    });
});
