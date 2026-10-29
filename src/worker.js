/**
 * Cloudflare Workers 入口
 *
 * 职责边界（本文件只做三件事）：
 *   1. 导出 Durable Object 类（Wrangler 要求入口文件导出）
 *   2. 解析 URL → 交给路由表匹配 → 执行
 *   3. 未匹配时的兜底：API 前缀显式 404，其余回落静态资源
 *
 * 路由表在 src/routes.js，Pages 兼容层在 src/pagesAdapter.js，
 * 上传分发在 src/uploadDispatcher.js。本文件不再承载任何业务逻辑与路由数据。
 */

// ── Durable Object re-export（Wrangler 要求入口文件导出 DO 类）───────────────
export { UploadDurableObject } from './uploadDurableObject.js';

import { resolveRoute, isWorkerOwnedPath } from './routes.js';
import { runMiddlewareChain, runGeneratedRoute } from './pagesAdapter.js';
import { createServerErrorResponse } from '../functions/utils/response.js';
import { applyCorsToResponse, getCorsRequestRejection } from '../functions/utils/cors.js';
import { createRequestBodyTooLargeResponse, isRequestBodyTooLargeError } from '../functions/utils/requestLimits.js';
import { enforceRequestBodyLimit } from './requestBodyPolicy.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        try {
            // 路由匹配：静态 Map（O(1)）→ 动态正则 → /api/auth/* 生成路由
            const resolved = resolveRoute(pathname);

            if (resolved) {
                const corsRejection = getCorsRequestRejection(request, env);
                if (corsRejection) return corsRejection;
                request = enforceRequestBodyLimit(request, env);
                let response;
                if (resolved.kind === 'generated') {
                    response = await runGeneratedRoute(request, env, ctx, resolved.route);
                } else {
                    response = await runMiddlewareChain(request, env, ctx, resolved.params, resolved.chain);
                }
                response = applyCorsToResponse(response, request, env);
                // Administrative JSON and session changes must never enter shared caches.
                if (pathname.startsWith('/api/manage/') || response.headers.has('Set-Cookie')) {
                    response.headers.set('Cache-Control', 'private, no-store');
                }
                return response;
            }

            // 路由未匹配且属于 worker 负责的路径 → 显式 404。
            // 绝不回落到静态资源：SPA 的 not_found_handling 会让这里返回
            // index.html，把「路由漏登记」伪装成前端 JSON 解析错误。
            if (isWorkerOwnedPath(pathname)) {
                console.error(`[worker] Unregistered API route: ${request.method} ${pathname}`);
                return applyCorsToResponse(new Response(JSON.stringify({ error: 'Not Found', path: pathname }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
                }), request, env);
            }
        } catch (err) {
            // 不把 error.message 回吐客户端，详情进 console，用 requestId 关联
            const response = isRequestBodyTooLargeError(err)
                ? createRequestBodyTooLargeResponse()
                : createServerErrorResponse(env, err, { pathname });
            return applyCorsToResponse(response, request, env);
        }

        // 未匹配的非 API 路径 → 静态资源
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    },
};
