/**
 * /upload 路由的分发器
 *
 * 职责：决定一次上传请求走 Durable Object 还是退回 Worker 本地处理。
 *
 * 为什么需要 DO：上传链路包含多次顺序异步操作，且绝大部分时间花在等上游
 * （Telegram/KV/网络）——CPU 只统计活跃执行时间，I/O 等待不计入，所以瓶颈在
 * 单次调用里"算"的部分；DO 的 CPU 预算（30s/次调用）远宽于 Worker 在 Free
 * 计划下的 10ms，是承载这类长任务的合适位置。
 * 注意：DO 的隔离内存（128MB）与子请求上限仍按 Workers 计划套用。
 *
 * 回退条件（自动退回 Worker 直接处理）：
 *   1. env.UPLOAD_DO 绑定不存在（未部署 DO）
 *   2. env.DISABLE_UPLOAD_DO === 'true'（紧急回滚开关）
 *
 * 注意：一旦向 DO 发起 fetch，请求 body 可能已被消费，失败时绝不再次本地执行。
 */

import { onRequest as onUploadRequest } from '../functions/upload/index.js';
import {
    createRouteUploadIdMismatchResponse,
    dispatchUploadToDurableObject,
    extractRouteUploadId,
    extractUploadId,
    getUploadRequestMethodRejection,
    isRouteUploadIdMismatchError,
    resolveUploadDurableObject,
} from './uploadRequestRouting.js';

export async function forwardToUploadDO(context) {
    const { request, env } = context;

    const methodRejection = getUploadRequestMethodRejection(request);
    if (methodRejection) {
        return methodRejection;
    }

    try {
        context.data ??= {};
        context.data.routeUploadId = extractRouteUploadId(request);
    } catch (error) {
        if (isRouteUploadIdMismatchError(error)) {
            return createRouteUploadIdMismatchResponse(error);
        }
        throw error;
    }

    // fallback：绑定不存在 或 手动禁用
    if (!env.UPLOAD_DO || env.DISABLE_UPLOAD_DO === 'true') {
        return onUploadRequest(context);
    }

    let stub;
    try {
        const uploadId = await extractUploadId(request);

        // 旧客户端把 uploadId 和二进制分片放在同一个 multipart body 中。
        // 不解析/复制大分片，直接交给 Worker 保持兼容。
        stub = resolveUploadDurableObject(env.UPLOAD_DO, request, uploadId);
    } catch (error) {
        if (isRouteUploadIdMismatchError(error)) {
            return createRouteUploadIdMismatchResponse(error);
        }
        // 仅 dispatch 前的解析/namespace 错误可安全回退，原始 body 尚未发送。
        console.error('[worker] DO routing failed, falling back to Worker:', error.message);
        return onUploadRequest(context);
    }

    if (!stub) {
        return onUploadRequest(context);
    }

    // 一旦向 DO 发起 fetch，请求 body 可能已被消费，失败时绝不再次本地执行。
    return dispatchUploadToDurableObject(stub, request);
}
