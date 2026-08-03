/* ========== 分块合并处理 ========== */
import { createResponse, getUploadIp, getIPAddress, selectChannel, buildUniqueFileId, endUpload, buildReturnLink, sanitizeUploadFolder } from './uploadTools';
import { retryFailedChunks, getChunkUploadStatusesWithManifest, cleanupChunkData } from './chunkUpload';
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getDatabase } from '../utils/databaseAdapter.js';
import { fetchPageConfig } from '../utils/sysConfig.js';
import { buildUploadResult } from './uploadShared.js';
import { applyChatTransferMetadata, isChatRequestFromUrl, isChatUploadChannel } from '../utils/chat.js';
import { cleanPersistedMetadataInPlace } from '../utils/metadata/metadataSecurity.js';
import { assertRouteUploadIdMatches, createRouteUploadIdMismatchResponse } from '../../src/uploadRequestRouting.js';
import {
    MERGE_HEARTBEAT_INTERVAL_MS,
    buildMergeLeasePatch,
    buildWaitingForChunksPatch,
    classifyMergeSession
} from './chunkMergeState.js';
import { claimUploadMerge, readUploadSession, updateUploadSession } from './mergeSessionStore.js';
import {
    getMergeSuccessReceipt as readMergeSuccessReceipt,
    persistMergeSuccessReceipt as writeMergeSuccessReceipt
} from './mergeSuccessReceipt.js';

const INITIAL_SETTLE_WAIT_MS = 15000;
const SETTLE_INTERVAL_MS = 500;
const FINAL_PENDING_GRACE_MS = 5000;
const MERGE_PENDING_RETRY_AFTER_MS = 1000;
const MERGE_RETRY_TIMEOUT_MS = 15000;
const MERGE_RETRY_CONCURRENCY = 3;

function summarizeChunkStatuses(chunkStatuses) {
    return chunkStatuses.reduce((acc, chunk) => {
        acc[chunk.status] = (acc[chunk.status] || 0) + 1;
        return acc;
    }, {});
}

function isChunkStillProcessing(chunk) {
    return ['uploading', 'retrying'].includes(chunk.status);
}

function isChunkRetryableFailure(chunk) {
    return ['failed', 'timeout', 'retry_timeout'].includes(chunk.status) && chunk.hasData;
}

function isChunkTerminalFailure(chunk) {
    return ['missing', 'error', 'retry_failed'].includes(chunk.status)
        || (['failed', 'timeout', 'retry_timeout'].includes(chunk.status) && !chunk.hasData);
}

async function updateUploadSessionStatus(env, uploadId, patch = {}, options = {}) {
    try {
        return await updateUploadSession(getDatabase(env), uploadId, patch, options);
    } catch (error) {
        console.warn(`Failed to update upload session status for ${uploadId}:`, error);
        if (options.required) {
            throw error;
        }
        return false;
    }
}

async function getUploadSessionInfo(env, uploadId) {
    return readUploadSession(getDatabase(env), uploadId);
}

async function claimMergeLease(env, uploadId, leasePatch, options = {}) {
    try {
        return await claimUploadMerge(getDatabase(env), uploadId, leasePatch, options);
    } catch (error) {
        console.warn(`Failed to claim merge lease for ${uploadId}:`, error);
        if (options.required) throw error;
        return false;
    }
}

async function verifyMergeOwnership(env, uploadId, mergeJobId) {
    const sessionInfo = await getUploadSessionInfo(env, uploadId);
    return sessionInfo?.status === 'merging'
        && sessionInfo?.mergeJobId === mergeJobId
        && classifyMergeSession(sessionInfo, Date.now()).kind === 'active';
}

async function getMergeSuccessReceipt(env, uploadId) {
    return readMergeSuccessReceipt(getDatabase(env), uploadId);
}

async function persistMergeSuccessReceipt(env, uploadId, mergeResult, mergeJobId) {
    return writeMergeSuccessReceipt(getDatabase(env), uploadId, mergeResult, mergeJobId);
}

function createMergeJobId() {
    return `merge_${crypto.randomUUID()}`;
}

function createPendingMergeResponse(uploadId, code, message, retryAfterMs, statusSummary = {}) {
    return createResponse(JSON.stringify({
        success: false,
        code,
        message,
        uploadId,
        retryAfterMs,
        statusSummary
    }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
    });
}

function isPotentiallyCommittedMergeError(error) {
    return /merge failed:.*(multipart|already|complete|upload id|not found)/i.test(error?.message || '');
}

