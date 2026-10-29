import { normalizeMime, resolveContentType } from '../utils/fileTypes.js';
import { validateChunkInitialization, validateChunkRequest } from './chunkProtocol.js';

const MIB = 1024 * 1024;
const MIN_MULTIPART_PART_BYTES = 5 * MIB;

export const DEFAULT_UPLOAD_LIMITS = Object.freeze({
    maxSingleBytes: Infinity,
    maxTotalBytes: Infinity,
    maxChunkBytes: Infinity,
});

/** @param {string} code @param {string} message @param {number} [status] @returns {{ok: false, status: number, code: string, message: string}} */
function failure(code, message, status = 400) {
    return { ok: false, status, code, message };
}

/** @param {import('../utils/contracts.js').UploadPolicyConfiguration} [env] @returns {import('../utils/contracts.js').UploadLimits} */
export function getUploadLimits(env = {}) {
    // Retain the API for callers, but obsolete size/type settings cannot restrict uploads.
    return { ...DEFAULT_UPLOAD_LIMITS };
}

// Validate protocol fields and canonical MIME, not file quotas or type allowlists.
/**
 * @param {import('../utils/contracts.js').UploadFileInput} [input]
 * @param {import('../utils/contracts.js').UploadPolicyConfiguration} [env]
 * @param {{chunked?: boolean, allowUnknownSize?: boolean}} [options]
 * @returns {import('../utils/contracts.js').UploadPolicyResult}
 */
export function validateUploadFile({ fileName, fileType, fileSize } = {}, env = {}, { chunked = false, allowUnknownSize = false } = {}) {
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 1024 || /[\0\r\n]/.test(fileName)) {
        return failure('INVALID_FILE_NAME', 'A valid file name is required');
    }

    const unknownSize = fileSize === undefined || fileSize === null;
    const size = typeof fileSize === 'number' || (typeof fileSize === 'string' && /^\d+$/.test(fileSize))
        ? Number(fileSize) : NaN;
    if (!(unknownSize && allowUnknownSize)) {
        if (unknownSize || !Number.isSafeInteger(size) || size < 0) {
            return failure('INVALID_FILE_SIZE', 'File size must be a non-negative integer');
        }
    }

    const normalizedType = resolveContentType(fileName, fileType);
    return { ok: true, fileType: normalizedType };
}

export function normalizeUploadChannel(channel = '') {
    const name = String(channel).trim().toLowerCase();
    return ({ telegramnew: 'telegram', cloudflarer2: 'cfr2', r2: 'cfr2' })[name] || name;
}

export function validateChunkUploadLayout(session, env = {}) {
    const layout = validateChunkInitialization(session);
    if (!layout.ok) return failure(layout.code, 'Invalid chunk upload layout');
    // Declarations bind the exact file layout; they are not an application size quota.
    const allowLegacy = env.UPLOAD_ALLOW_LEGACY_CHUNKS === 'true';
    if (!allowLegacy && (layout.fileSize === undefined || layout.chunkSize === undefined)) {
        return failure('CHUNK_SIZE_DECLARATIONS_REQUIRED', 'fileSize and chunkSize are required; upgrade the upload client');
    }
    const file = validateUploadFile({
        fileName: session.originalFileName,
        fileType: session.originalFileType,
        fileSize: session.fileSize,
    }, env, { chunked: true, allowUnknownSize: allowLegacy });
    if (!file.ok) return file;
    if (layout.chunkSize !== undefined) {
        const channel = normalizeUploadChannel(session.uploadChannel);
        if (layout.totalChunks > 1 && ['cfr2', 's3'].includes(channel) && layout.chunkSize < MIN_MULTIPART_PART_BYTES) {
            return failure('MULTIPART_PART_TOO_SMALL', 'R2/S3 multipart parts except the last must be at least 5 MiB');
        }
    }
    return { ok: true, fileType: file.fileType };
}

