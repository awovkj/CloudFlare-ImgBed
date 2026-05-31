/* ========== 分块合并处理 ========== */
import { createResponse, getUploadIp, getIPAddress, selectChannel, buildUniqueFileId, endUpload, buildReturnLink } from './uploadTools';
import { retryFailedChunks, checkChunkUploadStatuses, cleanupChunkData, cleanupUploadSession } from './chunkUpload';
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getDatabase } from '../utils/databaseAdapter.js';
import { applyChatTransferMetadata, isChatRequestFromUrl, isChatUploadChannel } from '../utils/chat.js';

const INITIAL_SETTLE_WAIT_MS = 30000;
const RETRY_SETTLE_WAIT_MS = 45000;
const CHAT_INITIAL_SETTLE_WAIT_MS = 120000;
const CHAT_RETRY_SETTLE_WAIT_MS = 180000;
const SETTLE_INTERVAL_MS = 500;
const FINAL_PENDING_GRACE_MS = 5000;
const MERGE_PENDING_RETRY_AFTER_MS = 1000;
const MERGE_BACKGROUND_MAX_ATTEMPTS = 5;
const MERGE_CLEANUP_PROTECTION_MS = 10 * 60 * 1000;

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
    return ['failed', 'timeout', 'retry_failed', 'retry_timeout'].includes(chunk.status);
}

async function updateUploadSessionStatus(env, uploadId, patch = {}) {
    try {
        const db = getDatabase(env);
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        if (!sessionData) {
            return;
        }

        const sessionInfo = JSON.parse(sessionData);
        const updatedSessionInfo = {
            ...sessionInfo,
            ...patch,
            lastUpdatedAt: Date.now()
        };

        await db.put(sessionKey, JSON.stringify(updatedSessionInfo), {
            expirationTtl: 3600
        });
    } catch (error) {
        console.warn(`Failed to update upload session status for ${uploadId}:`, error);
    }
}