async function preservePotentialMergeSuccess(env, uploadId, mergeJobId, error, options = {}) {
    await updateUploadSessionStatus(env, uploadId, buildWaitingForChunksPatch(
        mergeJobId,
        Date.now(),
        MERGE_PENDING_RETRY_AFTER_MS,
        {
            mergeBackgroundError: error.message,
            mergeBackgroundErrorAt: Date.now(),
            mergeError: error.message,
            mergeNeedsReconciliation: true,
            ...options
        }
    ), {
        expectedJobId: mergeJobId,
        allowedStatuses: ['merging', 'waiting_chunks']
    });
}

function startMergeHeartbeat(env, uploadId, mergeJobId) {
    let stopped = false;
    let timer = null;
    let inFlight = Promise.resolve();

    const heartbeat = () => {
        if (stopped) return;
        inFlight = updateUploadSessionStatus(
            env,
            uploadId,
            buildMergeLeasePatch(mergeJobId, Date.now()),
            {
                expectedJobId: mergeJobId,
                allowedStatuses: ['merging']
            }
        ).then(updated => {
            if (!updated) stopped = true;
        }).catch(error => {
            stopped = true;
            console.warn(`Merge heartbeat failed for ${uploadId}:`, error);
        });
    };

    const scheduleHeartbeat = () => {
        if (stopped) return;
        timer = setTimeout(() => {
            heartbeat();
            inFlight.finally(scheduleHeartbeat);
        }, MERGE_HEARTBEAT_INTERVAL_MS);
    };
    scheduleHeartbeat();
    return async () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        await inFlight;
    };
}

async function persistMergeSuccess(context, uploadId, totalChunks, mergeJobId, rawMergeResult) {
    const { env } = context;

    if (!await verifyMergeOwnership(env, uploadId, mergeJobId)) {
        const existingReceipt = await getMergeSuccessReceipt(env, uploadId).catch(() => null);
        if (existingReceipt?.mergeResult) {
            return enrichMergeResultWithPublicUrl(context, existingReceipt.mergeResult);
        }
        throw new Error('Merge ownership was lost before success could be committed');
    }

    const sessionPersisted = await updateUploadSessionStatus(env, uploadId, {
        status: 'merge_success',
        mergeCompletedAt: Date.now(),
        mergeResult: rawMergeResult,
        mergeLeaseUntil: 0,
        mergeProtectedUntil: 0
    }, {
        expectedJobId: mergeJobId,
        allowedStatuses: ['merging', 'waiting_chunks']
    });

    if (!sessionPersisted) {
        const existingReceipt = await getMergeSuccessReceipt(env, uploadId).catch(() => null);
        if (existingReceipt?.mergeResult) {
            return enrichMergeResultWithPublicUrl(context, existingReceipt.mergeResult);
        }
        throw new Error('Merge ownership was lost while committing success');
    }

    const committedSession = await getUploadSessionInfo(env, uploadId);
    if (committedSession?.status !== 'merge_success'
        || committedSession?.mergeJobId !== mergeJobId
        || !committedSession?.mergeResult) {
        throw new Error('Merge success commit could not be verified');
    }

    // Publish the canonical result only after the owner-scoped session commit
    // has been re-read successfully. Never clean up an unverified commit.
    await persistMergeSuccessReceipt(env, uploadId, committedSession.mergeResult, mergeJobId);

    await cleanupChunkData(env, uploadId, totalChunks, { ignoreMergeProtection: true });
    return enrichMergeResultWithPublicUrl(context, committedSession.mergeResult);
}

async function enrichMergeResultWithPublicUrl(context, mergeResult) {
    if (!Array.isArray(mergeResult) || mergeResult.length === 0 || !mergeResult[0]?.src) {
        return mergeResult;
    }

    const src = mergeResult[0].src;
    const fileName = src.startsWith('/file/') ? src.slice(6) : src.split('/file/').pop();
    const pageConfig = await fetchPageConfig(context.env);
    const urlPrefixConfig = pageConfig.config?.find((configItem) => configItem.id === 'urlPrefix');
    const urlPrefix = urlPrefixConfig?.value || '';
    context.publicUrl = urlPrefix ? `${urlPrefix.replace(/\/+$/, '')}/${fileName}` : '';
    return [buildUploadResult(context, src)];
}

