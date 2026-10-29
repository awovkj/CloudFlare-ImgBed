import { limitRequestBody, isRequestBodyTooLargeError } from '../../utils/requestLimits.js';

export const MAX_HF_COMPLETION_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_HF_MULTIPART_PARTS = 10000;
export const MAX_HF_ETAG_LENGTH = 128;
const MAX_COMPLETION_METADATA_BYTES = 64 * 1024;
const MAX_COMPLETION_RESPONSE_BYTES = 64 * 1024;
const COMPLETION_TIMEOUT_MS = 30000;
const RESERVED_METADATA_KEYS = new Set(['oid', 'parts', '__proto__', 'constructor', 'prototype']);

export class MultipartProtocolError extends Error {
    constructor(code, message, status = 400, ambiguous = false) {
        super(message);
        this.name = 'MultipartProtocolError';
        this.code = code;
        this.status = status;
        this.ambiguous = ambiguous;
    }
}

const invalidDescriptor = () => new MultipartProtocolError('INVALID_MULTIPART_DESCRIPTOR', 'Invalid issued multipart upload descriptor');
const integer = value => typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value)) ? Number(value) : NaN;

export function isValidCompletionTarget(targetUrl) {
    return targetUrl?.protocol === 'https:' && targetUrl.hostname === 'huggingface.co'
        && targetUrl.pathname === '/api/complete_multipart'
        && !targetUrl.username && !targetUrl.password && !targetUrl.port && !targetUrl.hash;
}

function validateCompletionMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalidDescriptor();
    const entries = Object.entries(metadata);
    if (entries.length > 32) throw invalidDescriptor();
    for (const [key, value] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) || RESERVED_METADATA_KEYS.has(key.toLowerCase())
            || typeof value !== 'string' || !value || value.length > 8192 || /[\0\r\n]/.test(value)) {
            throw invalidDescriptor();
        }
    }
    if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > MAX_COMPLETION_METADATA_BYTES) throw invalidDescriptor();
    return Object.fromEntries(entries);
}

export function validateIssuedMultipartDescriptor(descriptor, fileSize) {
    if (!descriptor || descriptor.schemaVersion !== 1) throw invalidDescriptor();
    let target;
    try { target = new URL(descriptor.completionUrl); } catch { throw invalidDescriptor(); }
    const chunkSize = integer(descriptor.chunkSize);
    const partCount = integer(descriptor.partCount);
    if (!isValidCompletionTarget(target) || !Number.isSafeInteger(chunkSize) || chunkSize < 1
        || !Number.isSafeInteger(partCount) || partCount < 1 || partCount > MAX_HF_MULTIPART_PARTS
        || !Number.isSafeInteger(fileSize) || fileSize < 1 || Math.ceil(fileSize / chunkSize) !== partCount) {
        throw invalidDescriptor();
    }
    return { schemaVersion: 1, completionUrl: target.href, chunkSize, partCount,
        metadata: validateCompletionMetadata(descriptor.metadata) };
}

// Part URLs are sent to the browser, but never retained in the protected session.
export function extractIssuedMultipartDescriptor(uploadInfo, fileSize, oid) {
    const action = uploadInfo?.uploadAction;
    const header = action?.header;
    const multipart = uploadInfo?.isMultipart === true || (header && Object.hasOwn(header, 'chunk_size'));
    if (!multipart) return null;
    if (!header || typeof header !== 'object' || Array.isArray(header) || uploadInfo.alreadyExists
        || (uploadInfo.oid !== undefined && String(uploadInfo.oid).toLowerCase() !== oid)) throw invalidDescriptor();
    const chunkSize = integer(header.chunk_size);
    const partCount = Math.ceil(fileSize / chunkSize);
    if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > MAX_HF_MULTIPART_PARTS) throw invalidDescriptor();
    const partKeys = Object.keys(header).filter(key => /^\d+$/.test(key));
    if (partKeys.length !== partCount) throw invalidDescriptor();
    for (let number = 1; number <= partCount; number++) {
        const value = header[String(number)];
        if (typeof value !== 'string' || value.length > 16384) throw invalidDescriptor();
        let partUrl;
        try { partUrl = new URL(value); } catch { throw invalidDescriptor(); }
        if (partUrl.protocol !== 'https:' || partUrl.username || partUrl.password) throw invalidDescriptor();
    }
    const metadata = Object.fromEntries(Object.entries(header).filter(([key, value]) =>
        !/^\d+$/.test(key) && key !== 'chunk_size' && typeof value === 'string' && value));
    return validateIssuedMultipartDescriptor({ schemaVersion: 1, completionUrl: action.href,
        chunkSize, partCount, metadata }, fileSize);
}

