// ── Upload Durable Object ───────────────────────────────────────────────────
// Durable Object 没有实际的 CPU 时间限制（每次 I/O 重置计时器），
// 非常适合上传这类包含多次顺序异步操作的长任务。
// Worker 仅作为薄代理，将 /upload 请求转发到此 DO 处理。

import { onRequest as onUploadRequest } from '../functions/upload/index.js';
import {
    buildUploadDurableObjectRouteData,
    createSerialExecutor,
    createRouteUploadIdMismatchResponse,
    getUploadRequestMethodRejection,
    isRouteUploadIdMismatchError,
} from './uploadRequestRouting.js';

// 合并请求立即返回的 409 响应（不触碰 KV）。
// 当 activeMergePromise 表明合并正在本 DO 实例内执行时，轮询请求直接返回此响应，
// 避免在 runSerial 队列中排队堆积。
function createMergeInProgressResponse() {
    return new Response(JSON.stringify({
        success: false,
        code: 'MERGE_IN_PROGRESS',
        message: 'Merge is already in progress',
        retryAfterMs: 1000
    }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
    });
}

export class UploadDurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.ctx = state;
        this.runSerial = createSerialExecutor();
        // 合并是长任务（15~60s+），不能走 runSerial，否则会阻塞同一 uploadId 的
        // 轮询与清理请求。用内存锁确保同一 DO 实例内同一时刻只有一个合并在执行；
        // 跨 DO 实例（如驱逐重建）的并发安全由 handleChunkMerge 内的 claimMergeLease
        // （KV CAS）保证。
        this.activeMergePromise = null;
    }

    fetch(request) {
        // 合并请求绕过 runSerial：合并是长任务，若走串行队列会阻塞轮询（65s 超时 →
        // 前端重试 → 请求堆积 → 合并"看起来卡住"）和清理请求。轮询请求在合并期间
        // 通过 activeMergePromise 立即返回 409，不触碰 KV。
        const url = new URL(request.url);
        if (url.searchParams.get('merge') === 'true') {
            return this._handleMergeRequest(request);
        }
        // 非 merge 请求（cleanup 等）仍走 runSerial，避免同一 uploadId 的并发 KV 写入冲突。
        return this.runSerial(() => this._handleRequest(request));
    }

    /**
     * 合并请求处理：绕过 runSerial，用内存锁控制并发。
     *
     * - 若本 DO 实例已有合并在执行（activeMergePromise 已设置），立即返回 409，
     *   不进入 handleChunkMerge，不读 KV。
     * - 否则将请求交给 _handleRequest（会调用 handleChunkMerge），并用
     *   activeMergePromise 记录正在执行的合并 Promise，合并结束后自动清除。
     * - claimMergeLease（KV CAS）作为跨实例的最终并发安全兜底。
     */
    async _handleMergeRequest(request) {
        if (this.activeMergePromise) {
            return createMergeInProgressResponse();
        }
        const promise = this._handleRequest(request).finally(() => {
            if (this.activeMergePromise === promise) {
                this.activeMergePromise = null;
            }
        });
        this.activeMergePromise = promise;
        return promise;
    }

    async _handleRequest(request) {
        // cleanup 兼容 GET；上传与预检分别使用 POST、OPTIONS。
        const methodRejection = getUploadRequestMethodRejection(request);
        if (methodRejection) {
            return methodRejection;
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
