const JSON_HEADERS = {
    'Content-Type': 'application/json'
};

export function createJsonResponse(payload, options = {}) {
    return new Response(JSON.stringify(payload), {
        ...options,
        headers: {
            ...JSON_HEADERS,
            ...(options.headers || {})
        }
    });
}

export function createTextResponse(body, options = {}) {
    return new Response(body, {
        ...options,
        headers: {
            ...(options.headers || {})
        }
    });
}

export function createNoStoreTextResponse(body, status, statusText, headers = {}) {
    return createTextResponse(body, {
        status,
        statusText,
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(body.length),
            ...headers
        }
    });
}
