import { getDatabase } from '../../utils/databaseAdapter.js';
import { resolveContentType, normalizeMime } from '../../utils/fileTypes.js';
import { MultipartProtocolError, validateIssuedMultipartDescriptor, validateMultipartParts, postIssuedMultipartCompletion } from './multipartProtocol.js';

const SESSION_TTL_SECONDS = 6 * 60 * 60;
const sessionKey = fullId => `manage@direct-upload@hf@${fullId}`;
const completionKey = fullId => `${sessionKey(fullId)}@multipart-completion`;
// Coalescing is per isolate; KV receipts are recovery records, not a distributed mutex.
const completionFlights = new WeakMap();

function remainingTtl(session) {
    return Math.max(60, Math.ceil((session.expiresAt - Date.now()) / 1000));
}

async function digest(value) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Bind commit arguments to a server-issued file ID; upload permission must not allow arbitrary overwrites.
export async function issueDirectUploadSession(env, values) {
    const session = {
        schemaVersion: 2,
        fullId: values.fullId, filePath: values.filePath, fileName: values.fileName,
        fileType: values.fileType, fileSize: values.fileSize, sha256: values.sha256,
        channelName: values.channelName, repo: values.repo, isPrivate: values.isPrivate,
        uploadMode: values.uploadMode || 'basic',
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };
    if (values.multipart) session.multipart = validateIssuedMultipartDescriptor(values.multipart, values.fileSize);
    await getDatabase(env).put(sessionKey(values.fullId), JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
    return session;
}

export async function getDirectUploadSession(env, fullId) {
    const stored = await getDatabase(env).get(sessionKey(fullId));
    return stored ? JSON.parse(stored) : null;
}

export function validateDirectUploadSession(session, input, now = Date.now()) {
    if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= now) {
        return { ok: false, status: 409, code: 'DIRECT_UPLOAD_SESSION_REQUIRED', message: 'Request an upload URL first, or retry after the upload session becomes visible' };
    }
    const mime = normalizeMime(resolveContentType(input.fileName || input.fullId, input.fileType));
    if (session.fullId !== input.fullId || session.filePath !== input.filePath
        || session.sha256 !== String(input.sha256).toLowerCase() || session.fileSize !== Number(input.fileSize)
        || session.fileName !== input.fileName || normalizeMime(session.fileType) !== mime
        || session.channelName !== input.channelName) {
        return { ok: false, status: 400, code: 'DIRECT_UPLOAD_SESSION_MISMATCH', message: 'Commit arguments do not match the issued upload session' };
    }
    return { ok: true };
}

export function validateDirectUploadChannel(session, channel) {
    if (!session || !channel || session.channelName !== channel.name || session.repo !== channel.repo
        || session.isPrivate !== Boolean(channel.isPrivate)) {
        return { ok: false, status: 409, code: 'DIRECT_UPLOAD_CHANNEL_CHANGED', message: 'Upload channel changed; request a new upload URL' };
    }
    return { ok: true };
}

export async function completeDirectUploadSession(env, session, response) {
    await getDatabase(env).put(sessionKey(session.fullId), JSON.stringify({ ...session, response }), { expirationTtl: remainingTtl(session) });
}

function assertCompletionRecord(record, session, descriptorDigest, partsDigest) {
    if (!record || !['completing', 'completed'].includes(record.status) || record.oid !== session.sha256
        || record.descriptorDigest !== descriptorDigest || record.partCount !== session.multipart.partCount
        || !/^[a-f0-9]{64}$/.test(record.partsDigest)
        || (partsDigest && record.partsDigest !== partsDigest)) {
        throw new MultipartProtocolError('MULTIPART_COMPLETION_MISMATCH', 'Multipart completion does not match the issued upload', 409);
    }
    if (record.status === 'completed' && (!Number.isFinite(record.completedAt) || record.completedAt <= 0)) {
        throw new MultipartProtocolError('MULTIPART_COMPLETION_MISMATCH', 'Invalid stored multipart completion receipt', 409);
    }
}

