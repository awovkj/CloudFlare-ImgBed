import assert from 'node:assert/strict';
import { issueDirectUploadSession, getDirectUploadSession, validateDirectUploadSession, validateDirectUploadChannel, completeDirectUploadSession } from '../functions/upload/huggingface/directUploadSession.js';
import { onRequestPost as getUploadUrl } from '../functions/upload/huggingface/getUploadUrl.js';
import { onRequestPost as commitUpload } from '../functions/upload/huggingface/commitUpload.js';
import { isValidCompletionTarget } from '../functions/upload/huggingface/completeMultipart.js';
import { HuggingFaceAPI } from '../functions/utils/huggingfaceAPI.js';
import { resolveHuggingFaceCredentials } from '../functions/utils/metadata/channelCredentials.js';
import { resolveHfChannelConfig } from '../functions/utils/sysConfig.js';

function fixture() {
    const values = new Map();
    const records = new Map();
    const writes = [];
    const env = { HF_TOKEN: 'fixture-token', HF_REPO: 'fixtures/documents', HF_PRIVATE: 'true', dev_mode: 'true',
        img_url: {
            async get(key) { return values.get(key) ?? null; },
            async put(key, value, options = {}) {
                values.set(key, value); records.set(key, { value, metadata: options.metadata });
                writes.push({ key, options });
            },
            async getWithMetadata(key) { return records.get(key) || { value: null, metadata: null }; },
            async delete(key) { values.delete(key); records.delete(key); },
            async list({ prefix = '' } = {}) {
                return { keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name, metadata: records.get(name)?.metadata })), list_complete: true };
            },
        } };
    return { env, values, records, writes };
}

const upload = { fileName: 'report.pdf', fileType: 'application/octet-stream', fileSize: 20 * 1024 * 1024,
    sha256: 'a'.repeat(64), fileSample: 'AQID', uploadNameType: 'origin' };
const issuedValues = { ...upload, fileType: 'application/pdf', fullId: 'issued-report.pdf', filePath: 'remote-report.pdf',
    channelName: 'HuggingFace_env', repo: 'fixtures/documents', isPrivate: true };
