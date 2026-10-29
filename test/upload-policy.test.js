import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    DEFAULT_UPLOAD_LIMITS, createUploadPolicyResponse, getUploadLimits, normalizeUploadChannel,
    validateChunkUploadLayout, validateCompletedChunks, validateMergedUploadSize,
    validateUploadChunk, validateUploadFile, validateUploadSessionBinding,
} from '../functions/upload/uploadPolicy.js';
import { validateChunkInitialization, validateChunkRequest } from '../functions/upload/chunkProtocol.js';
import { handleChunkUpload, initializeChunkedUpload } from '../functions/upload/chunkUpload.js';
import { handleChunkMerge } from '../functions/upload/chunkMerge.js';
import { createUploadSessionCoordinator } from '../functions/upload/mergeSessionStore.js';
import { limitRequestBody } from '../functions/utils/requestLimits.js';
import { onRequest as uploadRequest } from '../functions/upload/index.js';
import { DiscordAPI } from '../functions/utils/discordAPI.js';

const MIB = 1024 * 1024;
const LEGACY_POLICY = { UPLOAD_ALLOW_LEGACY_CHUNKS: 'true' };
const RESTRICTIVE_OLD_POLICY = { UPLOAD_MAX_SINGLE_BYTES: '1', UPLOAD_MAX_TOTAL_BYTES: '1',
    UPLOAD_MAX_CHUNK_BYTES: '1', UPLOAD_ALLOWED_EXTENSIONS: 'png', UPLOAD_ALLOWED_MIME_TYPES: 'image/png' };

function session(overrides = {}) {
    return {
        uploadId: 'upload-test', originalFileName: 'report.pdf', originalFileType: 'application/pdf',
        totalChunks: 2, uploadChannel: 'telegram', status: 'initialized', revision: 0,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000, ...overrides,
    };
}

function makeKV(initial = {}) {
    const records = new Map(Object.entries(initial));
    const writes = [];
    return {
        records, writes,
        async get(key) { return records.get(key)?.value ?? null; },
        async getWithMetadata(key) { return records.get(key) || { value: null, metadata: null }; },
        async put(key, value, options = {}) {
            writes.push({ key, value, options });
            records.set(key, { value, metadata: options.metadata || null });
        },
        async delete(key) { records.delete(key); },
        async list({ prefix = '' } = {}) {
            return { list_complete: true, keys: [...records].filter(([key]) => key.startsWith(prefix)).map(([name, record]) => ({ name, metadata: record.metadata })) };
        },
    };
}

function context(fields, info = null, overrides = {}) {
    const img_url = makeKV(info ? { [`upload_session_${info.uploadId}`]: { value: JSON.stringify(info), metadata: null } } : {});
    return {
        env: { img_url }, url: new URL('https://img.example/upload'), data: {},
        request: { headers: new Headers(), async formData() { return { get(name) { return fields[name] ?? null; } }; } },
        uploadConfig: { cfr2: { channels: [{ name: 'R2_env' }], loadBalance: { enabled: false } } },
        securityConfig: { upload: { ipQuery: { enabled: false } } },
        waitUntil() {}, ...overrides,
    };
}