export function validateUploadSessionBinding(session, incoming) {
    if (session.originalFileName !== incoming.originalFileName || session.totalChunks !== incoming.totalChunks
        || normalizeMime(resolveContentType(session.originalFileName, session.originalFileType))
            !== normalizeMime(resolveContentType(incoming.originalFileName, incoming.originalFileType))) {
        return failure('SESSION_PARAMETERS_MISMATCH', 'Upload session parameters do not match');
    }
    if (incoming.uploadChannel && normalizeUploadChannel(incoming.uploadChannel) !== normalizeUploadChannel(session.uploadChannel || 'telegram')) {
        return failure('SESSION_UPLOAD_CHANNEL_MISMATCH', 'An upload session cannot change storage channel');
    }
    return { ok: true };
}

export function validateUploadChunk(session, chunkIndex, actualSize, env = {}) {
    const request = validateChunkRequest({ chunkIndex, totalChunks: session.totalChunks });
    if (!request.ok) return failure(request.code, 'Invalid chunk request');
    const layout = validateChunkUploadLayout(session, env);
    if (!layout.ok) return layout;
    if (!Number.isSafeInteger(actualSize) || actualSize < 1) return failure('INVALID_CHUNK_SIZE', 'Chunk must contain file data');

    const lastPart = chunkIndex === session.totalChunks - 1;
    if (!lastPart && ['cfr2', 's3'].includes(normalizeUploadChannel(session.uploadChannel)) && actualSize < MIN_MULTIPART_PART_BYTES) {
        return failure('MULTIPART_PART_TOO_SMALL', 'R2/S3 multipart parts except the last must be at least 5 MiB');
    }
    if (session.fileSize !== undefined && actualSize > Number(session.fileSize)) {
        return failure('CHUNK_SIZE_MISMATCH', 'Chunk exceeds the declared file size');
    }
    if (session.chunkSize !== undefined) {
        const chunkSize = Number(session.chunkSize);
        const expected = lastPart && session.fileSize !== undefined
            ? Number(session.fileSize) - chunkSize * (session.totalChunks - 1)
            : chunkSize;
        if ((!lastPart || session.fileSize !== undefined) ? actualSize !== expected : actualSize > expected) {
            return failure('CHUNK_SIZE_MISMATCH', 'Chunk size does not match the declared layout');
        }
    } else if (session.totalChunks === 1 && session.fileSize !== undefined && actualSize !== Number(session.fileSize)) {
        return failure('CHUNK_SIZE_MISMATCH', 'Chunk size does not match the declared file size');
    }
    return { ok: true };
}

export function validateMergedUploadSize(session, actualSize, env = {}) {
    const layout = validateChunkUploadLayout(session, env);
    if (!layout.ok) return layout;
    const file = validateUploadFile({
        fileName: session.originalFileName,
        fileType: session.originalFileType,
        fileSize: actualSize,
    }, env, { chunked: true });
    if (!file.ok) return file;
    if (session.fileSize !== undefined && Number(session.fileSize) !== actualSize) {
        return failure('MERGED_SIZE_MISMATCH', 'Uploaded bytes do not match the declared file size');
    }
    return { ok: true, fileType: file.fileType, totalSize: actualSize };
}

export function validateCompletedChunks(session, chunks, env = {}) {
    if (!Array.isArray(chunks) || chunks.length !== session.totalChunks) {
        return failure('CHUNKS_INCOMPLETE', 'All chunks are required before completing the upload');
    }
    const seen = new Set();
    let totalSize = 0;
    for (const chunk of chunks) {
        if (seen.has(chunk.index)) return failure('INVALID_CHUNK_INDEX', 'Duplicate chunk index');
        seen.add(chunk.index);
        const actualSize = Number(chunk.uploadResult?.size);
        const policy = validateUploadChunk(session, chunk.index, actualSize, env);
        if (!policy.ok) return policy;
        totalSize += actualSize;
    }
    return validateMergedUploadSize(session, totalSize, env);
}

export function createUploadPolicyResponse(result) {
    return new Response(JSON.stringify({ success: false, code: result.code, message: result.message }), {
        status: result.status || 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}