async function getUploadSessionInfo(env, uploadId) {
    const db = getDatabase(env);
    const sessionKey = `upload_session_${uploadId}`;
    const sessionData = await db.get(sessionKey);
    if (!sessionData) {
        return null;
    }
    return JSON.parse(sessionData);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        originalFileType = formdata.get('originalFileType');

        if (!uploadId || !totalChunks || !originalFileName) {
            return createResponse('Error: Missing merge parameters', { status: 400 });
        }

        // 验证上传会话
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        if (!sessionData) {
            return createResponse('Error: Invalid or expired upload session', { status: 400 });
        }

        const sessionInfo = JSON.parse(sessionData);
        const now = Date.now();

        // 如果后台合并已经成功，直接返回保存的结果（供前端轮询拿到结果）
        if (sessionInfo.status === 'merge_success' && sessionInfo.mergeResult) {
            return createResponse(JSON.stringify(sessionInfo.mergeResult), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
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

        const mergeProtectedUntil = Number(sessionInfo.mergeProtectedUntil || 0);
        const mergeExpired = sessionInfo.status === 'merging'
            && mergeProtectedUntil
            && now >= mergeProtectedUntil;

        if (mergeExpired) {
            const mergeError = sessionInfo.mergeBackgroundError
                || sessionInfo.mergeError
                || `Merge did not finish within ${MERGE_CLEANUP_PROTECTION_MS}ms`;

            await updateUploadSessionStatus(env, uploadId, {
                status: 'merge_failed',
                mergeFailedAt: now,
                mergeError,
                mergeProtectedUntil: 0
            });

            return createResponse(JSON.stringify({
                success: false,
                code: 'MERGE_TIMEOUT',
                message: mergeError,
                uploadId,
                statusSummary: sessionInfo.mergeLastStatusSummary || {},
                mergeBackgroundAttempt: sessionInfo.mergeBackgroundAttempt || 0
            }), {
                status: 504,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const mergeIsOngoing = sessionInfo.status === 'merging'
            && mergeProtectedUntil
            && now < mergeProtectedUntil;
        if (mergeIsOngoing) {
            return createResponse(JSON.stringify({
                success: false,
                code: 'MERGE_IN_PROGRESS',
                message: 'Merge is already in progress',
                uploadId,
                retryAfterMs: MERGE_PENDING_RETRY_AFTER_MS,
                statusSummary: sessionInfo.mergeLastStatusSummary || {}
            }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' }
            });
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

        // 获取指定的渠道名称（优先URL参数，其次会话信息）
        const channelName = url.searchParams.get('channelName') || sessionInfo.channelName || '';
        context.specifiedChannelName = channelName;

        // 检查分块上传状态
        const chunkStatuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);

        // 输出初始状态摘要
        const initialStatusSummary = summarizeChunkStatuses(chunkStatuses);
        console.log(`Initial chunk status summary: ${JSON.stringify(initialStatusSummary)}`);

        await updateUploadSessionStatus(env, uploadId, {
            status: 'merging',
            mergeStartedAt: Date.now(),
            mergeLastStatusSummary: initialStatusSummary,
            mergeProtectedUntil: Date.now() + MERGE_CLEANUP_PROTECTION_MS
        });

        // 开始合并处理
        return await startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel);

    } catch (error) {
        await updateUploadSessionStatus(env, uploadId, {
            status: 'merge_failed',
            mergeFailedAt: Date.now(),
            mergeError: error.message
        });
        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
}

// 开始合并处理
async function startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel) {
    const { env, waitUntil } = context;

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
        const result = await handleChannelBasedMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel);

        if (result.success) {
            // 清理临时分块数据
            await cleanupChunkData(env, uploadId, totalChunks, { ignoreMergeProtection: true });

            // 清理上传会话
            await cleanupUploadSession(env, uploadId);

            return createResponse(JSON.stringify(result.result), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (result.code === 'MERGE_IN_PROGRESS' || result.code === 'CHUNKS_INCOMPLETE') {
            await updateUploadSessionStatus(env, uploadId, {
                status: 'merging',
                mergeLastPendingAt: Date.now(),
                mergeLastStatusSummary: result.statusSummary || {},
                mergeProtectedUntil: Date.now() + MERGE_CLEANUP_PROTECTION_MS
            });

            waitUntil(finalizeMergeInBackground(context, {
                uploadId,
                totalChunks,
                originalFileName,
                originalFileType,
                uploadChannel,
                initialRetryAfterMs: result.retryAfterMs || MERGE_PENDING_RETRY_AFTER_MS
            }));

            return createResponse(JSON.stringify({
                success: false,
                code: result.code,
                message: result.error || 'Merge is still in progress',
                uploadId,
                retryAfterMs: result.retryAfterMs || MERGE_PENDING_RETRY_AFTER_MS,
                statusSummary: result.statusSummary || {}
            }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        throw new Error(result.error || 'Merge failed');

    } catch (error) {
        await updateUploadSessionStatus(env, uploadId, {
            status: 'merge_failed',
            mergeFailedAt: Date.now(),
            mergeError: error.message
        });

        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
}

async function finalizeMergeInBackground(context, params) {
    const {
        uploadId,
        totalChunks,
        originalFileName,
        originalFileType,
        uploadChannel,
        initialRetryAfterMs
    } = params;
    const { env } = context;

    let retryAfterMs = initialRetryAfterMs || MERGE_PENDING_RETRY_AFTER_MS;

    for (let attempt = 1; attempt <= MERGE_BACKGROUND_MAX_ATTEMPTS; attempt++) {
        try {
            const currentSession = await getUploadSessionInfo(env, uploadId);
            if (!currentSession) {
                return;
            }

            if (currentSession.status !== 'merging') {
                return;
            }

            await updateUploadSessionStatus(env, uploadId, {
                mergeBackgroundAttempt: attempt,
                mergeProtectedUntil: Date.now() + MERGE_CLEANUP_PROTECTION_MS
            });

            await sleep(retryAfterMs);

            const result = await handleChannelBasedMerge(
                context,
                uploadId,
                totalChunks,
                originalFileName,
                originalFileType,
                uploadChannel
            );

            const latestSession = await getUploadSessionInfo(env, uploadId);
            if (!latestSession || latestSession.status !== 'merging') {
                return;
            }

            if (result.success) {
                await updateUploadSessionStatus(env, uploadId, {
                    status: 'merge_success',
                    mergeCompletedAt: Date.now(),
                    mergeResult: result.result
                });
                await cleanupChunkData(env, uploadId, totalChunks, { ignoreMergeProtection: true });
                return;
            }

            if (result.code === 'MERGE_IN_PROGRESS' || result.code === 'CHUNKS_INCOMPLETE') {
                retryAfterMs = result.retryAfterMs || MERGE_PENDING_RETRY_AFTER_MS;

                await updateUploadSessionStatus(env, uploadId, {
                    status: 'merging',
                    mergeLastPendingAt: Date.now(),
                    mergeLastStatusSummary: result.statusSummary || {},
                    mergeProtectedUntil: Date.now() + MERGE_CLEANUP_PROTECTION_MS,
                    mergeBackgroundAttempt: attempt
                });

                continue;
            }

            throw new Error(result.error || 'Background merge failed');
        } catch (error) {
            const latestSession = await getUploadSessionInfo(env, uploadId);
            if (!latestSession || latestSession.status !== 'merging') {
                return;
            }

            const finalAttempt = attempt >= MERGE_BACKGROUND_MAX_ATTEMPTS;
            await updateUploadSessionStatus(env, uploadId, {
                status: finalAttempt ? 'merge_failed' : 'merging',
                mergeBackgroundError: error.message,
                mergeBackgroundErrorAt: Date.now(),
                mergeBackgroundAttempt: attempt,
                mergeFailedAt: finalAttempt ? Date.now() : undefined,
                mergeError: finalAttempt ? error.message : undefined,
                mergeProtectedUntil: finalAttempt ? 0 : Date.now() + MERGE_CLEANUP_PROTECTION_MS
            });
            if (finalAttempt) {
                return;
            }
            retryAfterMs = MERGE_PENDING_RETRY_AFTER_MS;
            continue;
        }
    }

    await updateUploadSessionStatus(env, uploadId, {
        status: 'merge_failed',
        mergeBackgroundError: `Background merge exceeded max attempts (${MERGE_BACKGROUND_MAX_ATTEMPTS})`,
        mergeBackgroundErrorAt: Date.now(),
        mergeFailedAt: Date.now(),
        mergeError: `Background merge exceeded max attempts (${MERGE_BACKGROUND_MAX_ATTEMPTS})`,
        mergeBackgroundAttempt: MERGE_BACKGROUND_MAX_ATTEMPTS,
        mergeProtectedUntil: 0
    });
}

// 基于渠道的合并处理
async function handleChannelBasedMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel) {
    const { request, env, url } = context;

    try {
        // 获得上传IP
        const uploadIp = getUploadIp(request);

        const normalizedFolder = (url.searchParams.get('uploadFolder') || '').replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');

        // 构建基础metadata
        const metadata = {
            FileName: originalFileName,
            FileType: originalFileType,
            FileSize: '0', // 会在最终合并后更新
            UploadIP: uploadIp,
            UploadAddress: await getIPAddress(uploadIp),
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

        const initialSettleWaitMs = isChatUpload ? CHAT_INITIAL_SETTLE_WAIT_MS : INITIAL_SETTLE_WAIT_MS;
        const retrySettleWaitMs = isChatUpload ? CHAT_RETRY_SETTLE_WAIT_MS : RETRY_SETTLE_WAIT_MS;

        let chunkStatuses = await waitForChunksToSettle(env, uploadId, totalChunks, {
            maxWaitMs: initialSettleWaitMs,
            intervalMs: SETTLE_INTERVAL_MS
        });
        let completedChunks = chunkStatuses.filter(chunk => chunk.status === 'completed');
        let processingChunks = chunkStatuses.filter(isChunkStillProcessing);
        let failedChunks = chunkStatuses.filter(isChunkRetryableFailure);

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
        }

        // 如果有失败的分块，尝试重试
        if (failedChunks.length > 0) {
            console.log(`Retrying ${failedChunks.length} failed chunks...`);
            // 同步重试（await）
            await retryFailedChunks(context, failedChunks, uploadChannel);

            chunkStatuses = await waitForChunksToSettle(env, uploadId, totalChunks, {
                maxWaitMs: retrySettleWaitMs,
                intervalMs: SETTLE_INTERVAL_MS
            });
            completedChunks = chunkStatuses.filter(chunk => chunk.status === 'completed');
            processingChunks = chunkStatuses.filter(isChunkStillProcessing);
            failedChunks = chunkStatuses.filter(isChunkRetryableFailure);
        }

        // 最终检查是否所有分块都完成
        if (completedChunks.length !== totalChunks) {
            const finalStatusSummary = summarizeChunkStatuses(chunkStatuses);

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
    const intervalMs = options.intervalMs || SETTLE_INTERVAL_MS;
    const startedAt = Date.now();

    let statuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);
    while (Date.now() - startedAt < maxWaitMs) {
        const inProgressCount = statuses.filter(isChunkStillProcessing).length;

        if (inProgressCount === 0) {
            return statuses;
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
        statuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);
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
        await db.put(finalFileId, "", { metadata });

        // 结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 更新返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [{ 'src': updatedReturnLink }]
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
        await db.put(finalFileId, "", { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 更新返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [{ src: updatedReturnLink }]
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
        await db.put(finalFileId, chunksData, { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 生成返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [{ 'src': updatedReturnLink }]
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
        await db.put(finalFileId, chunksData, { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 生成返回链接
        const updatedReturnLink = buildReturnLink(url, finalFileId);

        return {
            success: true,
            result: [{ 'src': updatedReturnLink }]
        };

    } catch (error) {
        throw new Error(`Discord merge failed: ${error.message}`);
    }
}