async function createMergeSuccessResponse(context, rawMergeResult) {
    const mergeResult = await enrichMergeResultWithPublicUrl(context, rawMergeResult);
    return createResponse(JSON.stringify(mergeResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

// 处理分块合并
export async function handleChunkMerge(context) {
    const { request, env, url, waitUntil } = context;
    const db = getDatabase(env);

    // 解析表单数据
    const formdata = await request.formData();
    context.formdata = formdata;

    let uploadId, totalChunks, originalFileName, originalFileType, uploadChannel;
    try {
        uploadId = formdata.get('uploadId');
        totalChunks = parseInt(formdata.get('totalChunks'));
        originalFileName = formdata.get('originalFileName');
        originalFileType = formdata.get('originalFileType') || 'application/octet-stream';

        try {
            assertRouteUploadIdMatches(context.data?.routeUploadId, uploadId);
        } catch (error) {
            return createRouteUploadIdMismatchResponse(error);
        }

        if (!uploadId) {
            return createResponse('Error: Missing merge parameters', { status: 400 });
        }

        const successReceipt = await getMergeSuccessReceipt(env, uploadId);
        if (successReceipt?.mergeResult) {
            return createMergeSuccessResponse(context, successReceipt.mergeResult);
        }

        if (!totalChunks || !originalFileName) {
            return createResponse('Error: Missing merge parameters', { status: 400 });
        }

        // 验证上传会话
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        if (!sessionData) {
            return createResponse('Error: Invalid or expired upload session', { status: 400 });
        }

        const sessionInfo = JSON.parse(sessionData);
        const sessionRevision = Number(sessionInfo.revision || 0);
        const now = Date.now();

        // 如果后台合并已经成功，直接返回保存的结果（供前端轮询拿到结果）
        if (sessionInfo.status === 'merge_success' && sessionInfo.mergeResult) {
            return createMergeSuccessResponse(context, sessionInfo.mergeResult);
        }

        if (sessionInfo.status === 'merge_failed') {
            return createResponse(JSON.stringify({
                success: false,
                code: 'MERGE_FAILED',
                message: sessionInfo.mergeError || sessionInfo.mergeBackgroundError || 'Merge failed in background',
                uploadId,
                statusSummary: sessionInfo.mergeLastStatusSummary || {},
                mergeBackgroundAttempt: sessionInfo.mergeBackgroundAttempt || 0
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const mergeState = classifyMergeSession(sessionInfo, now);
        if (mergeState.kind === 'active') {
            return createPendingMergeResponse(
                uploadId,
                'MERGE_IN_PROGRESS',
                'Merge is already in progress',
                MERGE_PENDING_RETRY_AFTER_MS,
                sessionInfo.mergeLastStatusSummary || {}
            );
        }
        if (mergeState.kind === 'waiting') {
            const retryAfterMs = Math.max(
                MERGE_PENDING_RETRY_AFTER_MS,
                Math.min(5000, mergeState.resumeAfter - now)
            );
            return createPendingMergeResponse(
                uploadId,
                'MERGE_IN_PROGRESS',
                'Merge is waiting for chunks in the background',
                retryAfterMs,
                sessionInfo.mergeLastStatusSummary || {}
            );
        }
        if (mergeState.kind === 'stale') {
            console.warn(`Recovering stale merge lease for ${uploadId}`);
        } else if (sessionInfo.status === 'waiting_chunks') {
            console.log(`Background merge for ${uploadId} missed its recovery window; taking over`);
        }

        // 验证会话信息
        if (sessionInfo.originalFileName !== originalFileName ||
            sessionInfo.totalChunks !== totalChunks) {
            return createResponse('Error: Session parameters mismatch', { status: 400 });
        }

        // 检查会话是否过期
        if (Date.now() > sessionInfo.expiresAt) {
            return createResponse('Error: Upload session expired', { status: 410 });
        }

        // 使用会话中的上传渠道，或者从URL参数获取
        uploadChannel = url.searchParams.get('uploadChannel') || sessionInfo.uploadChannel || 'telegram';
        if (isChatRequestFromUrl(url) && !isChatUploadChannel(uploadChannel)) {
            return createResponse('Error: Chat uploads only support Telegram channels', { status: 400 });
        }

        // WebDAV 渠道不支持分块上传
        if (uploadChannel === 'webdav') {
            return createResponse('Error: WebDAV channel does not support chunked uploads. Please use non-chunked upload within your Cloudflare request body limit.', { status: 400 });
        }

        // 获取指定的渠道名称（优先URL参数，其次会话信息）
        const channelName = url.searchParams.get('channelName') || sessionInfo.channelName || '';
        context.specifiedChannelName = channelName;

        // 检查分块上传状态
        const chunkStatuses = await getChunkUploadStatusesWithManifest(env, uploadId, totalChunks);

        // 输出初始状态摘要
        const initialStatusSummary = summarizeChunkStatuses(chunkStatuses);
        console.log(`Initial chunk status summary: ${JSON.stringify(initialStatusSummary)}`);

        const mergeJobId = createMergeJobId();
        const claimed = await claimMergeLease(env, uploadId, buildMergeLeasePatch(mergeJobId, Date.now(), {
            mergeStartedAt: Date.now(),
            mergeLastStatusSummary: initialStatusSummary
        }), {
            expectedRevision: sessionRevision,
            required: true
        });

        if (!claimed) {
            return createPendingMergeResponse(
                uploadId,
                'MERGE_IN_PROGRESS',
                'Another merge worker claimed this upload',
                MERGE_PENDING_RETRY_AFTER_MS,
                initialStatusSummary
            );
        }

        // 开始合并处理
        return await startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel, mergeJobId);

    } catch (error) {
        const successReceipt = uploadId ? await getMergeSuccessReceipt(env, uploadId).catch(() => null) : null;
        if (successReceipt?.mergeResult) {
            return createMergeSuccessResponse(context, successReceipt.mergeResult);
        }
        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
}

// 开始合并处理
async function startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel, mergeJobId) {
    const { env } = context;
    const stopHeartbeat = startMergeHeartbeat(env, uploadId, mergeJobId);

    try {
        // 合并任务状态输出
        const mergeStatus = {
            uploadId,
            status: 'processing',
            progress: 0,
            totalChunks,
            originalFileName,
            originalFileType,
            uploadChannel,
            createdAt: Date.now(),
            message: 'Starting merge process...'
        };
        console.log(`Merge status: ${JSON.stringify(mergeStatus)}`);

        // 同步执行合并
        const result = await handleChannelBasedMerge(
            context,
            uploadId,
            totalChunks,
            originalFileName,
            originalFileType,
            uploadChannel
        );

        if (result.success) {
            await stopHeartbeat();
            const mergeResult = await persistMergeSuccess(context, uploadId, totalChunks, mergeJobId, result.result);
            return createResponse(JSON.stringify(mergeResult), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (result.code === 'MERGE_IN_PROGRESS' || result.code === 'CHUNKS_INCOMPLETE') {
            await stopHeartbeat();
            const retryAfterMs = result.retryAfterMs || MERGE_PENDING_RETRY_AFTER_MS;
            const waitingPatch = buildWaitingForChunksPatch(mergeJobId, Date.now(), retryAfterMs, {
                mergeLastPendingAt: Date.now(),
                mergeLastStatusSummary: result.statusSummary || {}
            });
            const transitioned = await updateUploadSessionStatus(env, uploadId, waitingPatch, {
                expectedJobId: mergeJobId,
                allowedStatuses: ['merging'],
                required: true
            });

            if (!transitioned) {
                const existingReceipt = await getMergeSuccessReceipt(env, uploadId).catch(() => null);
                if (existingReceipt?.mergeResult) {
                    return createMergeSuccessResponse(context, existingReceipt.mergeResult);
                }
                return createPendingMergeResponse(
                    uploadId,
                    'MERGE_IN_PROGRESS',
                    'Merge ownership changed before retry state was saved',
                    retryAfterMs,
                    result.statusSummary || {}
                );
            }

            return createPendingMergeResponse(
                uploadId,
                result.code,
                result.error || 'Merge is still in progress',
                retryAfterMs,
                result.statusSummary || {}
            );
        }

        throw new Error(result.error || 'Merge failed');

    } catch (error) {
        await stopHeartbeat();
        const successReceipt = await getMergeSuccessReceipt(env, uploadId).catch(() => null);
        if (successReceipt?.mergeResult) {
            return createMergeSuccessResponse(context, successReceipt.mergeResult);
        }
        if (isPotentiallyCommittedMergeError(error)) {
            await preservePotentialMergeSuccess(env, uploadId, mergeJobId, error);
            return createPendingMergeResponse(
                uploadId,
                'MERGE_IN_PROGRESS',
                'Merge completion is being reconciled',
                MERGE_PENDING_RETRY_AFTER_MS
            );
        }
        await updateUploadSessionStatus(env, uploadId, {
            status: 'merge_failed',
            mergeFailedAt: Date.now(),
            mergeError: error.message,
            mergeLeaseUntil: 0,
            mergeProtectedUntil: 0
        }, {
            expectedJobId: mergeJobId,
            allowedStatuses: ['merging', 'waiting_chunks']
        });

        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
}

// 基于渠道的合并处理
async function handleChannelBasedMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel) {
    const { request, env, url } = context;

    try {
        // 获得上传IP
        const uploadIp = getUploadIp(request);

        const normalizedFolder = sanitizeUploadFolder(url.searchParams.get('uploadFolder') || '');

        // 构建基础metadata
        const metadata = {
            FileName: originalFileName,
            FileType: originalFileType,
            FileSize: '0', // 会在最终合并后更新
            UploadIP: uploadIp,
            UploadAddress: await getIPAddress(env, uploadIp, context.securityConfig),
            ListType: "None",
            TimeStamp: Date.now(),
            Label: "None",
            Directory: normalizedFolder === '' ? '' : normalizedFolder + '/',
            Tags: []
        };

        const isChatUpload = isChatRequestFromUrl(url);
        if (isChatUpload) {
            applyChatTransferMetadata(metadata, 'file');
        }

        const initialSettleWaitMs = INITIAL_SETTLE_WAIT_MS;
        let chunkStatuses = await waitForChunksToSettle(env, uploadId, totalChunks, {
            maxWaitMs: initialSettleWaitMs,
            intervalMs: SETTLE_INTERVAL_MS
        });
        let completedChunks = chunkStatuses.filter(chunk => chunk.status === 'completed');
        let processingChunks = chunkStatuses.filter(isChunkStillProcessing);
        let failedChunks = chunkStatuses.filter(isChunkRetryableFailure);
        let terminalFailedChunks = chunkStatuses.filter(isChunkTerminalFailure);

        // 统计不同状态的分块
        const statusSummary = summarizeChunkStatuses(chunkStatuses);

        console.log(`Chunk status summary: ${JSON.stringify(statusSummary)}`);

        if (processingChunks.length > 0) {
            console.log(`Still waiting for ${processingChunks.length} chunks to finish uploading before merge`);

            chunkStatuses = await waitForChunksToSettle(env, uploadId, totalChunks, {
                maxWaitMs: FINAL_PENDING_GRACE_MS,
                intervalMs: SETTLE_INTERVAL_MS
            });
            completedChunks = chunkStatuses.filter(chunk => chunk.status === 'completed');
            processingChunks = chunkStatuses.filter(isChunkStillProcessing);
            failedChunks = chunkStatuses.filter(isChunkRetryableFailure);
            terminalFailedChunks = chunkStatuses.filter(isChunkTerminalFailure);
        }

        // 合并运行在 DO 中（无子请求限制），可以一次性重试所有失败分块。
        // 之前仅重试 2 个/次，12 个分块需要 6 次合并请求（每次间隔 10s grace），总计 60s+。
        // 前端在等待期间持续轮询 409，造成 660 次无意义请求。
        if (failedChunks.length > 0) {
            console.log(`Retrying all ${failedChunks.length} failed chunks (concurrency=${MERGE_RETRY_CONCURRENCY})`);
            await retryFailedChunks(context, failedChunks, uploadChannel, {
                maxRetries: 1,
                retryTimeout: MERGE_RETRY_TIMEOUT_MS,
                maxConcurrency: MERGE_RETRY_CONCURRENCY,
                batchSize: failedChunks.length
            });

            chunkStatuses = await getChunkUploadStatusesWithManifest(env, uploadId, totalChunks);
            completedChunks = chunkStatuses.filter(chunk => chunk.status === 'completed');
            processingChunks = chunkStatuses.filter(isChunkStillProcessing);
            failedChunks = chunkStatuses.filter(isChunkRetryableFailure);
            terminalFailedChunks = chunkStatuses.filter(isChunkTerminalFailure);

            if (completedChunks.length !== totalChunks && terminalFailedChunks.length === 0) {
                return {
                    success: false,
                    code: processingChunks.length > 0 ? 'MERGE_IN_PROGRESS' : 'CHUNKS_INCOMPLETE',
                    error: `Waiting for remaining chunks after a bounded retry. Status: ${JSON.stringify(summarizeChunkStatuses(chunkStatuses))}`,
                    retryAfterMs: MERGE_PENDING_RETRY_AFTER_MS,
                    statusSummary: summarizeChunkStatuses(chunkStatuses)
                };
            }
        }

        // 最终检查是否所有分块都完成
        if (completedChunks.length !== totalChunks) {
            const finalStatusSummary = summarizeChunkStatuses(chunkStatuses);

            if (terminalFailedChunks.length > 0) {
                return {
                    success: false,
                    code: 'CHUNKS_FAILED',
                    error: `Cannot merge: ${terminalFailedChunks.length} chunks are unrecoverable. Status: ${JSON.stringify(finalStatusSummary)}`,
                    statusSummary: finalStatusSummary,
                    failedChunks: terminalFailedChunks.map(chunk => ({
                        index: chunk.index,
                        status: chunk.status,
                        error: chunk.error || ''
                    }))
                };
            }

            if (processingChunks.length > 0) {
                return {
                    success: false,
                    code: 'MERGE_IN_PROGRESS',
                    error: `Merge is still in progress: ${processingChunks.length} chunks are still processing`,
                    retryAfterMs: MERGE_PENDING_RETRY_AFTER_MS,
                    statusSummary: finalStatusSummary
                };
            }

            return {
                success: false,
                code: 'CHUNKS_INCOMPLETE',
                error: `Only ${completedChunks.length}/${totalChunks} chunks completed. Status: ${JSON.stringify(finalStatusSummary)}`,
                retryAfterMs: MERGE_PENDING_RETRY_AFTER_MS,
                statusSummary: finalStatusSummary
            };
        }

        // 根据渠道合并分块信息
        let result;
        if (uploadChannel === 'cfr2') {
            result = await mergeR2ChunksInfo(context, uploadId, completedChunks, metadata);
        } else if (uploadChannel === 's3') {
            result = await mergeS3ChunksInfo(context, uploadId, completedChunks, metadata);
        } else if (uploadChannel === 'telegram') {
            result = await mergeTelegramChunksInfo(context, uploadId, completedChunks, metadata);
        } else if (uploadChannel === 'discord') {
            result = await mergeDiscordChunksInfo(context, uploadId, completedChunks, metadata);
        } else {
            throw new Error(`Unsupported upload channel: ${uploadChannel}`);
        }

        return result;

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

async function waitForChunksToSettle(env, uploadId, totalChunks, options = {}) {
    const maxWaitMs = options.maxWaitMs || INITIAL_SETTLE_WAIT_MS;
    const baseIntervalMs = options.intervalMs || SETTLE_INTERVAL_MS;
    const startedAt = Date.now();

    // 自适应轮询：首次快速检测（baseIntervalMs/2），逐步增长到 baseIntervalMs
    // 分片通常在客户端并发上传，完成时间接近，快速首次检测能更早发现完成状态
    let currentInterval = Math.max(baseIntervalMs / 2, 200);

    let statuses = await getChunkUploadStatusesWithManifest(env, uploadId, totalChunks);
    while (Date.now() - startedAt < maxWaitMs) {
        const inProgressCount = statuses.filter(isChunkStillProcessing).length;

        if (inProgressCount === 0) {
            return statuses;
        }

        await new Promise(resolve => setTimeout(resolve, currentInterval));
        // 逐步增长轮询间隔至上限，减少高频轮询开销
        currentInterval = Math.min(currentInterval * 1.3, baseIntervalMs);
        statuses = await getChunkUploadStatusesWithManifest(env, uploadId, totalChunks);
    }

    return statuses;
}

// 合并R2分块信息
async function mergeR2ChunksInfo(context, uploadId, completedChunks, metadata) {
    const { env, waitUntil, url, specifiedChannelName } = context;
    const db = getDatabase(env);

    try {
        const R2DataBase = env.img_r2;
        const multipartKey = `multipart_${uploadId}`;

        // 获取multipart info
        const multipartInfoData = await db.get(multipartKey);
        if (!multipartInfoData) {
            throw new Error('Multipart upload info not found');
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        // 组织所有分块
        const sortedChunks = completedChunks.sort((a, b) => a.index - b.index);
        const parts = [];

        for (const chunk of sortedChunks) {
            const part = {
                etag: chunk.uploadResult.etag,
                partNumber: chunk.uploadResult.partNumber,
            };
            parts.push(part);
        }

        // 完成multipart upload
        const multipartUpload = R2DataBase.resumeMultipartUpload(multipartInfo.key, multipartInfo.uploadId);
        await multipartUpload.complete(parts);

        // 计算总大小
        const totalSize = completedChunks.reduce((sum, chunk) => sum + chunk.uploadResult.size, 0);

        // 使用multipart info中的finalFileId更新metadata
        const finalFileId = multipartInfo.key;
        metadata.Channel = "CloudflareR2";
        // 从 R2 设置中获取渠道名称
        const r2Settings = context.uploadConfig.cfr2;
        const r2Channel = selectChannel(r2Settings, specifiedChannelName, uploadId);
        metadata.ChannelName = r2Channel?.name || "R2_env";
        metadata.FileSize = (totalSize / 1024 / 1024).toFixed(2);
        metadata.FileSizeBytes = totalSize;

        // 清理multipart info
        await db.delete(multipartKey);

        // 写入数据库
        cleanPersistedMetadataInPlace(metadata);
        await db.put(finalFileId, "", { metadata });

        // 结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 更新返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [buildUploadResult(context, updatedReturnLink)]
        };

    } catch (error) {
        throw new Error(`R2 merge failed: ${error.message}`);
    }
}

// 合并S3分块信息
async function mergeS3ChunksInfo(context, uploadId, completedChunks, metadata) {
    const { env, waitUntil, uploadConfig, url, specifiedChannelName } = context;
    const db = getDatabase(env);

    try {
        const s3Settings = uploadConfig.s3;

        // 选择渠道
        const s3Channel = selectChannel(s3Settings, specifiedChannelName, uploadId);

        if (!s3Channel) {
            throw new Error('No S3 channel provided');
        }

        console.log(`Merging S3 chunks for uploadId: ${uploadId}, selected channel: ${s3Channel.name || 'default'}`);

        const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

        const s3Client = new S3Client({
            region: region || "auto",
            endpoint,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: pathStyle
        });

        const multipartKey = `multipart_${uploadId}`;

        // 获取multipart info
        const multipartInfoData = await db.get(multipartKey);
        if (!multipartInfoData) {
            throw new Error('Multipart upload info not found');
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        // 组织所有分块
        const sortedChunks = completedChunks.sort((a, b) => a.index - b.index);
        const parts = [];

        for (const chunk of sortedChunks) {
            const part = {
                ETag: chunk.uploadResult.etag,
                PartNumber: chunk.uploadResult.partNumber
            };
            parts.push(part);
        }

        // 完成multipart upload
        await s3Client.send(new CompleteMultipartUploadCommand({
            Bucket: bucketName,
            Key: multipartInfo.key,
            UploadId: multipartInfo.uploadId,
            MultipartUpload: { Parts: parts }
        }));

        // 计算总大小
        const totalSize = completedChunks.reduce((sum, chunk) => sum + chunk.uploadResult.size, 0);

        // 使用multipart info中的finalFileId更新metadata
        const finalFileId = multipartInfo.key;
        metadata.Channel = "S3";
        metadata.ChannelName = s3Channel.name;
        metadata.FileSize = (totalSize / 1024 / 1024).toFixed(2);
        metadata.FileSizeBytes = totalSize;

        const s3ServerDomain = endpoint.replace(/https?:\/\//, "");
        if (pathStyle) {
            metadata.S3Location = `https://${s3ServerDomain}/${bucketName}/${finalFileId}`;
        } else {
            metadata.S3Location = `https://${bucketName}.${s3ServerDomain}/${finalFileId}`;
        }
        metadata.S3Endpoint = endpoint;
        metadata.S3PathStyle = pathStyle;
        metadata.S3AccessKeyId = accessKeyId;
        metadata.S3SecretAccessKey = secretAccessKey;
        metadata.S3Region = region || "auto";
        metadata.S3BucketName = bucketName;
        metadata.S3FileKey = finalFileId;

        // 清理multipart info
        await db.delete(multipartKey);

        // 写入数据库
        cleanPersistedMetadataInPlace(metadata);
        await db.put(finalFileId, "", { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 更新返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [buildUploadResult(context, updatedReturnLink)]
        };

    } catch (error) {
        throw new Error(`S3 merge failed: ${error.message}`);
    }
}

// 合并Telegram分块信息
async function mergeTelegramChunksInfo(context, uploadId, completedChunks, metadata) {
    const { env, waitUntil, uploadConfig, url, specifiedChannelName } = context;
    const db = getDatabase(env);

    try {
        const tgSettings = uploadConfig.telegram;

        // 按顺序排列分块
        const sortedChunks = completedChunks.sort((a, b) => a.index - b.index);

        if (sortedChunks.length === 0) {
            throw new Error('No completed Telegram chunks provided');
        }

        // 计算总大小
        const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.uploadResult.size, 0);

        const fallbackChannel = (() => {
            if (specifiedChannelName) {
                return tgSettings.channels.find(ch => ch.name === specifiedChannelName) || null;
            }
            return tgSettings.channels[0] || null;
        })();

        const firstChunkUploadResult = sortedChunks[0].uploadResult || {};
        const topLevelChannelName = firstChunkUploadResult.tgChannel || fallbackChannel?.name;
        const topLevelChatId = firstChunkUploadResult.tgChatId || fallbackChannel?.chatId;
        const topLevelBotToken = firstChunkUploadResult.tgBotToken || fallbackChannel?.botToken;
        const topLevelProxyUrl = firstChunkUploadResult.tgProxyUrl || fallbackChannel?.proxyUrl || '';

        console.log(`Merging Telegram chunks for uploadId: ${uploadId}, primary channel metadata: ${topLevelChannelName || 'default'}`);

        // 构建分块信息数组
        const chunks = sortedChunks.map(chunk => ({
            index: chunk.index,
            fileId: chunk.uploadResult.fileId,
            size: chunk.uploadResult.size,
            fileName: chunk.uploadResult.fileName,
            tgChannel: chunk.uploadResult.tgChannel || topLevelChannelName,
            tgBotToken: chunk.uploadResult.tgBotToken || topLevelBotToken,
            tgChatId: chunk.uploadResult.tgChatId || topLevelChatId,
            tgProxyUrl: chunk.uploadResult.tgProxyUrl || ''
        }));

        // 生成 finalFileId
        const finalFileId = await buildUniqueFileId(context, metadata.FileName, metadata.FileType);

        // 更新metadata
        metadata.Channel = "TelegramNew";
        if (topLevelChannelName) {
            metadata.ChannelName = topLevelChannelName;
        }
        if (topLevelChatId) {
            metadata.TgChatId = topLevelChatId;
        }
        if (topLevelBotToken) {
            metadata.TgBotToken = topLevelBotToken;
        }
        // 保存代理域名配置（如果有）
        if (topLevelProxyUrl) {
            metadata.TgProxyUrl = topLevelProxyUrl;
        }
        metadata.IsChunked = true;
        metadata.TotalChunks = completedChunks.length;
        metadata.FileSize = (totalSize / 1024 / 1024).toFixed(2);
        metadata.FileSizeBytes = totalSize;

        // 将分片信息存储到value中
        const chunksData = JSON.stringify(chunks);

        // 写入数据库
        cleanPersistedMetadataInPlace(metadata);
        await db.put(finalFileId, chunksData, { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 生成返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [buildUploadResult(context, updatedReturnLink)]
        };

    } catch (error) {
        throw new Error(`Telegram merge failed: ${error.message}`);
    }
}

// 合并Discord分块信息
async function mergeDiscordChunksInfo(context, uploadId, completedChunks, metadata) {
    const { env, waitUntil, uploadConfig, url, specifiedChannelName } = context;
    const db = getDatabase(env);

    try {
        const discordSettings = uploadConfig.discord;

        // 选择渠道
        const discordChannel = selectChannel(discordSettings, specifiedChannelName, uploadId);
        if (!discordChannel) {
            throw new Error('No Discord channel provided');
        }

        console.log(`Merging Discord chunks for uploadId: ${uploadId}, selected channel: ${discordChannel.name || 'default'}`);

        const botToken = discordChannel.botToken;
        const channelId = discordChannel.channelId;

        // 按顺序排列分块
        const sortedChunks = completedChunks.sort((a, b) => a.index - b.index);

        // 计算总大小
        const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.uploadResult.size, 0);

        // 构建分块信息数组（不存储 url 因为会过期，读取时通过 API 获取）
        const chunks = sortedChunks.map(chunk => ({
            index: chunk.index,
            messageId: chunk.uploadResult.messageId,
            // 注意：不存储 attachmentId 和 url，它们会在约24小时后过期
            size: chunk.uploadResult.size,
            fileName: chunk.uploadResult.fileName
        }));

        // 生成 finalFileId
        const finalFileId = await buildUniqueFileId(context, metadata.FileName, metadata.FileType);

        // 更新metadata
        metadata.Channel = "Discord";
        metadata.ChannelName = discordChannel.name;
        metadata.DiscordChannelId = channelId;
        metadata.DiscordBotToken = botToken;
        metadata.DiscordProxyUrl = discordChannel.proxyUrl || '';
        metadata.IsChunked = true;
        metadata.TotalChunks = completedChunks.length;
        metadata.FileSize = (totalSize / 1024 / 1024).toFixed(2);
        metadata.FileSizeBytes = totalSize;

        // 将分片信息存储到value中
        const chunksData = JSON.stringify(chunks);

        // 写入数据库
        cleanPersistedMetadataInPlace(metadata);
        await db.put(finalFileId, chunksData, { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 生成返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [buildUploadResult(context, updatedReturnLink)]
        };

    } catch (error) {
        throw new Error(`Discord merge failed: ${error.message}`);
    }
}
