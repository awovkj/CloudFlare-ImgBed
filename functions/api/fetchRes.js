import { userAuthCheck, UnauthorizedResponse } from '../utils/auth/userAuth.js';
import { buildPreflightResponse } from '../utils/cors.js';
import { createJsonResponse } from '../utils/response.js';
import { validateHttpUrl } from '../utils/urlSafety.js';
import { isRequestBodyTooLargeError, createRequestBodyTooLargeResponse } from '../utils/requestLimits.js';

const FETCH_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function proxyError(error, status) {
    return createJsonResponse({ success: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Keep the timeout alive through body consumption; cancellation reaches the upstream reader. */
export function createBoundedProxyBody(body, maxBytes, abortController, timeout) {
    const reader = body.getReader();
    let received = 0;
    let finished = false;
    let destination;
    const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        abortController.signal.removeEventListener('abort', onAbort);
        if (error) destination.error(error);
        else destination.close();
    };
    const onAbort = () => {
        finish(abortController.signal.reason || new Error('Proxy request timed out'));
        reader.cancel().catch(() => {});
    };
    return new ReadableStream({
        start(controller) {
            destination = controller;
            abortController.signal.addEventListener('abort', onAbort, { once: true });
            if (abortController.signal.aborted) onAbort();
        },
        async pull() {
            if (finished) return;
            try {
                const { done, value } = await reader.read();
                if (finished) return;
                if (done) return finish();
                received += value.byteLength;
                if (received > maxBytes) {
                    finish(new Error('Proxy response is too large'));
                    abortController.abort();
                    reader.cancel().catch(() => {});
                    return;
                }
                destination.enqueue(value);
            } catch (error) {
                finish(error);
            }
        },
        cancel(reason) {
            finished = true;
            clearTimeout(timeout);
            abortController.signal.removeEventListener('abort', onAbort);
            abortController.abort(reason);
            return reader.cancel(reason).catch(() => {});
        },
    });
}

export async function onRequest(context) {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return buildPreflightResponse({ request, env, methods: 'POST, OPTIONS' });
    if (request.method !== 'POST') {
        return createJsonResponse({ error: 'Method Not Allowed' }, {
            status: 405, headers: { Allow: 'POST, OPTIONS', 'Cache-Control': 'no-store' },
        });
    }
    const requestUrl = new URL(request.url);
    if (!await userAuthCheck(env, requestUrl, request, 'upload')) return UnauthorizedResponse('Unauthorized');

    let body;
    try { body = await request.json(); }
    catch (error) {
        if (isRequestBodyTooLargeError(error)) return createRequestBodyTooLargeResponse();
        return proxyError('Invalid request body', 400);
    }
    if (typeof body?.url !== 'string' || !body.url.trim()) return proxyError('URL is required', 400);

    // Workers fetch cannot pin public DNS to a validated address. Only trusted, administrator-owned
    // hostnames may be allowlisted; a blacklist alone cannot prevent DNS rebinding.
    const options = { allowedHosts: env.FETCH_ALLOWED_HOSTS, requireAllowlist: true };
    const validation = validateHttpUrl(body.url, options);
    if (!validation.ok) return proxyError(validation.error, 400);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Proxy request timed out')), FETCH_TIMEOUT_MS);
    let currentUrl = validation.parsed.toString();
    let response;
    try {
        for (let hop = 0; ; hop++) {
            response = await fetch(currentUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
            if (response.status < 300 || response.status >= 400 || !response.headers.get('Location')) break;
            const location = response.headers.get('Location');
            response.body?.cancel().catch(() => {});
            if (hop >= MAX_REDIRECTS) {
                clearTimeout(timeout);
                return proxyError('Too many redirects', 502);
            }
            const hopValidation = validateHttpUrl(new URL(location, currentUrl).toString(), options);
            if (!hopValidation.ok) {
                clearTimeout(timeout);
                return proxyError('Redirect target is not allowed', 400);
            }
            currentUrl = hopValidation.parsed.toString();
        }
    } catch {
        clearTimeout(timeout);
        controller.abort();
        return proxyError('Failed to fetch target resource', 502);
    }
    const declaredSize = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
        clearTimeout(timeout);
        controller.abort();
        response.body?.cancel().catch(() => {});
        return proxyError('Response is too large', 502);
    }
    const headers = new Headers({
        'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment',
        'Cache-Control': 'no-store',
    });
    if (!response.body) clearTimeout(timeout);
    return new Response(response.body ? createBoundedProxyBody(response.body, MAX_RESPONSE_BYTES, controller, timeout) : null, {
        status: response.status, headers,
    });
}
