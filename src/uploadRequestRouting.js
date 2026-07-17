/**
 * Extract the stable upload identifier without parsing large chunk bodies.
 * Modern clients should send uploadId in the URL or X-Upload-Id header.
 * Merge requests retain a FormData compatibility path because their bodies
 * contain only small metadata fields and no file payload.
 */
export async function extractUploadId(request) {
    const url = new URL(request.url);
    const queryUploadId = url.searchParams.get('uploadId');
    if (queryUploadId) {
        return queryUploadId;
    }

    const headerUploadId = request.headers.get('X-Upload-Id');
    if (headerUploadId) {
        return headerUploadId;
    }

    const isMergeRequest = url.searchParams.get('merge') === 'true';
    const contentType = request.headers.get('content-type') || '';
    if (request.method !== 'POST'
        || !isMergeRequest
        || !contentType.toLowerCase().includes('multipart/form-data')) {
        return null;
    }

    const formData = await request.clone().formData();
    const bodyUploadId = formData.get('uploadId');
    return typeof bodyUploadId === 'string' && bodyUploadId ? bodyUploadId : null;
}

/**
 * Legacy chunk requests keep uploadId inside the same multipart body as the
 * binary chunk. Route those directly through the Worker so routing never
 * clones or parses the potentially large body.
 */
export function shouldRouteUploadToDurableObject(request, uploadId) {
    if (uploadId) {
        return true;
    }

    const url = new URL(request.url);
    const isChunkRequest = url.searchParams.get('chunked') === 'true';
    const isMergeRequest = url.searchParams.get('merge') === 'true';
    return !isChunkRequest || isMergeRequest;
}
