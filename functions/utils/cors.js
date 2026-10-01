/**
 * 共享 CORS 响应头
 *
 * 背景：CORS 头此前在 7 处各自硬编码（worker.js 的 postOnly/getOnly/预检生成、
 * manage 中间件、stats、public/list、chat/shared），改动一处极易漏改其余。
 * 集中到本模块，各调用点只声明自己需要的 methods / headers。
 *
 * 注意：这些端点均为「无凭据 CORS」（Access-Control-Allow-Origin: * 且不发送
 * Allow-Credentials），因此浏览器不会跨站携带 Cookie，不构成 CSRF 通道。
 * 依赖 Cookie 鉴权的端点不应复用本模块的 * 通配。
 */

export const DEFAULT_ALLOWED_METHODS = 'GET, POST, DELETE, PUT, PATCH, OPTIONS';
export const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Authorization';

/**
 * 构造 CORS 响应头。
 * @param {{methods?: string, headers?: string, maxAge?: string}} [options]
 */
export function buildCorsHeaders({ methods, headers, maxAge } = {}) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': methods || DEFAULT_ALLOWED_METHODS,
        'Access-Control-Allow-Headers': headers || DEFAULT_ALLOWED_HEADERS,
        'Access-Control-Max-Age': maxAge || '86400',
    };
}

/**
 * 构造 204 预检响应。
 * @param {{methods?: string, headers?: string, maxAge?: string}} [options]
 */
export function buildPreflightResponse(options = {}) {
    return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(options),
    });
}
