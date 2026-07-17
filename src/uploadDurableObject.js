// ── Upload Durable Object ───────────────────────────────────────────────────
// Durable Object 没有实际的 CPU 时间限制（每次 I/O 重置计时器），
// 非常适合上传这类包含多次顺序异步操作的长任务。
// Worker 仅作为薄代理，将 /upload 请求转发到此 DO 处理。

import { onRequest as onUploadRequest } from '../functions/upload/index.js';
import {
    buildUploadDurableObjectRouteData,
    createRouteUploadIdMismatchResponse,
    isRouteUploadIdMismatchError,
    isUploadDurableObjectRequestAllowed,
} from './uploadRequestRouting.js';

export class UploadDurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.ctx = state;
    }

    async fetch(request) {
        // cleanup 兼容 GET；上传与预检分别使用 POST、OPTIONS。
        if (!isUploadDurableObjectRequestAllowed(request)) {
            return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
                status: 405,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        try {
            const context = this._buildContext(request);
            return await onUploadRequest(context);
        } catch (error) {
            if (isRouteUploadIdMismatchError(error)) {
                return createRouteUploadIdMismatchResponse(error);
            }
            console.error('[UploadDO] Unhandled error:', error);
            return new Response(JSON.stringify({
                error: 'Upload Durable Object internal error',
                message: error.message
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                }
            });
        }
    }

    /**
     * 构建 Pages Functions 兼容的 context 对象
     * 与 worker.js 中 makeContext() 保持一致
     */
    _buildContext(request) {
        return {
            request,
            env: this.env,
            params: {},
            data: buildUploadDurableObjectRouteData(request),
            waitUntil: this.ctx.waitUntil.bind(this.ctx),
            passThroughOnException: () => {},
            next: () => new Response('Not Found', { status: 404 }),
        };
    }
}