async function runMultipartCompletion(env, session, descriptor, descriptorDigest, parts, partsDigest, provider) {
    const db = getDatabase(env);
    const key = completionKey(session.fullId);
    const stored = await db.get(key);
    const previous = stored ? JSON.parse(stored) : session.multipartCompletion;
    if (previous) {
        assertCompletionRecord(previous, session, descriptorDigest, partsDigest);
        if (previous.status === 'completed') return previous;
        // A timeout or receipt-write failure may follow a successful remote completion.
        // Probe the LFS object before doing anything else; never blindly repeat an ambiguous POST.
        const batch = await provider.lfsBatch(session.sha256, session.fileSize);
        const object = batch?.objects?.[0];
        if (!object || object.error || object.oid !== session.sha256 || Number(object.size) !== session.fileSize || object.actions?.upload) {
            throw new MultipartProtocolError('MULTIPART_COMPLETION_UNCERTAIN', 'The previous multipart completion is not confirmed; request a new upload URL', 409);
        }
        const receipt = { ...previous, status: 'completed', completedAt: Date.now() };
        await db.put(key, JSON.stringify(receipt), { expirationTtl: remainingTtl(session) });
        return receipt;
    }
    if (!parts) throw new MultipartProtocolError('MULTIPART_PARTS_REQUIRED', 'Multipart parts are required before committing the uploaded file');
    const pending = { status: 'completing', oid: session.sha256, descriptorDigest, partsDigest,
        partCount: descriptor.partCount, startedAt: Date.now() };
    await db.put(key, JSON.stringify(pending), { expirationTtl: remainingTtl(session) });
    try {
        await postIssuedMultipartCompletion(descriptor, session.sha256, parts);
    } catch (error) {
        // A definite HTTP rejection is safe to retry; transport failures retain the uncertainty marker.
        if (error instanceof MultipartProtocolError && !error.ambiguous) await db.delete(key);
        throw error;
    }
    const receipt = { ...pending, status: 'completed', completedAt: Date.now() };
    await db.put(key, JSON.stringify(receipt), { expirationTtl: remainingTtl(session) });
    return receipt;
}

export async function ensureDirectMultipartCompletion(env, session, parts, provider, legacyAction) {
    if (!session.multipart) {
        if (session.uploadMode === 'multipart' || parts !== undefined || legacyAction?.header?.chunk_size) {
            throw new MultipartProtocolError('DIRECT_UPLOAD_SESSION_REQUIRED', 'Request a new upload URL before completing this multipart upload', 409);
        }
        return null;
    }
    const descriptor = validateIssuedMultipartDescriptor(session.multipart, session.fileSize);
    const normalized = parts === undefined ? null : validateMultipartParts(session.sha256, parts, {
        expectedOid: session.sha256, expectedCount: descriptor.partCount,
    });
    const descriptorDigest = await digest(descriptor);
    const partsDigest = normalized ? await digest(normalized) : undefined;
    const binding = env.img_url || env.img_d1 || env;
    let flights = completionFlights.get(binding);
    if (!flights) { flights = new Map(); completionFlights.set(binding, flights); }
    let flight = flights.get(session.fullId);
    if (flight && flight.partsDigest !== partsDigest) {
        throw new MultipartProtocolError('MULTIPART_COMPLETION_IN_PROGRESS', 'Multipart completion is already running with different part metadata', 409);
    }
    if (!flight) {
        const promise = runMultipartCompletion(env, session, descriptor, descriptorDigest, normalized, partsDigest, provider);
        flight = { partsDigest, promise };
        flights.set(session.fullId, flight);
        promise.finally(() => { if (flights.get(session.fullId) === flight) flights.delete(session.fullId); }).catch(() => {});
    }
    const receipt = await flight.promise;
    session.multipartCompletion = receipt;
    return receipt;
}
