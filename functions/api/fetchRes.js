import { dualAuthCheck } from '../utils/dualAuth.js';

// 代理限制
const FETCH_TIMEOUT_MS = 10000;              // 上游请求超时
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024; // 最大代理响应体，25MB
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// 私有/保留/回环/链路本地地址，禁止代理访问以防 SSRF
function isBlockedHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号

    if (host === 'localhost' || host === 'ip6-localhost' || host === 'ip6-loopback') return true;
    if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (host === '0.0.0.0' || host === '::' || host === '::1') return true;

    // 云元数据服务主机名（GCP 元数据可按域名访问，不只 169.254.169.254）
    if (host === 'metadata.google.internal' || host === 'metadata.goog') return true;

    // IPv4 私有/保留段
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        if (a === 10) return true;                          // 10.0.0.0/8
        if (a === 127) return true;                         // 127.0.0.0/8 回环
        if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
        if (a === 192 && b === 168) return true;            // 192.168.0.0/16
        if (a === 169 && b === 254) return true;            // 169.254.0.0/16 链路本地（含云元数据）
        if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
        if (a === 0) return true;                           // 0.0.0.0/8
        if (a >= 224) return true;                          // 组播/保留段
    }

    // IPv6 唯一本地/链路本地
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7
    if (host.startsWith('fe80')) return true;                        // 链路本地

    // IPv4-mapped IPv6 (::ffff:a.b.c.d) 递归按 IPv4 规则检查
    const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isBlockedHost(mapped[1]);

    return false;
}

function validateTargetUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { ok: false, error: 'Invalid URL' };
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return { ok: false, error: 'Only http/https URLs are allowed' };
    }
    if (isBlockedHost(parsed.hostname)) {
        return { ok: false, error: 'Target host is not allowed' };
    }
    return { ok: true, parsed };
}

// 用计数 TransformStream 限制响应体大小，超限即中止
function limitBodySize(body, maxBytes) {
    let received = 0;
    return body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > maxBytes) {
                controller.error(new Error('Response too large'));
                return;
            }
            controller.enqueue(chunk);
        }
    }));
}

export async function onRequest(context) {
    const { request, env } = context;
    const requestUrl = new URL(request.url);

    const { authorized } = await dualAuthCheck(env, requestUrl, request);
    if (!authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
    }

    let jsonRequest;
    try {
        jsonRequest = await request.json();
    } catch {
        return new Response('Invalid request body', { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const targetUrl = jsonRequest.url;
    if (typeof targetUrl !== 'string' || targetUrl === '') {
        return new Response('URL is required', { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const validation = validateTargetUrl(targetUrl);
    if (!validation.ok) {
        return new Response(validation.error, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    // 超时控制
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // 手动跟随重定向并对每一跳重新校验，防止通过 302 跳转到内网地址绕过 SSRF 校验
    const MAX_REDIRECTS = 3;
    let currentUrl = validation.parsed.toString();
    let response;
    try {
        for (let hop = 0; ; hop++) {
            response = await fetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                signal: controller.signal,
            });

            // 非重定向响应，结束跟随
            if (response.status < 300 || response.status >= 400) break;

            const location = response.headers.get('Location');
            if (!location) break; // 无 Location，按普通响应处理

            if (hop >= MAX_REDIRECTS) {
                clearTimeout(timeout);
                return new Response('Too many redirects', { status: 502, headers: { 'Cache-Control': 'no-store' } });
            }

            // 相对跳转基于当前 URL 解析，再次校验协议与目标主机
            const nextUrl = new URL(location, currentUrl);
            const hopValidation = validateTargetUrl(nextUrl.toString());
            if (!hopValidation.ok) {
                clearTimeout(timeout);
                return new Response('Redirect target is not allowed', { status: 400, headers: { 'Cache-Control': 'no-store' } });
            }
            currentUrl = hopValidation.parsed.toString();
        }
    } catch (error) {
        clearTimeout(timeout);
        return new Response('Failed to fetch target resource', { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    clearTimeout(timeout);

    // 预检 Content-Length
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        return new Response('Response too large', { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }

    // 仅透传安全的响应头，避免回传上游敏感头
    const outHeaders = new Headers();
    const contentType = response.headers.get('Content-Type');
    if (contentType) outHeaders.set('Content-Type', contentType);
    outHeaders.set('X-Content-Type-Options', 'nosniff');
    outHeaders.set('Content-Disposition', 'attachment');
    outHeaders.set('Cache-Control', 'no-store');

    const limitedBody = response.body ? limitBodySize(response.body, MAX_RESPONSE_BYTES) : null;
    return new Response(limitedBody, {
        status: response.status,
        headers: outHeaders,
    });
}