describe('unrestricted file uploads and protocol validation', () => {
    it('has no application size caps and ignores obsolete byte-limit settings', () => {
        assert.deepEqual(getUploadLimits({}), DEFAULT_UPLOAD_LIMITS);
        assert.deepEqual(getUploadLimits(RESTRICTIVE_OLD_POLICY), {
            maxSingleBytes: Infinity, maxTotalBytes: Infinity, maxChunkBytes: Infinity,
        });
    });

    it('does not revive size restrictions through malformed legacy configuration', () => {
        for (const value of ['0', '-1', 'NaN', '1.5', 'Infinity', 'not-a-limit']) {
            const env = { UPLOAD_MAX_SINGLE_BYTES: value, UPLOAD_MAX_TOTAL_BYTES: value, UPLOAD_MAX_CHUNK_BYTES: value };
            assert.deepEqual(getUploadLimits(env), DEFAULT_UPLOAD_LIMITS);
            assert.equal(validateUploadFile({ fileName: 'a.pdf', fileSize: 2 * 1024 ** 3 }, env).ok, true);
        }
    });

    it('keeps general file hosting compatible when no allowlist is configured', () => {
        assert.equal(validateUploadFile({ fileName: 'a.unknown', fileSize: 1 }).ok, true);
        assert.equal(validateUploadFile({ fileName: 'empty.txt', fileSize: 0 }).ok, true);
        assert.equal(validateUploadFile({ fileName: 'REPORT.DOCX', fileType: '', fileSize: 1 }).fileType,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('accepts byte declarations above former ordinary and complete-file caps without allocating those bodies', () => {
        for (const fileSize of [33 * MIB, 2 * 1024 ** 3, 1024 ** 4, Number.MAX_SAFE_INTEGER]) {
            const file = { fileName: 'large.unknown', fileType: 'application/x-custom', fileSize };
            assert.equal(validateUploadFile(file, RESTRICTIVE_OLD_POLICY).ok, true);
            assert.equal(validateUploadFile(file, RESTRICTIVE_OLD_POLICY, { chunked: true }).ok, true);
        }
        assert.equal(validateUploadFile({ fileName: 'a.pdf' }).code, 'INVALID_FILE_SIZE');
        assert.equal(validateUploadFile({ fileName: 'a.pdf' }, {}, { chunked: true, allowUnknownSize: true }).ok, true);
    });

    it('accepts executable, archival and unknown extensions despite obsolete extension allowlists', () => {
        for (const fileName of ['A.PDF', 'archive.tar.gz', 'a.pdf.exe', 'application.unknown', 'README']) {
            assert.equal(validateUploadFile({ fileName, fileSize: 1 }, RESTRICTIVE_OLD_POLICY).ok, true, fileName);
        }
    });

    it('accepts arbitrary MIME families while preserving canonical type normalization', () => {
        for (const fileType of ['application/x-executable', 'application/x-custom', 'text/html', 'application/zip', 'text/plain; charset=utf-8']) {
            assert.equal(validateUploadFile({ fileName: 'a.unknown', fileType, fileSize: 1 }, RESTRICTIVE_OLD_POLICY).ok, true, fileType);
        }
        assert.equal(validateUploadFile({ fileName: 'REPORT.DOCX', fileType: 'application/zip', fileSize: 1 }, RESTRICTIVE_OLD_POLICY).fileType,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('rejects unsafe or missing file names and invalid file sizes', () => {
        for (const fileName of ['', null, 'bad\r\nname.pdf', 'bad\0name.pdf']) {
            assert.equal(validateUploadFile({ fileName, fileSize: 1 }).code, 'INVALID_FILE_NAME');
        }
        for (const fileSize of [null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, '', '1junk']) {
            assert.equal(validateUploadFile({ fileName: 'a.pdf', fileSize }).code, 'INVALID_FILE_SIZE');
        }
    });

    it('returns a structured non-cacheable policy rejection', async () => {
        const response = createUploadPolicyResponse(validateUploadFile({ fileName: '', fileSize: 1 }));
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal((await response.json()).code, 'INVALID_FILE_NAME');
    });
});

describe('strict chunk parameters and actual stored sizes', () => {
    it('rejects absent, fractional, negative, and suffixed chunk indexes', () => {
        for (const chunkIndex of [null, undefined, '', ' ', '1junk', '1e0', '0x0', -1, 1.5, false]) {
            assert.equal(validateChunkRequest({ chunkIndex, totalChunks: '2' }).ok, false, String(chunkIndex));
        }
        assert.deepEqual(validateChunkRequest({ chunkIndex: '0', totalChunks: '2' }), { ok: true, chunkIndex: 0, totalChunks: 2 });
        assert.equal(validateChunkRequest({ chunkIndex: '2', totalChunks: '2' }).code, 'INVALID_CHUNK_INDEX');
    });

    it('rejects malformed initialization while retaining optional legacy size fields', () => {
        assert.equal(validateChunkInitialization({ totalChunks: '2' }).ok, true);
        for (const totalChunks of [null, '', '2junk', '2.0', '1e2', 10001]) {
            assert.equal(validateChunkInitialization({ totalChunks }).ok, false);
        }
        assert.equal(validateChunkInitialization({ totalChunks: '2', fileSize: '9', chunkSize: '4' }).code, 'INVALID_CHUNK_LAYOUT');
    });

    it('accepts large declared files and parts while retaining provider multipart minimums', () => {
        assert.equal(validateChunkUploadLayout(session({ fileSize: 1024 * MIB + 1, chunkSize: 25 * MIB, totalChunks: 41 }), RESTRICTIVE_OLD_POLICY).ok, true);
        assert.equal(validateChunkUploadLayout(session({ fileSize: 2 * (25 * MIB + 1), chunkSize: 25 * MIB + 1 }), RESTRICTIVE_OLD_POLICY).ok, true);
        assert.equal(validateChunkUploadLayout(session({ totalChunks: 10000, fileSize: 10000 * 20 * MIB, chunkSize: 20 * MIB }), RESTRICTIVE_OLD_POLICY).ok, true);
        assert.equal(validateChunkUploadLayout(session({ uploadChannel: 'cfr2', fileSize: 2 * MIB, chunkSize: MIB })).code, 'MULTIPART_PART_TOO_SMALL');
    });

    it('requires both size declarations by default for exact session integrity', () => {
        for (const info of [session({ totalChunks: 10000 }), session({ fileSize: 10 }), session({ chunkSize: 5 })]) {
            for (const env of [{}, { UPLOAD_ALLOW_LEGACY_CHUNKS: 'false' }, { UPLOAD_ALLOW_LEGACY_CHUNKS: 'TRUE' }]) {
                assert.equal(validateChunkUploadLayout(info, env).code, 'CHUNK_SIZE_DECLARATIONS_REQUIRED');
            }
        }
        assert.equal(validateUploadChunk(session(), 0, 1).code, 'CHUNK_SIZE_DECLARATIONS_REQUIRED');
        assert.equal(validateMergedUploadSize(session(), 1).code, 'CHUNK_SIZE_DECLARATIONS_REQUIRED');
    });

    it('matches every part to the declared layout and exact final-part size', () => {
        const info = session({ totalChunks: 3, fileSize: 11, chunkSize: 4 });
        assert.equal(validateUploadChunk(info, 0, 4).ok, true);
        assert.equal(validateUploadChunk(info, 2, 3).ok, true);
        assert.equal(validateUploadChunk(info, 0, 5).code, 'CHUNK_SIZE_MISMATCH');
        assert.equal(validateUploadChunk(info, 2, 4).code, 'CHUNK_SIZE_MISMATCH');
    });

    it('supports legacy sessions only with an explicit compatibility flag without capping actual parts', () => {
        assert.equal(validateUploadChunk(session(), 0, 18 * MIB, LEGACY_POLICY).ok, true);
        assert.equal(validateUploadChunk(session(), 1, 64 * MIB, { ...LEGACY_POLICY, ...RESTRICTIVE_OLD_POLICY }).ok, true);
        assert.equal(validateUploadChunk(session(), 1, 0, LEGACY_POLICY).code, 'INVALID_CHUNK_SIZE');
        assert.equal(validateUploadChunk(session({ chunkSize: 4 }), 1, 3, LEGACY_POLICY).ok, true);
        assert.equal(validateUploadChunk(session({ chunkSize: 4 }), 1, 5, LEGACY_POLICY).code, 'CHUNK_SIZE_MISMATCH');
    });

    it('allows a small last R2/S3 part, but not a small non-final part', () => {
        assert.equal(validateUploadChunk(session({ uploadChannel: 'CloudflareR2', fileSize: 5 * MIB + 1, chunkSize: 5 * MIB }), 0, MIB).code, 'MULTIPART_PART_TOO_SMALL');
        assert.equal(validateUploadChunk(session({ uploadChannel: 's3', fileSize: 5 * MIB + 1, chunkSize: 5 * MIB }), 1, 1).ok, true);
    });

    it('binds session MIME and storage channel while accepting provider aliases', () => {
        assert.equal(normalizeUploadChannel('CloudflareR2'), 'cfr2');
        assert.equal(normalizeUploadChannel('TelegramNew'), 'telegram');
        const info = session({ uploadChannel: 'CloudflareR2' });
        assert.equal(validateUploadSessionBinding(info, { ...info, uploadChannel: 'cfr2' }).ok, true);
        assert.equal(validateUploadSessionBinding(info, { ...info, uploadChannel: 's3' }).code, 'SESSION_UPLOAD_CHANNEL_MISMATCH');
        const unknown = session({ originalFileName: 'a.custom' });
        assert.equal(validateUploadSessionBinding(unknown, { ...unknown, originalFileType: 'text/html' }).code, 'SESSION_PARAMETERS_MISMATCH');
    });

    it('checks merged actual bytes even for legacy sessions without a size declaration', () => {
        assert.equal(validateMergedUploadSize(session(), 2 * 1024 ** 3, { ...LEGACY_POLICY, ...RESTRICTIVE_OLD_POLICY }).ok, true);
        assert.equal(validateMergedUploadSize(session({ fileSize: 9, chunkSize: 5 }), 8).code, 'MERGED_SIZE_MISMATCH');
        assert.equal(validateMergedUploadSize(session({ fileSize: 9, chunkSize: 5 }), 9).ok, true);
    });

    it('rejects duplicate or missing completed parts without imposing a total byte budget', () => {
        const info = session({ fileSize: 8, chunkSize: 4 });
        const parts = [{ index: 0, uploadResult: { size: 4 } }, { index: 1, uploadResult: { size: '4' } }];
        assert.equal(validateCompletedChunks(info, parts).totalSize, 8);
        assert.equal(validateCompletedChunks(info, [parts[0], parts[0]]).code, 'INVALID_CHUNK_INDEX');
        assert.equal(validateCompletedChunks(info, [parts[0]]).code, 'CHUNKS_INCOMPLETE');
        assert.equal(validateCompletedChunks(session(), parts, { ...LEGACY_POLICY, UPLOAD_MAX_TOTAL_BYTES: '7' }).totalSize, 8);
    });
});

describe('upload handler policy integration', () => {
    it('rejects undeclared initialization but accepts declared files above former caps before provider setup', async () => {
        for (const declared of [false, true]) {
            let created = 0;
            const body = new FormData();
            body.append('originalFileName', 'report.pdf');
            body.append('originalFileType', 'application/octet-stream');
            body.append('totalChunks', '10000');
            if (declared) {
                body.append('fileSize', String(10000 * 25 * MIB));
                body.append('chunkSize', String(25 * MIB));
            }
            const url = new URL('https://img.example/upload?initChunked=true&uploadChannel=cfr2');
            const ctx = context({}, null, { url, request: new Request(url, { method: 'POST', body }) });
            Object.assign(ctx.env, RESTRICTIVE_OLD_POLICY);
            ctx.env.img_r2 = {
                async createMultipartUpload() { created++; return { uploadId: 'fixture-multipart' }; },
                resumeMultipartUpload() { return { async abort() {} }; },
            };
            const response = await initializeChunkedUpload(ctx);
            assert.equal(response.status, declared ? 200 : 400);
            const payload = await response.json();
            assert.equal(created, declared ? 1 : 0);
            if (declared) {
                assert.equal(payload.success, true);
                const stored = JSON.parse(ctx.env.img_url.writes.find(write => write.key.startsWith('upload_session_')).value);
                assert.equal(stored.fileSize, 10000 * 25 * MIB);
                assert.equal(stored.chunkSize, 25 * MIB);
            } else {
                assert.equal(payload.code, 'CHUNK_SIZE_DECLARATIONS_REQUIRED');
                assert.equal(ctx.env.img_url.writes.length, 0);
            }
        }
    });

    it('rejects raw chunks for a legacy session by default before touching remote storage', async () => {
        const info = session({ uploadChannel: 'cfr2', totalChunks: 10000 });
        const body = new FormData();
        body.append('file', new Blob(['x']), 'report.pdf.part000');
        body.append('chunkIndex', '0');
        body.append('totalChunks', String(info.totalChunks));
        body.append('uploadId', info.uploadId);
        body.append('originalFileName', info.originalFileName);
        body.append('originalFileType', 'application/pdf');
        const url = new URL('https://img.example/upload?chunked=true&uploadChannel=cfr2');
        const ctx = context({}, info, { url, request: new Request(url, { method: 'POST', body }) });
        let touched = 0;
        ctx.env.img_r2 = {
            async createMultipartUpload() { touched++; throw new Error('must not create'); },
            resumeMultipartUpload() { touched++; throw new Error('must not resume'); },
        };
        const response = await handleChunkUpload(ctx);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'CHUNK_SIZE_DECLARATIONS_REQUIRED');
        assert.equal(touched, 0);
        assert.equal(ctx.env.img_url.writes.length, 0);
    });

    it('rejects a legacy merge before querying its 10000 stored part records', async () => {
        const info = session({ uploadChannel: 'cfr2', totalChunks: 10000 });
        const body = new FormData();
        body.append('uploadId', info.uploadId);
        body.append('totalChunks', String(info.totalChunks));
        body.append('originalFileName', info.originalFileName);
        body.append('originalFileType', 'application/pdf');
        const url = new URL('https://img.example/upload?chunked=true&merge=true&uploadChannel=cfr2');
        const ctx = context({}, info, { url, request: new Request(url, { method: 'POST', body }) });
        let reads = 0;
        ctx.env.img_url.getWithMetadata = async () => { reads++; throw new Error('must not read part records'); };
        const response = await handleChunkMerge(ctx);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'CHUNK_SIZE_DECLARATIONS_REQUIRED');
        assert.equal(reads, 0);
        assert.equal(ctx.env.img_url.writes.length, 0);
    });

    it('rejects an actual part-size mismatch before arrayBuffer allocation or storage writes', async () => {
        let read = false;
        const info = session({ fileSize: 50 * MIB, chunkSize: 25 * MIB });
        const ctx = context({
            file: { size: 25 * MIB + 1, async arrayBuffer() { read = true; throw new Error('must not allocate'); } },
            chunkIndex: '0', totalChunks: '2', uploadId: info.uploadId,
            originalFileName: info.originalFileName, originalFileType: '',
        }, info);
        const response = await handleChunkUpload(ctx);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'CHUNK_SIZE_MISMATCH');
        assert.equal(read, false);
        assert.equal(ctx.env.img_url.writes.length, 0);
    });

    it('rejects missing chunkIndex instead of treating it as chunk zero', async () => {
        const ctx = context({ file: { size: 1, async arrayBuffer() {} }, totalChunks: '2' });
        const response = await handleChunkUpload(ctx);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'INVALID_CHUNK_INDEX');
    });

    it('writes canonical PDF MIME to newly created R2 multipart state', async () => {
        let options;
        const ctx = context({ originalFileName: 'report.pdf', originalFileType: '', totalChunks: '2', fileSize: String(6 * MIB), chunkSize: String(5 * MIB) });
        ctx.url.searchParams.set('uploadChannel', 'cfr2');
        ctx.env.img_r2 = {
            async createMultipartUpload(key, supplied) { options = supplied; return { uploadId: 'r2-multipart', key }; },
            resumeMultipartUpload() { return { async abort() {} }; },
        };
        const response = await initializeChunkedUpload(ctx);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).success, true);
        assert.equal(options.httpMetadata.contentType, 'application/pdf');
        const record = ctx.env.img_url.writes.find(write => write.key.startsWith('upload_session_'));
        assert.equal(JSON.parse(record.value).originalFileType, 'application/pdf');
        assert.equal(record.options.expirationTtl, 6 * 60 * 60);
    });

    it('completes declared large R2 parts despite obsolete total and per-part limits', async () => {
        const info = session({ uploadChannel: 'cfr2', fileSize: 128 * MIB, chunkSize: 64 * MIB });
        const ctx = context({ uploadId: info.uploadId, totalChunks: '2', originalFileName: info.originalFileName, originalFileType: '' }, info);
        Object.assign(ctx.env, RESTRICTIVE_OLD_POLICY);
        let completed = false;
        ctx.env.img_r2 = { resumeMultipartUpload() { return { async complete() { completed = true; } }; } };
        ctx.env.img_url.records.set(`multipart_${info.uploadId}`, {
            value: JSON.stringify({ key: 'merged-report.pdf', uploadId: 'fixture-multipart' }), metadata: null,
        });
        for (let index = 0; index < 2; index++) {
            ctx.env.img_url.records.set(`chunk_${info.uploadId}_${String(index).padStart(3, '0')}`, {
                value: '', metadata: { status: 'completed', uploadResult: { success: true, size: 64 * MIB, partNumber: index + 1, etag: `etag-${index}` } },
            });
        }
        const response = await handleChunkMerge(ctx);
        assert.equal(response.status, 200);
        assert.equal(completed, true);
        assert.equal(ctx.env.img_url.records.get('merged-report.pdf').metadata.FileSizeBytes, info.fileSize);
    });

    it('lets a normal Discord upload above its former assumed cap reach the provider without giant allocation', async () => {
        const file = { name: 'application.exe', type: 'application/x-custom', size: 64 * MIB,
            async arrayBuffer() { throw new Error('the stubbed provider must not allocate the declared file'); } };
        const ctx = context({ file });
        ctx.url.searchParams.set('uploadChannel', 'discord');
        ctx.request.url = ctx.url.toString();
        ctx.request.method = 'POST';
        Object.assign(ctx.env, RESTRICTIVE_OLD_POLICY, { DISCORD_BOT_TOKEN: 'fixture-token', DISCORD_CHANNEL_ID: 'fixture-channel' });
        const original = DiscordAPI.prototype.sendFile;
        const pending = [];
        ctx.waitUntil = promise => pending.push(promise);
        let sent = 0;
        DiscordAPI.prototype.sendFile = async (provided, channelId) => {
            sent++;
            assert.equal(provided, file);
            assert.equal(channelId, 'fixture-channel');
            return { id: 'fixture-message', attachments: [{ id: 'fixture-attachment', filename: file.name,
                size: file.size, content_type: file.type, url: 'https://cdn.discordapp.com/fixture/file' }] };
        };
        try {
            const response = await uploadRequest(ctx);
            assert.equal(response.status, 200);
            assert.equal(sent, 1);
            assert.ok(ctx.env.img_url.writes.some(write => write.options.metadata?.FileSizeBytes === file.size));
            await Promise.all(pending);
        } finally { DiscordAPI.prototype.sendFile = original; }
    });

    it('returns 413 for bounded form-data stream failures in all chunk handlers', async () => {
        for (const handler of [initializeChunkedUpload, handleChunkUpload, handleChunkMerge]) {
            const body = new FormData();
            body.append('originalFileName', 'report.pdf');
            const request = limitRequestBody(new Request('https://img.example/upload', { method: 'POST', body }), 1);
            const ctx = context({}, null, { request });
            const response = await handler(ctx);
            assert.equal(response.status, 413, handler.name);
            assert.equal((await response.json()).code, 'REQUEST_BODY_TOO_LARGE');
        }
    });

    it('redacts upstream errors while preserving the terminal merge failure code', async () => {
        const previous = console.error;
        console.error = () => {};
        try {
            for (const handler of [handleChunkUpload, handleChunkMerge]) {
                const ctx = context({}, null, { request: { async formData() { throw new Error('private-storage-endpoint token=private-value'); } } });
                const response = await handler(ctx);
                assert.equal(response.status, 500);
                const text = await response.text();
                assert.doesNotMatch(text, /private-storage-endpoint|private-value|errorStack/);
                const payload = JSON.parse(text);
                assert.ok(payload.requestId);
                if (handler === handleChunkMerge) assert.equal(payload.code, 'MERGE_FAILED');
            }
        } finally {
            console.error = previous;
        }
    });

    it('keeps normal-upload declaration validation before R2 writes and preserves MIME metadata', () => {
        const source = fs.readFileSync('functions/upload/index.js', 'utf8');
        assert.ok(source.indexOf('const policy = validateUploadFile') < source.indexOf('await R2DataBase.put'));
        assert.match(source, /httpMetadata: \{ contentType: metadata\.FileType \}/);
        assert.match(fs.readFileSync('functions/upload/chunkUpload.js', 'utf8'), /CHUNK_STATUS_CONCURRENCY = 2/);
        assert.match(fs.readFileSync('functions/upload/chunkMerge.js', 'utf8'), /MERGE_RETRY_CONCURRENCY = 2/);
    });
});

