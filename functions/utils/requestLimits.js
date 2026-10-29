export class RequestBodyTooLargeError extends Error {
    constructor(maxBytes) {
        super(`Request body exceeds the configured limit (${maxBytes} bytes)`);
        this.name = 'RequestBodyTooLargeError';
        this.code = 'REQUEST_BODY_TOO_LARGE';
    }
}

export function isRequestBodyTooLargeError(error) {
    return error?.code === 'REQUEST_BODY_TOO_LARGE' || error?.name === 'RequestBodyTooLargeError'
        || String(error?.message || '').includes('Request body exceeds the configured limit');
}

export function createRequestBodyTooLargeResponse() {
    return new Response(JSON.stringify({ success: false, code: 'REQUEST_BODY_TOO_LARGE', error: 'Request body is too large; use chunked or direct uploads' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

/**
 * Bound bytes actually read, including chunked bodies with no Content-Length.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Request}
 */
export function limitRequestBody(request, maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid request body limit');
    const declared = request.headers.get('Content-Length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        throw new RequestBodyTooLargeError(maxBytes);
    }
    if (!request.body) return request;
    let received = 0;
    const body = request.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
            controller.enqueue(chunk);
        },
    }));
    const init = { body, duplex: 'half' };
    return new Request(request, init);
}