const context = (env, path, body, pending = []) => ({ env, request: new Request(`https://img.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), data: {}, waitUntil(promise) { pending.push(promise.catch(() => {})); } });

describe('server-issued direct upload sessions', () => {
    it('stores only bounded, non-secret session fields with a six-hour expiry', async () => {
        const f = fixture();
        const session = await issueDirectUploadSession(f.env, { ...issuedValues, token: 'must-not-persist', fileSample: 'must-not-persist' });
        assert.ok(session.expiresAt > Date.now());
        assert.equal(f.writes[0].options.expirationTtl, 21600);
        assert.match(f.writes[0].key, /^manage@direct-upload@hf@/);
        assert.equal(session.token, undefined);
        assert.equal(session.fileSample, undefined);
        assert.deepEqual(await getDirectUploadSession(f.env, issuedValues.fullId), session);
    });

    it('requires an unexpired issued session and rejects every changed commit argument', async () => {
        const f = fixture();
        const session = await issueDirectUploadSession(f.env, issuedValues);
        const input = { ...issuedValues, fileType: 'application/octet-stream' };
        assert.equal(validateDirectUploadSession(session, input).ok, true);
        assert.equal(validateDirectUploadSession(null, input).status, 409);
        assert.equal(validateDirectUploadSession(session, input, session.expiresAt).status, 409);
        for (const changed of [{ fullId: 'other.pdf' }, { filePath: 'other.pdf' }, { sha256: 'b'.repeat(64) },
            { fileSize: 1 }, { fileName: 'other.pdf' }, { channelName: 'other' }]) {
            assert.equal(validateDirectUploadSession(session, { ...input, ...changed }).code, 'DIRECT_UPLOAD_SESSION_MISMATCH');
        }
    });

    it('rejects repository/privacy/channel drift while permitting credential rotation', () => {
        const channel = { name: issuedValues.channelName, repo: issuedValues.repo, isPrivate: true, token: 'rotated-token' };
        assert.equal(validateDirectUploadChannel(issuedValues, channel).ok, true);
        for (const changed of [null, { ...channel, repo: 'fixtures/other' }, { ...channel, isPrivate: false }, { ...channel, name: 'renamed' }]) {
            assert.equal(validateDirectUploadChannel(issuedValues, changed).code, 'DIRECT_UPLOAD_CHANNEL_CHANGED');
        }
    });

    it('retains a completed receipt for idempotent, non-cacheable client retries', async () => {
        const f = fixture();
        const session = await issueDirectUploadSession(f.env, issuedValues);
        await completeDirectUploadSession(f.env, session, { success: true, src: '/file/issued-report.pdf' });
        const stored = await getDirectUploadSession(f.env, session.fullId);
        assert.equal(stored.response.success, true);
        const response = await commitUpload(context(f.env, '/api/huggingface/commitUpload', issuedValues));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).src, '/file/issued-report.pdf');
    });

    it('does not allow an upload-only caller to commit arbitrary unissued file IDs', async () => {
        const f = fixture();
        const response = await commitUpload(context(f.env, '/api/huggingface/commitUpload', issuedValues));
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'DIRECT_UPLOAD_SESSION_REQUIRED');
        assert.equal(f.writes.length, 0);
    });

    it('requires HTTPS, the exact completion endpoint and no embedded credentials or port', () => {
        assert.equal(isValidCompletionTarget(new URL('https://huggingface.co/api/complete_multipart')), true);
        for (const raw of ['http://huggingface.co/api/complete_multipart', 'https://user:password@huggingface.co/api/complete_multipart',
            'https://huggingface.co:8443/api/complete_multipart', 'https://huggingface.co.evil.example/api/complete_multipart',
            'https://huggingface.co/api/complete_multipart#fragment']) {
            assert.equal(isValidCompletionTarget(new URL(raw)), false);
        }
    });

    it('keeps a stored repository stable while resolving current credentials from configuration', async () => {
        const f = fixture();
        f.env.HF_REPO = 'fixtures/new-repository';
        const metadata = { Channel: 'HuggingFace', ChannelName: 'HuggingFace_env', HfObjectRepo: 'fixtures/documents', HfObjectPrivate: true };
        const credentials = await resolveHuggingFaceCredentials(f.env.img_url, f.env, metadata);
        assert.equal(credentials.repo, 'fixtures/documents');
        assert.equal(credentials.token, 'fixture-token');
        assert.equal((await resolveHfChannelConfig(f.env, metadata)).repo, 'fixtures/documents');
    });
});

describe('direct upload API policy integration', () => {
    const originalGet = HuggingFaceAPI.prototype.getLfsUploadInfo;
    const originalCommit = HuggingFaceAPI.prototype.commitLfsFile;
    let getCalls;
    let commitCalls;
    beforeEach(() => {
        getCalls = []; commitCalls = [];
        HuggingFaceAPI.prototype.getLfsUploadInfo = async function (...args) { getCalls.push(args); return { needsLfs: true, alreadyExists: true }; };
        HuggingFaceAPI.prototype.commitLfsFile = async function (...args) { commitCalls.push(args); return { ok: true }; };
    });
    afterEach(() => {
        HuggingFaceAPI.prototype.getLfsUploadInfo = originalGet;
        HuggingFaceAPI.prototype.commitLfsFile = originalCommit;
    });

    it('issues and commits large arbitrary-type direct uploads despite restrictive obsolete settings', async () => {
        const f = fixture();
        Object.assign(f.env, { UPLOAD_MAX_SINGLE_BYTES: '1', UPLOAD_MAX_TOTAL_BYTES: '1', UPLOAD_MAX_CHUNK_BYTES: '1',
            UPLOAD_ALLOWED_EXTENSIONS: 'png', UPLOAD_ALLOWED_MIME_TYPES: 'image/png' });
        const large = { ...upload, fileName: 'archive.unknown', fileType: 'application/x-custom', fileSize: 4 * 1024 ** 3 };
        const response = await getUploadUrl(context(f.env, '/api/huggingface/getUploadUrl', large));
        assert.equal(response.status, 200);
        const issued = await response.json();
        assert.equal(getCalls.length, 1);
        assert.equal(getCalls[0][0], large.fileSize);
        const session = await getDirectUploadSession(f.env, issued.fullId);
        assert.equal(session.fileSize, large.fileSize);
        const pending = [];
        const completed = await commitUpload(context(f.env, '/api/huggingface/commitUpload', { ...large, ...issued }, pending));
        assert.equal(completed.status, 200);
        assert.equal(commitCalls.length, 1);
        assert.equal(f.records.get(issued.fullId).metadata.FileSizeBytes, large.fileSize);
        await Promise.all(pending);
    });

    it('rejects invalid hash/sample values before issuing a provider URL', async () => {
        const f = fixture();
        for (const invalid of [{ sha256: '../invalid' }, { fileSample: 'not base64!' }]) {
            assert.equal((await getUploadUrl(context(f.env, '/api/huggingface/getUploadUrl', { ...upload, ...invalid }))).status, 400);
        }
        assert.equal(getCalls.length, 0);
    });

    it('gives concurrent origin-name initializations independent IDs and commit sessions', async () => {
        const f = fixture();
        const results = await Promise.all([getUploadUrl(context(f.env, '/api/huggingface/getUploadUrl', upload)), getUploadUrl(context(f.env, '/api/huggingface/getUploadUrl', upload))]);
        assert.deepEqual(results.map(response => response.status), [200, 200]);
        const [first, second] = await Promise.all(results.map(response => response.json()));
        assert.notEqual(first.fullId, second.fullId);
        assert.equal(first.fullId, first.filePath);
        const a = await getDirectUploadSession(f.env, first.fullId);
        const b = await getDirectUploadSession(f.env, second.fullId);
        assert.equal(validateDirectUploadSession(a, { ...upload, ...first }).ok, true);
        assert.equal(validateDirectUploadSession(b, { ...upload, ...second }).ok, true);
        assert.equal(a.fileName, 'report.pdf');
        assert.equal(a.fileType, 'application/pdf');
    });

    it('rejects a changed repository before the remote commit call', async () => {
        const f = fixture();
        const issued = await (await getUploadUrl(context(f.env, '/api/huggingface/getUploadUrl', upload))).json();
        f.env.HF_REPO = 'fixtures/other';
        const response = await commitUpload(context(f.env, '/api/huggingface/commitUpload', { ...upload, ...issued }));
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'DIRECT_UPLOAD_CHANNEL_CHANGED');
        assert.equal(commitCalls.length, 0);
    });

    it('persists canonical file MIME, byte size and repository identity after a valid commit', async () => {
        const f = fixture();
        const pending = [];
        const issued = await (await getUploadUrl(context(f.env, '/api/huggingface/getUploadUrl', upload))).json();
        const response = await commitUpload(context(f.env, '/api/huggingface/commitUpload', { ...upload, ...issued }, pending));
        assert.equal(response.status, 200);
        assert.equal(commitCalls.length, 1);
        const metadata = f.records.get(issued.fullId).metadata;
        assert.equal(metadata.FileType, 'application/pdf');
        assert.equal(metadata.FileSizeBytes, upload.fileSize);
        assert.equal(metadata.HfObjectRepo, f.env.HF_REPO);
        assert.equal(metadata.HfObjectPrivate, true);
        assert.equal(metadata.HfToken, undefined);
        await Promise.all(pending);
    });
});
