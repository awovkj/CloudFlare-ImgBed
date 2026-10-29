export const DEFAULT_ALLOWED_METHODS = 'GET, POST, DELETE, PUT, PATCH, OPTIONS';
export const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Authorization, authCode, Range, If-Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, X-Upload-Id, X-Upload-Receipt';
export const FILE_ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
export const FILE_ALLOWED_HEADERS = 'Content-Type, Authorization, authCode, Range, If-Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since';
export const FILE_EXPOSED_HEADERS = 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified';

function getOriginPolicy(request, env = {}) {
    const configured = typeof env.CORS_ALLOWED_ORIGINS === 'string' && env.CORS_ALLOWED_ORIGINS.trim() !== '';
    const origin = request?.headers.get('Origin');
    if (!configured) return { configured: false, allowed: true, origin: '*' };

    const allowed = new Set();
    for (const entry of env.CORS_ALLOWED_ORIGINS.split(/[\s,]+/).filter(Boolean)) {
        try {
            const parsed = new URL(entry);
            if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
                && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
                allowed.add(parsed.origin);
            }
        } catch { /* Invalid entries never expand an allowlist. */ }
    }
    const sameOrigin = request && origin === new URL(request.url).origin;
    return { configured: true, allowed: !origin || sameOrigin || allowed.has(origin), origin };
}

export function appendVary(headers, value) {
    const existing = (headers.get('Vary') || '').split(',').map(item => item.trim()).filter(Boolean);
    if (!existing.some(item => item === '*' || item.toLowerCase() === value.toLowerCase())) {
        headers.set('Vary', [...existing, value].join(', '));
    }
}

// A configured allowlist also rejects cross-origin writes before any side effects.
export function getCorsRequestRejection(request, env = {}) {
    const policy = getOriginPolicy(request, env);
    if (policy.allowed) return null;
    const body = request.method === 'HEAD' ? null : JSON.stringify({ success: false, code: 'CORS_ORIGIN_DENIED', error: 'Origin is not allowed' });
    return new Response(body, {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' },
    });
}

/**
 * 构造 CORS 响应头。
 * Unconfigured deployments keep credential-free public CORS for compatibility.
 * Cookie credentials require an exact configured origin; '*' is never credentialed.
 * @param {import('./contracts.js').CorsOptions} [options]
 */
export function buildCorsHeaders({ methods, headers, maxAge, exposeHeaders, request, env = {} } = {}) {
    const policy = getOriginPolicy(request, env);
    const result = {
        'Access-Control-Allow-Methods': methods || DEFAULT_ALLOWED_METHODS,
        'Access-Control-Allow-Headers': headers || DEFAULT_ALLOWED_HEADERS,
        'Access-Control-Max-Age': maxAge || '600',
    };
    if (policy.configured) result.Vary = 'Origin';
    if (policy.allowed && policy.origin) result['Access-Control-Allow-Origin'] = policy.origin;
    if (policy.configured && policy.allowed && policy.origin && env.CORS_ALLOW_CREDENTIALS === 'true') {
        result['Access-Control-Allow-Credentials'] = 'true';
    }
    if (exposeHeaders) result['Access-Control-Expose-Headers'] = exposeHeaders;
    return result;
}

/**
 * 构造 204 预检响应。
 * @param {Parameters<typeof buildCorsHeaders>[0]} [options]
 */
export function buildPreflightResponse(options = {}) {
    if (options.request) {
        const rejected = getCorsRequestRejection(options.request, options.env);
        if (rejected) return rejected;
    }
    return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(options),
    });
}

// Override legacy per-handler wildcard headers at the Worker boundary without buffering bodies.
export function applyCorsToResponse(response, request, env = {}, options = {}) {
    const headers = new Headers(response.headers);
    const inherited = {
        methods: headers.get('Access-Control-Allow-Methods') || undefined,
        headers: headers.get('Access-Control-Allow-Headers') || undefined,
        maxAge: headers.get('Access-Control-Max-Age') || undefined,
        exposeHeaders: headers.get('Access-Control-Expose-Headers') || undefined,
    };
    for (const name of [...headers.keys()]) {
        if (name.startsWith('access-control-')) headers.delete(name);
    }
    const filePath = /^\/(?:file|temp)(?:\/|$)/.test(new URL(request.url).pathname);
    const fileOptions = filePath ? { methods: FILE_ALLOWED_METHODS, headers: FILE_ALLOWED_HEADERS, exposeHeaders: FILE_EXPOSED_HEADERS } : {};
    const cors = buildCorsHeaders({ request, env, ...inherited, ...fileOptions, ...options });
    for (const [name, value] of Object.entries(cors)) {
        if (name.toLowerCase() === 'vary') appendVary(headers, value);
        else headers.set(name, value);
    }
    if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
