export class RouteUploadIdMismatchError extends Error {
    constructor(message = 'Route uploadId does not match request uploadId') {
        super(message);
        this.name = 'RouteUploadIdMismatchError';
        this.code = 'ROUTE_UPLOAD_ID_MISMATCH';
    }
}

export const MAX_MERGE_FORM_DATA_BYTES = 64 * 1024;

export function isRouteUploadIdMismatchError(error) {
    return error?.code === 'ROUTE_UPLOAD_ID_MISMATCH';
}

export function assertRouteUploadIdMatches(routeUploadId, requestUploadId, message) {
    if (routeUploadId && requestUploadId && routeUploadId !== requestUploadId) {
        throw new RouteUploadIdMismatchError(message);
    }
}

export function extractRouteUploadId(request) {
    const url = new URL(request.url);
    const queryUploadId = url.searchParams.get('uploadId');
    const headerUploadId = request.headers.get('X-Upload-Id');

    assertRouteUploadIdMatches(
        queryUploadId,
        headerUploadId,
        'Query uploadId does not match X-Upload-Id header',
    );
    return queryUploadId || headerUploadId || null;
}

/**
 * Extract the stable upload identifier without parsing large chunk bodies.
 * Modern clients should send uploadId in the URL or X-Upload-Id header.
 * Merge requests retain a FormData compatibility path because their bodies
 * contain only small metadata fields and no file payload.
 */
export async function extractUploadId(request) {
    const url = new URL(request.url);
    const routeUploadId = extractRouteUploadId(request);

    const isMergeRequest = url.searchParams.get('merge') === 'true';
    const contentType = request.headers.get('content-type') || '';
    const contentLengthHeader = request.headers.get('content-length');
    const contentLength = Number(contentLengthHeader);
    const hasSafeMergeFormDataLength = contentLengthHeader !== null
        && Number.isInteger(contentLength)
        && contentLength > 0
        && contentLength <= MAX_MERGE_FORM_DATA_BYTES;
    if (request.method !== 'POST'
        || !isMergeRequest
        || !contentType.toLowerCase().includes('multipart/form-data')
        || !hasSafeMergeFormDataLength) {
        return routeUploadId;
    }

    const formData = await request.clone().formData();
    const bodyUploadId = formData.get('uploadId');
    const normalizedBodyUploadId = typeof bodyUploadId === 'string' && bodyUploadId ? bodyUploadId : null;
    assertRouteUploadIdMatches(routeUploadId, normalizedBodyUploadId);
    return routeUploadId || normalizedBodyUploadId;
}

/**
 * Legacy chunk requests keep uploadId inside the same multipart body as the
 * binary chunk. Route those directly through the Worker so routing never
 * clones or parses the potentially large body.
 */
export function shouldRouteUploadToDurableObject(request, uploadId) {
    const url = new URL(request.url);
    const isChunkMergeRequest = url.searchParams.get('chunked') === 'true'
        && url.searchParams.get('merge') === 'true';
    if (isChunkMergeRequest) {
        return false;
    }

    if (uploadId) {
        return true;
    }

    const isChunkRequest = url.searchParams.get('chunked') === 'true';
    return !isChunkRequest;
}

export function resolveUploadDurableObject(namespace, request, uploadId) {
    if (!shouldRouteUploadToDurableObject(request, uploadId)) {
        return null;
    }

    const id = uploadId
        ? namespace.idFromName(uploadId)
        : namespace.newUniqueId();
    return namespace.get(id);
}

export function buildUploadDurableObjectRouteData(request) {
    return { routeUploadId: extractRouteUploadId(request) };
}

export function createRouteUploadIdMismatchResponse(error) {
    return new Response(JSON.stringify({
        success: false,
        code: 'ROUTE_UPLOAD_ID_MISMATCH',
        message: error?.message || 'Route uploadId does not match request uploadId',
    }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
    });
}

export async function dispatchUploadToDurableObject(stub, request) {
    try {
        return await stub.fetch(request);
    } catch (error) {
        console.error('[worker] Upload Durable Object fetch failed:', error.message);
        return new Response(JSON.stringify({
            success: false,
            code: 'UPLOAD_DURABLE_OBJECT_FETCH_FAILED',
            message: 'Upload Durable Object request failed',
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export function isUploadDurableObjectRequestAllowed(request) {
    if (request.method === 'POST' || request.method === 'OPTIONS') {
        return true;
    }
    if (request.method !== 'GET') {
        return false;
    }
    return new URL(request.url).searchParams.get('cleanup') === 'true';
}

export function getUploadRequestMethodRejection(request) {
    if (isUploadDurableObjectRequestAllowed(request)) {
        return null;
    }
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
    });
}