export function validateMultipartOid(oid, expectedOid) {
    if (typeof oid !== 'string' || !/^[a-f0-9]{64}$/i.test(oid)
        || (expectedOid && oid.toLowerCase() !== expectedOid.toLowerCase())) {
        throw new MultipartProtocolError('INVALID_MULTIPART_OID', 'Multipart object hash does not match the issued upload');
    }
    return oid.toLowerCase();
}

/**
 * @param {unknown} oid
 * @param {unknown} parts
 * @param {{expectedOid?: string, expectedCount?: number}} [options]
 * @returns {{partNumber: number, etag: string}[]}
 */
export function validateMultipartParts(oid, parts, { expectedOid, expectedCount } = {}) {
    validateMultipartOid(oid, expectedOid);
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_HF_MULTIPART_PARTS
        || (expectedCount !== undefined && parts.length !== expectedCount)) {
        throw new MultipartProtocolError('INVALID_MULTIPART_PARTS', 'All issued multipart parts are required');
    }
    const seen = new Set();
    const normalized = parts.map(part => {
        const partNumber = integer(part?.partNumber);
        if (!part || typeof part !== 'object' || Array.isArray(part) || !Number.isSafeInteger(partNumber)
            || partNumber < 1 || partNumber > parts.length || seen.has(partNumber)
            || typeof part.etag !== 'string' || part.etag.length > MAX_HF_ETAG_LENGTH || !/^[\x21-\x7E]+$/.test(part.etag)) {
            throw new MultipartProtocolError('INVALID_MULTIPART_PARTS', 'Multipart part numbers must be unique and ETags must be bounded printable ASCII');
        }
        seen.add(partNumber);
        return { partNumber, etag: part.etag };
    });
    return normalized.sort((a, b) => a.partNumber - b.partNumber);
}

export async function readHfJsonBody(request, maxBytes = MAX_HF_COMPLETION_BODY_BYTES) {
    try {
        const body = await limitRequestBody(request, maxBytes).json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON object');
        return body;
    } catch (error) {
        if (isRequestBodyTooLargeError(error)) throw error;
        throw new MultipartProtocolError('INVALID_REQUEST_BODY', 'A JSON object is required');
    }
}

async function consumeBoundedResponse(response, signal) {
    if (!response.body) return;
    const reader = response.body.getReader();
    let received = 0;
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    const onAbort = () => {
        rejectAborted(new Error('Multipart completion response timed out'));
        reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        if (signal.aborted) throw new Error('Multipart completion response timed out');
        while (true) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (signal.aborted) throw new Error('Multipart completion response timed out');
            if (done) return;
            received += value.byteLength;
            if (received > MAX_COMPLETION_RESPONSE_BYTES) throw new Error('Multipart completion response is too large');
        }
    } finally {
        signal.removeEventListener('abort', onAbort);
        reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export async function postIssuedMultipartCompletion(descriptor, oid, parts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
    try {
        const response = await fetch(descriptor.completionUrl, {
            method: 'POST', redirect: 'manual', signal: controller.signal,
            headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
            body: JSON.stringify({ ...descriptor.metadata, oid, parts }),
        });
        if (![200, 201, 204].includes(response.status)) {
            response.body?.cancel().catch(() => {});
            const definiteRejection = [400, 401, 403, 405, 413, 415, 422].includes(response.status);
            throw new MultipartProtocolError('MULTIPART_COMPLETION_FAILED', 'Multipart completion failed', 502, !definiteRejection);
        }
        await consumeBoundedResponse(response, controller.signal);
    } catch (error) {
        if (error instanceof MultipartProtocolError) throw error;
        throw new MultipartProtocolError('MULTIPART_COMPLETION_UNCERTAIN', 'Multipart completion could not be confirmed; retry to check the uploaded object', 502, true);
    } finally {
        clearTimeout(timeout);
    }
}