describe('merge session persistence TTL', () => {
    it('preserves remaining six-hour and chat-session lifetimes', async () => {
        const now = 100000;
        for (const seconds of [6 * 60 * 60, 24 * 60 * 60]) {
            const db = makeKV();
            const coordinator = createUploadSessionCoordinator(db, 'upload-test', session({ expiresAt: now + seconds * 1000 }), () => now);
            assert.equal(await coordinator.update({ status: 'merging' }), true);
            assert.equal(db.writes[0].options.expirationTtl, seconds);
        }
    });

    it('uses the KV minimum TTL for near expiry and supports legacy sessions', async () => {
        const now = 100000;
        for (const [expiresAt, expected] of [[now + 1000, 60], [undefined, 3600]]) {
            const db = makeKV();
            const coordinator = createUploadSessionCoordinator(db, 'upload-test', session({ expiresAt }), () => now);
            await coordinator.update({ status: 'merging' });
            assert.equal(db.writes[0].options.expirationTtl, expected);
        }
    });

    it('rejects stale snapshot revisions without pretending KV supports CAS', async () => {
        const db = makeKV();
        const coordinator = createUploadSessionCoordinator(db, 'upload-test', session({ revision: 1 }));
        assert.equal(await coordinator.update({ status: 'merging' }, { expectedRevision: 0 }), false);
        assert.equal(db.writes.length, 0);
    });
});
