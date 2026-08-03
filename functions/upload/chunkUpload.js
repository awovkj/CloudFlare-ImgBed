/* ======= 客户端分块上传处理 ======= */
import { createResponse, selectConsistentChannel, getUploadIp, getIPAddress, buildUniqueFileId, endUpload } from './uploadTools.js';
import { buildUploadResults, createUploadJsonResponse } from './uploadShared.js';
import { uploadError, validateChunkInitialization } from './chunkProtocol.js';
import { TelegramAPI } from '../utils/telegramAPI.js';
import { DiscordAPI } from '../utils/discordAPI.js';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getDatabase, checkDatabaseConfig } from '../utils/databaseAdapter.js';
import { applyChatTransferMetadata, isChatRequestFromUrl, isChatUploadChannel } from '../utils/chat.js';
import { cleanPersistedMetadataInPlace } from '../utils/metadata/metadataSecurity.js';
import { assertRouteUploadIdMatches, createRouteUploadIdMismatchResponse } from '../../src/uploadRequestRouting.js';
import { isCleanupProtectedByMerge } from './chunkMergeState.js';

const CHUNK_UPLOAD_TIMEOUT_MS = 60000;
const CHUNK_STATUS_TIMEOUT_GRACE_MS = 20000;
const DEFAULT_UPLOAD_SESSION_TTL_SECONDS = 3600;
const CHAT_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_UPLOAD_SESSION_TTL_SECONDS = 24 * 60 * 60;

function getChunkRecordTtlSeconds(contextOrUrl) {
    const url = contextOrUrl?.url || contextOrUrl;
    return isChatRequestFromUrl(url) ? CHAT_UPLOAD_SESSION_TTL_SECONDS : DEFAULT_UPLOAD_SESSION_TTL_SECONDS;
}

function getUploadManifestKey(uploadId) {
    return `upload_manifest_${uploadId}`;
}

function summarizeManifestChunks(chunks = {}) {
    return Object.values(chunks).reduce((acc, chunk) => {
        const status = chunk?.status || 'unknown';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
    }, {});
}

export async function getUploadManifest(env, uploadId) {
    try {
        const db = getDatabase(env);
        const manifestData = await db.get(getUploadManifestKey(uploadId));
        return manifestData ? JSON.parse(manifestData) : null;
    } catch (error) {
        console.warn(`Failed to read upload manifest for ${uploadId}:`, error);
        return null;
    }
}

async function putUploadManifest(env, uploadId, manifest, contextOrUrl = null) {
    const db = getDatabase(env);
    const chunks = manifest.chunks || {};
    const updatedManifest = {
        ...manifest,
        uploadId,
        chunks,
        statusSummary: summarizeManifestChunks(chunks),
        updatedAt: Date.now()
    };

    await db.put(getUploadManifestKey(uploadId), JSON.stringify(updatedManifest), {
        expirationTtl: getChunkRecordTtlSeconds(contextOrUrl)
    });

    return updatedManifest;
}

export async function updateUploadManifestChunk(env, uploadId, chunkIndex, patch = {}, contextOrUrl = null) {
    try {
        const manifest = await getUploadManifest(env, uploadId) || {
            uploadId,
            totalChunks: patch.totalChunks || 0,
            originalFileName: patch.originalFileName || '',
            originalFileType: patch.originalFileType || 'application/octet-stream',
            uploadChannel: patch.uploadChannel || '',
            chunks: {},
            createdAt: Date.now()
        };

        const key = String(chunkIndex);
        manifest.chunks = manifest.chunks || {};
        const existingChunk = manifest.chunks[key];
        // 防止 waitUntil 延迟写入的 'uploading' 状态覆盖已写入的 'completed' 终态。
        // 'completed' 是终态，不应被回退为 'uploading'/'retrying' 等中间态。
        if (existingChunk
            && existingChunk.status === 'completed'
            && patch.status
            && patch.status !== 'completed') {
            console.warn(`Skipping manifest update for chunk ${chunkIndex}: cannot regress 'completed' to '${patch.status}'`);
            return manifest;
        }
        manifest.chunks[key] = {
            ...(manifest.chunks[key] || {}),
            ...patch,
            index: chunkIndex,
            updatedAt: Date.now()
        };

        if (patch.totalChunks && !manifest.totalChunks) manifest.totalChunks = patch.totalChunks;
        if (patch.originalFileName && !manifest.originalFileName) manifest.originalFileName = patch.originalFileName;
        if (patch.originalFileType && !manifest.originalFileType) manifest.originalFileType = patch.originalFileType;
        if (patch.uploadChannel && !manifest.uploadChannel) manifest.uploadChannel = patch.uploadChannel;

        return await putUploadManifest(env, uploadId, manifest, contextOrUrl);
    } catch (error) {
        console.warn(`Failed to update upload manifest for ${uploadId} chunk ${chunkIndex}:`, error);
        return null;
    }
}

// 初始化分块上传
export async function initializeChunkedUpload(context) {
    const { request, env, url } = context;
    const db = getDatabase(env);

    try {
        // 解析表单数据
        const formdata = await request.formData();

        const originalFileName = formdata.get('originalFileName');
        const originalFileType = formdata.get('originalFileType') || 'application/octet-stream';
        const initialization = validateChunkInitialization({
            totalChunks: formdata.get('totalChunks'),
            fileSize: formdata.get('fileSize'),
            chunkSize: formdata.get('chunkSize'),
            fileFingerprint: formdata.get('fileFingerprint')
        });

        if (!originalFileName) {
            return createUploadJsonResponse(uploadError(
                'INVALID_CHUNK_REQUEST',
                'Invalid chunk upload initialization parameters'
            ), 400);
        }

        if (!initialization.ok) {
            return createUploadJsonResponse(uploadError(
                initialization.code,
                'Invalid chunk upload initialization parameters'
            ), 400);
        }

        const { totalChunks, fileSize, chunkSize, fileFingerprint } = initialization;
        const optionalInitializationMetadata = {
            ...(fileSize !== undefined ? { fileSize } : {}),
            ...(chunkSize !== undefined ? { chunkSize } : {}),
            ...(fileFingerprint !== undefined ? { fileFingerprint } : {})
        };

        // 断点续传：基于 fileFingerprint 查找未过期的已有会话
        // 客户端中断后重新初始化时，若文件指纹匹配且会话未过期，复用原 uploadId 并返回已完成分片列表
        if (fileFingerprint) {
            const fingerprintIndexKey = `upload_fp_${fileFingerprint}`;
            try {
                const existingUploadId = await db.get(fingerprintIndexKey);
                if (existingUploadId) {
                    const existingSessionData = await db.get(`upload_session_${existingUploadId}`);
                    if (existingSessionData) {
                        const existingSession = JSON.parse(existingSessionData);
                        // 校验会话未过期且参数匹配（防止不同文件撞指纹）
                        if (Date.now() < existingSession.expiresAt
                            && !['merge_success', 'merge_failed'].includes(existingSession.status)
                            && existingSession.totalChunks === totalChunks
                            && existingSession.originalFileName === originalFileName) {
                            // 复用已有会话，查询已完成分片
                            const chunkStatuses = await getChunkUploadStatusesWithManifest(env, existingUploadId, totalChunks);
                            const uploadedChunks = chunkStatuses
                                .filter(c => c.status === 'completed')
                                .map(c => c.index);
                            const failedChunks = chunkStatuses
                                .filter(c => ['failed', 'timeout', 'retry_failed'].includes(c.status))
                                .map(c => c.index);

                            return createUploadJsonResponse({
                                success: true,
                                uploadId: existingUploadId,
                                resumed: true,
                                message: 'Resumed existing upload session',
                                sessionInfo: {
                                    uploadId: existingUploadId,
                                    originalFileName,
                                    totalChunks,
                                    uploadChannel: existingSession.uploadChannel,
                                    channelName: existingSession.channelName
                                },
                                uploadedChunks,
                                failedChunks
                            });
                        }
                    }
                }
            } catch (resumeError) {
                // 断点续传查询失败时降级为创建新会话，不阻塞上传
                console.warn('Failed to resume upload session:', resumeError.message);
            }
        }

        // 生成唯一的 uploadId
        const timestamp = Date.now();
        const uploadId = `upload_${crypto.randomUUID()}`;

        // 获取上传IP
        const uploadIp = getUploadIp(request);
        const ipAddress = await getIPAddress(env, uploadIp, context.securityConfig);

        // 获取上传渠道
        const uploadChannel = url.searchParams.get('uploadChannel') || 'telegram';
        // 获取指定的渠道名称
        const channelName = url.searchParams.get('channelName') || '';

        if (isChatRequestFromUrl(url) && !isChatUploadChannel(uploadChannel)) {
            return createUploadJsonResponse(uploadError(
                'INVALID_UPLOAD_CHANNEL',
                'Chat uploads only support Telegram channels'
            ), 400);
        }

        // WebDAV 渠道不支持分块上传（PUT 单请求写入，无法合并分块）
        if (uploadChannel === 'webdav') {
            return createUploadJsonResponse(uploadError(
                'INVALID_UPLOAD_CHANNEL',
                'WebDAV channel does not support chunked uploads. Please use non-chunked upload within your Cloudflare request body limit.'
            ), 400);
        }

        const isChatUpload = isChatRequestFromUrl(url);
        const sessionTtlMs = isChatUpload ? CHAT_UPLOAD_SESSION_TTL_MS : 3600000;
        const sessionTtlSeconds = getChunkRecordTtlSeconds(url);

        // 存储上传会话信息
        const sessionInfo = {
            schemaVersion: 2,
            revision: 0,
            uploadId,
            originalFileName,
            originalFileType,
            totalChunks,
            ...optionalInitializationMetadata,
            uploadChannel,
            channelName,
            uploadIp,
            ipAddress,
            status: 'initialized',
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: timestamp + sessionTtlMs
        };

        // 保存会话信息
        const sessionKey = `upload_session_${uploadId}`;
        await db.put(sessionKey, JSON.stringify(sessionInfo), {
            expirationTtl: sessionTtlSeconds
        });

        // 写入指纹索引（用于断点续传查找），TTL 与会话一致
        if (fileFingerprint) {
            const fingerprintIndexKey = `upload_fp_${fileFingerprint}`;
            await db.put(fingerprintIndexKey, uploadId, {
                expirationTtl: sessionTtlSeconds
            });
        }

        await putUploadManifest(env, uploadId, {
            schemaVersion: 2,
            revision: 0,
            uploadId,
            originalFileName,
            originalFileType,
            totalChunks,
            ...optionalInitializationMetadata,
            uploadChannel,
            channelName,
            status: 'initialized',
            chunks: {},
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: timestamp + sessionTtlMs
        }, url);

        return createUploadJsonResponse({
            success: true,
            uploadId,
            message: 'Chunked upload initialized successfully',
            sessionInfo: {
                uploadId,
                originalFileName,
                totalChunks,
                uploadChannel,
                channelName
            }
        });

    } catch (error) {
        console.error('Failed to initialize chunked upload:', error);
        return createUploadJsonResponse(uploadError(
            'CHUNK_INITIALIZATION_FAILED',
            'Failed to initialize chunked upload'
        ), 500);
    }
}

// 处理客户端分块上传
export async function handleChunkUpload(context) {
    const { env, request, url, waitUntil } = context;
    const db = getDatabase(env);

    // 解析表单数据
    const formdata = await request.formData();
    context.formdata = formdata;

    try {
        const chunk = formdata.get('file');
        const chunkIndex = parseInt(formdata.get('chunkIndex'));
        const totalChunks = parseInt(formdata.get('totalChunks'));
        const uploadId = formdata.get('uploadId');
        const originalFileName = formdata.get('originalFileName');
        const originalFileType = formdata.get('originalFileType') || 'application/octet-stream';

        try {
            assertRouteUploadIdMatches(context.data?.routeUploadId, uploadId);
        } catch (error) {
            return createRouteUploadIdMismatchResponse(error);
        }

        if (!chunk || Number.isNaN(chunkIndex) || !totalChunks || !uploadId || !originalFileName || (originalFileType === null || originalFileType === undefined)) {
            return createResponse('Error: Missing chunk upload parameters', { status: 400 });
        }

        // 验证上传会话
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        if (!sessionData) {
            return createResponse('Error: Invalid or expired upload session', { status: 400 });
        }

        const sessionInfo = JSON.parse(sessionData);

        // 验证会话信息
        if (sessionInfo.originalFileName !== originalFileName ||
            sessionInfo.totalChunks !== totalChunks) {
            return createResponse('Error: Session parameters mismatch', { status: 400 });
        }

        // 检查会话是否过期
        if (Date.now() > sessionInfo.expiresAt) {
            return createResponse('Error: Upload session expired', { status: 410 });
        }

        // 获取上传渠道
        const uploadChannel = url.searchParams.get('uploadChannel') || sessionInfo.uploadChannel || 'telegram';
        // 获取指定的渠道名称
        const channelName = url.searchParams.get('channelName') || sessionInfo.channelName || '';

        if (isChatRequestFromUrl(url) && !isChatUploadChannel(uploadChannel)) {
            return createResponse('Error: Chat uploads only support Telegram channels', { status: 400 });
        }

        // WebDAV 渠道不支持分块上传
        if (uploadChannel === 'webdav') {
            return createResponse('Error: WebDAV channel does not support chunked uploads. Please use non-chunked upload within your Cloudflare request body limit.', { status: 400 });
        }

        // 将渠道名称存入 context
        context.specifiedChannelName = channelName;

        // 立即创建分块记录，标记为"uploading"状态
        const chunkKey = `chunk_${uploadId}_${chunkIndex.toString().padStart(3, '0')}`;
        const chunkData = await chunk.arrayBuffer();
        const uploadStartTime = Date.now();
        const initialChunkMetadata = {
            uploadId,
            chunkIndex,
            totalChunks,
            originalFileName,
            originalFileType,
            chunkSize: chunkData.byteLength,
            uploadTime: uploadStartTime,
            uploadStartTime: uploadStartTime,
            status: 'uploading',
            uploadChannel,
            timeoutThreshold: uploadStartTime + CHUNK_UPLOAD_TIMEOUT_MS + CHUNK_STATUS_TIMEOUT_GRACE_MS
        };

        // 立即保存分块记录和数据，设置过期时间
        const { usingD1 } = checkDatabaseConfig(env);
        const chunkTtlSeconds = getChunkRecordTtlSeconds(url);

        // 性能优化：chunkData 的 KV 写入与 Telegram 上传无依赖关系，并行执行以隐藏 KV 写入延迟。
        // chunkData 在内存中已通过 chunk.arrayBuffer() 获得，TG 上传直接使用内存数据，无需等待 KV 落盘。
        const chunkDataWritePromise = db.put(chunkKey, usingD1 ? '' : chunkData, {
            metadata: initialChunkMetadata,
            expirationTtl: chunkTtlSeconds
        });

        // manifest 更新为状态记录（非关键路径）：用 waitUntil 后台执行，不阻塞上传主流程。
        // 失败时 updateUploadManifestChunk 内部已捕获异常，不影响请求。
        // 修复2中的防回退守卫确保延迟写入不会覆盖已写入的 'completed' 状态。
        if (waitUntil) {
            waitUntil(updateUploadManifestChunk(env, uploadId, chunkIndex, initialChunkMetadata, context));
        } else {
            updateUploadManifestChunk(env, uploadId, chunkIndex, initialChunkMetadata, context).catch(() => {});
        }

        const uploadOutcome = await uploadChunkToStorageWithTimeout(
            context,
            chunkIndex,
            totalChunks,
            uploadId,
            originalFileName,
            originalFileType,
            uploadChannel,
            usingD1 ? chunkData : undefined
        );

        // 确保 chunkData 写入完成：merge 阶段依赖 KV 中的 chunk 数据（纯 KV 模式下）。
        // 通常 TG 上传耗时远大于 KV 写入，此处 await 几乎不会增加额外等待。
        await chunkDataWritePromise;

        if (!uploadOutcome.success) {
            return createUploadJsonResponse({
                success: true,
                message: `Chunk ${chunkIndex + 1}/${totalChunks} received; storage upload will be retried during merge`,
                uploadId,
                chunkIndex,
                deferred: true,
                deferredReason: uploadOutcome.error || 'Unknown upload error'
            });
        }

        return createUploadJsonResponse({
            success: true,
            message: `Chunk ${chunkIndex + 1}/${totalChunks} received and being uploaded`,
            uploadId,
            chunkIndex
        });

    } catch (error) {
        return createResponse(`Error: Failed to upload chunk - ${error.message}`, { status: 500 });
    }
}

// 处理清理请求
export async function handleCleanupRequest(context, uploadId, totalChunks) {
    const { env } = context;

    try {
        if (!uploadId) {
            return createUploadJsonResponse({
                error: 'Missing uploadId parameter'
            }, 400);
        }

        // 强制清理所有相关数据
        const cleanupResult = await forceCleanupUpload(context, uploadId, totalChunks);

        if (cleanupResult?.skipped && cleanupResult.reason === 'MERGE_IN_PROGRESS') {
            return createUploadJsonResponse({
                success: false,
                code: 'MERGE_IN_PROGRESS',
                message: 'Merge is still in progress, cleanup skipped to avoid upload loop',
                uploadId,
                retryAfterMs: 5000,
                mergeLastStatusSummary: cleanupResult.sessionInfo?.mergeLastStatusSummary || {}
            }, 409);
        }

        return createUploadJsonResponse({
            success: true,
            message: `Cleanup completed for upload ${uploadId}`,
            uploadId: uploadId,
            cleanedChunks: totalChunks
        });

    } catch (error) {
        return createUploadJsonResponse({
            error: `Cleanup failed: ${error.message}`,
            uploadId: uploadId
        }, 500);
    }
}

/* ======= 单个分块上传到不同渠道的存储端 ======= */

// 带超时保护的异步上传分块到存储端
async function uploadChunkToStorageWithTimeout(context, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType, uploadChannel, chunkData) {
    const { env } = context;
    const db = getDatabase(env);
    const chunkKey = `chunk_${uploadId}_${chunkIndex.toString().padStart(3, '0')}`;

    try {
        // 设置超时 Promise
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Upload timeout')), CHUNK_UPLOAD_TIMEOUT_MS);
        });

        // 执行实际上传
        const uploadPromise = uploadChunkToStorage(context, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType, uploadChannel, chunkData);

        // 竞速执行
        const uploadResult = await Promise.race([uploadPromise, timeoutPromise]);

        if (!uploadResult || !uploadResult.success) {
            throw new Error(uploadResult?.error || 'Chunk upload failed');
        }

        return {
            success: true
        };

    } catch (error) {
        console.error(`Chunk ${chunkIndex} upload failed or timed out:`, error);

        // 超时或失败时，更新状态为超时/失败
        try {
            const chunkRecord = await db.getWithMetadata(chunkKey, { type: 'arrayBuffer' });
            if (chunkRecord && chunkRecord.metadata) {
                const isTimeout = error.message === 'Upload timeout';
                const errorMetadata = {
                    ...chunkRecord.metadata,
                    status: isTimeout ? 'timeout' : 'failed',
                    error: error.message,
                    failedTime: Date.now(),
                    isTimeout: isTimeout
                };

                // 保留原始数据以便重试（D1模式下不保存二进制数据，避免SQLITE_TOOBIG）
                const { usingD1 } = checkDatabaseConfig(env);
                const fallbackChunkValue = usingD1 ? '' : ((chunkRecord.value && chunkRecord.value.byteLength > 0)
                    ? chunkRecord.value
                    : (chunkData !== undefined ? chunkData : ''));

                await db.put(chunkKey, fallbackChunkValue, {
                    metadata: errorMetadata,
                    expirationTtl: getChunkRecordTtlSeconds(context)
                });
                await updateUploadManifestChunk(env, uploadId, chunkIndex, {
                    ...errorMetadata,
                    hasData: Boolean(fallbackChunkValue && fallbackChunkValue.byteLength > 0)
                }, context);
            }
        } catch (metaError) {
            console.error('Failed to save timeout/error metadata:', metaError);
        }

        return {
            success: false,
            error: error.message
        };
    }
}

// 异步上传分块到存储端，失败自动重试
async function uploadChunkToStorage(context, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType, uploadChannel, chunkData) {
    const { env } = context;
    const db = getDatabase(env);

    const chunkKey = `chunk_${uploadId}_${chunkIndex.toString().padStart(3, '0')}`;

    const MAX_RETRIES = 3;

    try {
        let chunkMetadata;

        if (chunkData !== undefined) {
            const chunkRecord = await db.getWithMetadata(chunkKey);
            chunkMetadata = (chunkRecord && chunkRecord.metadata) ? chunkRecord.metadata : {};
        } else {
            // 从数据库分块数据和metadata
            const chunkRecord = await db.getWithMetadata(chunkKey, { type: 'arrayBuffer' });
            if (!chunkRecord || !chunkRecord.value) {
                console.error(`Chunk ${chunkIndex} data not found in database`);
                return {
                    success: false,
                    error: 'Chunk data not found in database'
                };
            }

            chunkData = chunkRecord.value;
            chunkMetadata = chunkRecord.metadata;
        }

        for (let retry = 0; retry < MAX_RETRIES; retry++) {
            if (retry > 0) {
                const delay = Math.min(300 * Math.pow(2, retry - 1), 2000);
                console.log(`Chunk ${chunkIndex} retry ${retry}/${MAX_RETRIES}, waiting ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            // 根据渠道上传分块
            let uploadResult = null;

            try {
                if (uploadChannel === 'cfr2') {
                    uploadResult = await uploadSingleChunkToR2Multipart(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType);
                } else if (uploadChannel === 's3') {
                    uploadResult = await uploadSingleChunkToS3Multipart(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType);
                } else if (uploadChannel === 'telegram') {
                    uploadResult = await uploadSingleChunkToTelegram(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType);
                } else if (uploadChannel === 'discord') {
                    uploadResult = await uploadSingleChunkToDiscord(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType);
                }
            } catch (uploadError) {
                console.warn(`Chunk ${chunkIndex} attempt ${retry + 1} threw error: ${uploadError.message}`);
                uploadResult = { success: false, error: uploadError.message };
            }

            if (uploadResult && uploadResult.success) {
                // 上传成功，更新状态并保存上传信息
                const updatedMetadata = {
                    ...chunkMetadata,
                    status: 'completed',
                    uploadResult: uploadResult,
                    retryCount: retry,
                    completedTime: Date.now()
                };

                // 只保存metadata，不保存原始数据，设置过期时间
                await db.put(chunkKey, '', {
                    metadata: updatedMetadata,
                    expirationTtl: getChunkRecordTtlSeconds(context)                });
                await updateUploadManifestChunk(env, uploadId, chunkIndex, {
                    ...updatedMetadata,
                    hasData: false
                }, context);

                console.log(`Chunk ${chunkIndex} uploaded successfully to ${uploadChannel}${retry > 0 ? ` (after ${retry} retries)` : ''}`);

                return {
                    success: true,
                    uploadResult
                };
            } else if (retry === MAX_RETRIES - 1) {
                // 最后一次上传失败，标记为失败状态并保留原始数据以便重试
                const failedMetadata = {
                    ...chunkMetadata,
                    status: 'failed',
                    error: uploadResult ? uploadResult.error : 'Unknown error',
                    retryCount: retry + 1,
                    failedTime: Date.now()
                };

                // 保留原始数据以便重试，设置过期时间（D1模式下不保存二进制数据，避免SQLITE_TOOBIG）
                const { usingD1: failPathUsingD1 } = checkDatabaseConfig(env);
                await db.put(chunkKey, failPathUsingD1 ? '' : chunkData, {
                    metadata: failedMetadata,
                    expirationTtl: getChunkRecordTtlSeconds(context)                });
                await updateUploadManifestChunk(env, uploadId, chunkIndex, {
                    ...failedMetadata,
                    hasData: !failPathUsingD1 && Boolean(chunkData && chunkData.byteLength > 0)
                }, context);

                console.warn(`Chunk ${chunkIndex} upload failed after ${MAX_RETRIES} attempts: ${failedMetadata.error}`);

                return {
                    success: false,
                    error: failedMetadata.error || 'Unknown error'
                };
            }

            console.warn(`Chunk ${chunkIndex} attempt ${retry + 1} failed: ${uploadResult?.error || 'Unknown error'}`);
        }

        return {
            success: false,
            error: `Chunk ${chunkIndex} upload exhausted retries`
        };

    } catch (error) {
        console.error(`Error uploading chunk ${chunkIndex}:`, error);

        // 发生异常时，确保保留原始数据并标记为失败
        try {
            const chunkRecord = await db.getWithMetadata(chunkKey, { type: 'arrayBuffer' });
            if (chunkRecord && chunkRecord.metadata) {
                const errorMetadata = {
                    ...chunkRecord.metadata,
                    status: 'failed',
                    error: error.message,
                    failedTime: Date.now()
                };

                // D1模式下不保存二进制数据，避免SQLITE_TOOBIG
                const { usingD1 } = checkDatabaseConfig(env);
                const fallbackChunkValue = usingD1 ? '' : ((chunkRecord.value && chunkRecord.value.byteLength > 0)
                    ? chunkRecord.value
                    : (chunkData !== undefined ? chunkData : ''));

                await db.put(chunkKey, fallbackChunkValue, {
                    metadata: errorMetadata,
                    expirationTtl: getChunkRecordTtlSeconds(context)                });
                await updateUploadManifestChunk(env, uploadId, chunkIndex, {
                    ...errorMetadata,
                    hasData: Boolean(fallbackChunkValue && fallbackChunkValue.byteLength > 0)
                }, context);
            }
        } catch (metaError) {
            console.error('Failed to save error metadata:', metaError);
        }

        return {
            success: false,
            error: error.message
        };
    }
}

// 上传单个分块到R2 (Multipart Upload)
async function uploadSingleChunkToR2Multipart(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { env, uploadConfig } = context;
    const db = getDatabase(env);

    try {
        const r2Settings = uploadConfig.cfr2;
        if (!r2Settings.channels || r2Settings.channels.length === 0) {
            return { success: false, error: 'No R2 channel provided' };
        }

        const R2DataBase = env.img_r2;
        const multipartKey = `multipart_${uploadId}`;

        let finalFileId;

        // 如果是第一个分块，生成并保存 finalFileId
        if (chunkIndex === 0) {
            finalFileId = await buildUniqueFileId(context, originalFileName, originalFileType);

            const multipartUpload = await R2DataBase.createMultipartUpload(finalFileId);
            const multipartInfo = {
                uploadId: multipartUpload.uploadId,
                key: finalFileId,
                status: 'initialized',
                createdAt: Date.now()
            };

            await db.put(multipartKey, JSON.stringify(multipartInfo), {
                expirationTtl: getChunkRecordTtlSeconds(context)
            });
            
            console.log(`R2 multipart upload initialized for ${finalFileId}`);
        } else {
            let multipartInfoData = null;
            let retryCount = 0;
            const maxRetries = 60;
            // 指数退避轮询：200ms 起步，每次 ×1.5，上限 1000ms
            // 比 fixed 500ms 更快响应初始化完成，同时减少无效请求
            let pollInterval = 200;

            while (!multipartInfoData && retryCount < maxRetries) {
                multipartInfoData = await db.get(multipartKey);
                if (!multipartInfoData) {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                    retryCount++;
                    // 指数退避，上限 1000ms
                    pollInterval = Math.min(pollInterval * 1.5, 1000);
                    if (retryCount % 10 === 0) {
                        console.log(`R2 chunk ${chunkIndex} waiting for multipart initialization... (${retryCount}/${maxRetries})`);
                    }
                }
            }

            if (!multipartInfoData) {
                return { success: false, error: 'Multipart upload not initialized after waiting 30 seconds' };
            }

            const multipartInfo = JSON.parse(multipartInfoData);
            finalFileId = multipartInfo.key;
            
            console.log(`R2 chunk ${chunkIndex} found multipart info for ${finalFileId}`);

            const multipartUpload = R2DataBase.resumeMultipartUpload(finalFileId, multipartInfo.uploadId);
            const uploadedPart = await multipartUpload.uploadPart(chunkIndex + 1, chunkData);

            if (!uploadedPart || !uploadedPart.etag) {
                throw new Error(`Failed to upload part ${chunkIndex + 1} to R2`);
            }

            return {
                success: true,
                partNumber: chunkIndex + 1,
                etag: uploadedPart.etag,
                size: chunkData.byteLength,
                uploadTime: Date.now(),
                multipartUploadId: multipartInfo.uploadId,
                key: finalFileId
            };
        }

        const multipartInfoData = await db.get(multipartKey);
        if (!multipartInfoData) {
            return { success: false, error: 'Multipart upload not initialized' };
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        const multipartUpload = R2DataBase.resumeMultipartUpload(finalFileId, multipartInfo.uploadId);
        const uploadedPart = await multipartUpload.uploadPart(chunkIndex + 1, chunkData);

        if (!uploadedPart || !uploadedPart.etag) {
            throw new Error(`Failed to upload part ${chunkIndex + 1} to R2`);
        }

        return {
            success: true,
            partNumber: chunkIndex + 1,
            etag: uploadedPart.etag,
            size: chunkData.byteLength,
            uploadTime: Date.now(),
            multipartUploadId: multipartInfo.uploadId,
            key: finalFileId
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// 上传单个分块到S3 (Multipart Upload)
async function uploadSingleChunkToS3Multipart(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { env, uploadConfig, specifiedChannelName } = context;
    const db = getDatabase(env);

    try {
        const s3Settings = uploadConfig.s3;
        const s3Channels = s3Settings.channels;
        
        // 优先使用指定的渠道名称
        let s3Channel;
        if (specifiedChannelName) {
            s3Channel = s3Channels.find(ch => ch.name === specifiedChannelName);
        }
        if (!s3Channel) {
            s3Channel = selectConsistentChannel(s3Channels, uploadId, s3Settings.loadBalance.enabled);
        }

        if (!s3Channel) {
            return { success: false, error: 'No S3 channel provided' };
        }

        console.log(`Uploading S3 chunk ${chunkIndex} for uploadId: ${uploadId}, selected channel: ${s3Channel.name || 'default'}`);

        const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

        const s3Client = new S3Client({
            region: region || "auto",
            endpoint,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: pathStyle
        });

        const multipartKey = `multipart_${uploadId}`;


        let finalFileId;

        // 如果是第一个分块，生成并保存 finalFileId
        if (chunkIndex === 0) {
            finalFileId = await buildUniqueFileId(context, originalFileName, originalFileType);

            const createResponse = await s3Client.send(new CreateMultipartUploadCommand({
                Bucket: bucketName,
                Key: finalFileId,
                ContentType: originalFileType || 'application/octet-stream'
            }));

            const multipartInfo = {
                uploadId: createResponse.UploadId,
                key: finalFileId,
                status: 'initialized',
                createdAt: Date.now()
            };

            await db.put(multipartKey, JSON.stringify(multipartInfo), {
                expirationTtl: getChunkRecordTtlSeconds(context)
            });
            
            console.log(`S3 multipart upload initialized for ${finalFileId}`);
        } else {
            let multipartInfoData = null;
            let retryCount = 0;
            const maxRetries = 60;
            // 指数退避轮询：200ms 起步，每次 ×1.5，上限 1000ms
            let pollInterval = 200;

            while (!multipartInfoData && retryCount < maxRetries) {
                multipartInfoData = await db.get(multipartKey);
                if (!multipartInfoData) {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                    retryCount++;
                    pollInterval = Math.min(pollInterval * 1.5, 1000);
                    if (retryCount % 10 === 0) {
                        console.log(`S3 chunk ${chunkIndex} waiting for multipart initialization... (${retryCount}/${maxRetries})`);
                    }
                }
            }

            if (!multipartInfoData) {
                return { success: false, error: 'Multipart upload not initialized after waiting 30 seconds' };
            }

            const multipartInfo = JSON.parse(multipartInfoData);
            finalFileId = multipartInfo.key;
            
            console.log(`S3 chunk ${chunkIndex} found multipart info for ${finalFileId}`);

            const uploadResponse = await s3Client.send(new UploadPartCommand({
                Bucket: bucketName,
                Key: finalFileId,
                PartNumber: chunkIndex + 1,
                UploadId: multipartInfo.uploadId,
                Body: new Uint8Array(chunkData)
            }));

            if (!uploadResponse || !uploadResponse.ETag) {
                throw new Error(`Failed to upload part ${chunkIndex + 1} to S3`);
            }

            return {
                success: true,
                partNumber: chunkIndex + 1,
                etag: uploadResponse.ETag,
                size: chunkData.byteLength,
                uploadTime: Date.now(),
                s3Channel: s3Channel.name,
                multipartUploadId: multipartInfo.uploadId,
                key: finalFileId
            };
        }

        const multipartInfoData = await db.get(multipartKey);
        if (!multipartInfoData) {
            return { success: false, error: 'Multipart upload not initialized' };
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        const uploadResponse = await s3Client.send(new UploadPartCommand({
            Bucket: bucketName,
            Key: finalFileId,
            PartNumber: chunkIndex + 1,
            UploadId: multipartInfo.uploadId,
            Body: new Uint8Array(chunkData)
        }));

        if (!uploadResponse || !uploadResponse.ETag) {
            throw new Error(`Failed to upload part ${chunkIndex + 1} to S3`);
        }

        return {
            success: true,
            partNumber: chunkIndex + 1,
            etag: uploadResponse.ETag,
            size: chunkData.byteLength,
            uploadTime: Date.now(),
            s3Channel: s3Channel.name,
            multipartUploadId: multipartInfo.uploadId,
            key: finalFileId
        };

    } catch (error) {
        console.error(`S3 chunk upload error (chunk ${chunkIndex}):`, error.message, error.name, error.$metadata);
        return {
            success: false,
            error: error.message
        };
    }
}

// 上传单个分块到Telegram
function selectTelegramChunkChannel(context, uploadId, chunkIndex, fallbackChannel = null) {
    const { uploadConfig, specifiedChannelName } = context;
    const tgSettings = uploadConfig.telegram;
    const tgChannels = tgSettings.channels || [];

    if (tgChannels.length === 0) {
        return null;
    }

    if (specifiedChannelName) {
        return tgChannels.find(ch => ch.name === specifiedChannelName) || null;
    }

    if (!tgSettings.loadBalance?.enabled || tgChannels.length === 1) {
        return fallbackChannel || tgChannels[0];
    }

    const channelSelectionKey = `${uploadId}:${chunkIndex}`;
    return selectConsistentChannel(tgChannels, channelSelectionKey, true);
}

async function uploadSingleChunkToTelegram(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { uploadConfig } = context;

    try {
        const tgChannel = selectTelegramChunkChannel(context, uploadId, chunkIndex);

        if (!tgChannel) {
            return { success: false, error: 'No Telegram channel provided' };
        }

        console.log(`Uploading Telegram chunk ${chunkIndex} for uploadId: ${uploadId}, selected channel: ${tgChannel.name || 'default'}`);

        const tgBotToken = tgChannel.botToken;
        const tgChatId = tgChannel.chatId;
        const tgProxyUrl = tgChannel.proxyUrl || '';

        // 创建分块文件名
        const chunkFileName = `${originalFileName}.part${chunkIndex.toString().padStart(3, '0')}`;
        const chunkBlob = new Blob([chunkData], { type: 'application/octet-stream' });

        // 上传分块到Telegram（支持代理域名）
        const chunkUploadResult = await uploadChunkToTelegramWithRetry(
            tgBotToken,
            tgChatId,
            tgProxyUrl,
            chunkBlob,
            chunkFileName,
            chunkIndex,
            totalChunks, // 传入正确的totalChunks
            3
        );

        if (!chunkUploadResult.success) {
            return {
                success: false,
                error: chunkUploadResult.error || 'Failed to upload chunk to Telegram'
            };
        }

        const chunkInfo = chunkUploadResult.fileInfo;

        return {
            success: true,
            fileId: chunkInfo.file_id,
            size: chunkInfo.file_size,
            fileName: chunkFileName,
            uploadTime: Date.now(),
            tgChannel: tgChannel.name,
            tgBotToken,
            tgChatId,
            tgProxyUrl
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// 上传单个分块到Discord
async function uploadSingleChunkToDiscord(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { uploadConfig, specifiedChannelName } = context;

    try {
        const discordSettings = uploadConfig.discord;
        const discordChannels = discordSettings.channels;
        
        // 优先使用指定的渠道名称
        let discordChannel;
        if (specifiedChannelName) {
            discordChannel = discordChannels.find(ch => ch.name === specifiedChannelName);
        }
        if (!discordChannel) {
            discordChannel = selectConsistentChannel(discordChannels, uploadId, discordSettings.loadBalance?.enabled);
        }

        if (!discordChannel) {
            return { success: false, error: 'No Discord channel provided' };
        }

        console.log(`Uploading Discord chunk ${chunkIndex} for uploadId: ${uploadId}, selected channel: ${discordChannel.name || 'default'}`);

        const botToken = discordChannel.botToken;
        const channelId = discordChannel.channelId;

        // 创建分块文件名
        const chunkFileName = `${originalFileName}.part${chunkIndex.toString().padStart(3, '0')}`;
        const chunkBlob = new Blob([chunkData], { type: 'application/octet-stream' });

        // 上传分块到Discord（带重试）
        const chunkInfo = await uploadChunkToDiscordWithRetry(
            botToken,
            channelId,
            chunkBlob,
            chunkFileName,
            chunkIndex,
            totalChunks,
            2 // maxRetries
        );

        if (!chunkInfo) {
            return { success: false, error: 'Failed to upload chunk to Discord' };
        }

        return {
            success: true,
            messageId: chunkInfo.message_id,
            // 注意：不存储 attachmentId 和 url，因为它们会在约24小时后过期
            // 读取时会通过 messageId 获取新的 URL
            size: chunkInfo.file_size,
            fileName: chunkFileName,
            uploadTime: Date.now(),
            discordChannel: discordChannel.name
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// 将每个分块上传至Discord，支持失败重试和 rate limit 处理
async function uploadChunkToDiscordWithRetry(botToken, channelId, chunkBlob, chunkFileName, chunkIndex, totalChunks, maxRetries = 2) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const discordAPI = new DiscordAPI(botToken);

            const response = await discordAPI.sendFile(chunkBlob, channelId, chunkFileName);

            if (!response || !response.id) {
                throw new Error('Invalid Discord response');
            }

            const fileInfo = discordAPI.getFileInfo(response);
            if (!fileInfo) {
                throw new Error('Failed to extract file info from response');
            }

            return fileInfo;

        } catch (error) {
            console.warn(`Discord chunk ${chunkIndex} upload attempt ${attempt + 1} failed:`, error.message);

            // 检查是否是 rate limit (429)
            if (error.message && error.message.includes('429')) {
                // 从错误消息中提取 retry_after，或使用默认值
                const retryAfter = 5000; // 默认等待 5 秒
                console.log(`Discord rate limited, waiting ${retryAfter}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryAfter));
                continue; // 不计入重试次数
            }

            if (attempt === maxRetries - 1) {
                return null;
            }

            await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        }
    }

    return null;
}

/* ======== 分块合并时与上传相关的工具函数 ======= */

// 重传失败的分块
// 并发重试失败的分块
export async function retryFailedChunks(context, failedChunks, uploadChannel, options = {}) {
    const {
        maxRetries = 5,
        retryTimeout = 90000,
        maxConcurrency = 6,
        batchSize = 10
    } = options;

    if (!failedChunks || failedChunks.length === 0) {
        console.log('No failed chunks to retry');
        return { success: true, results: [] };
    }

    console.log(`Starting concurrent retry for ${failedChunks.length} failed chunks with max concurrency: ${maxConcurrency}`);

    const results = [];
    const chunksToRetry = failedChunks.filter(chunk =>
        chunk.hasData &&
        chunk.status !== 'uploading' &&
        chunk.status !== 'completed'
    );

    if (chunksToRetry.length === 0) {
        console.log('No chunks need retry (all are either uploading, completed, or have no data)');
        return { success: true, results: [] };
    }

    // 分批处理以控制并发
    for (let i = 0; i < chunksToRetry.length; i += batchSize) {
        const batch = chunksToRetry.slice(i, i + batchSize);
        console.log(`Processing batch ${Math.floor(i / batchSize) + 1}: chunks ${batch.map(c => c.index).join(', ')}`);

        // 创建并发控制的重试任务
        const retryTaskFactories = batch.map((chunk) => {
            return () => retrySingleChunk(context, chunk, uploadChannel, maxRetries, retryTimeout);
        });

        // 限制并发数量
        const batchResults = [];
        for (let j = 0; j < retryTaskFactories.length; j += maxConcurrency) {
            const concurrentTaskFactories = retryTaskFactories.slice(j, j + maxConcurrency);
            const concurrentResults = await Promise.allSettled(
                concurrentTaskFactories.map(taskFactory => taskFactory())
            );

            for (const result of concurrentResults) {
                if (result.status === 'fulfilled') {
                    batchResults.push(result.value);
                } else {
                    console.error('Retry task failed:', result.reason);
                    batchResults.push({
                        success: false,
                        chunk: null,
                        error: result.reason?.message || 'Task failed',
                        reason: 'task_error'
                    });
                }
            }
        }

        results.push(...batchResults);

        // 批次间不再固定 sleep 200ms：maxConcurrency 已通过 Promise.allSettled 控制并发，
        // 上一批完成后立即处理下一批，减少大量失败块时的总重试耗时
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    console.log(`Retry completed: ${successCount} successful, ${failureCount} failed out of ${results.length} chunks`);

    // 记录失败的分块信息
    const failedResults = results.filter(r => !r.success);
    if (failedResults.length > 0) {
        console.warn('Failed chunks:', failedResults.map(r => ({
            index: r.chunk?.index,
            reason: r.reason,
            error: r.error
        })));
    }

    return {
        success: failureCount === 0,
        results,
        summary: {
            total: results.length,
            successful: successCount,
            failed: failureCount,
            failedChunks: failedResults.map(r => r.chunk?.index).filter(Boolean)
        }
    };
}

// 重试单个失败的分块
async function retrySingleChunk(context, chunk, uploadChannel, maxRetries = 5, retryTimeout = 60000) {
    const { env } = context;
    const db = getDatabase(env);

    let retryCount = 0;
    let lastError = null;

    // 读取分块数据
    const chunkRecord = await db.getWithMetadata(chunk.key, { type: 'arrayBuffer' });
    // D1模式下失败分块不保留二进制数据，此处按数据缺失终止重试
    if (!chunkRecord || !chunkRecord.value || chunkRecord.value.byteLength === 0) {
        console.error(`Chunk ${chunk.index} data missing for retry`);
        return { success: false, chunk, reason: 'data_missing', error: 'Chunk data not found' };
    }

    const chunkData = chunkRecord.value;
    const originalFileName = chunkRecord.metadata?.originalFileName || 'unknown';
    const originalFileType = chunkRecord.metadata?.originalFileType || 'application/octet-stream';
    const uploadId = chunkRecord.metadata?.uploadId;
    const totalChunks = chunkRecord.metadata?.totalChunks || 1;

    // 更新重试状态
    const retryMetadata = {
        ...chunkRecord.metadata,
        status: 'retrying',
    };

    // D1模式下不保存二进制数据，避免SQLITE_TOOBIG
    const { usingD1: retryUsingD1 } = checkDatabaseConfig(env);
    await db.put(chunk.key, retryUsingD1 ? '' : chunkData, {
        metadata: retryMetadata,
        expirationTtl: getChunkRecordTtlSeconds(context)
    });
    await updateUploadManifestChunk(env, uploadId, chunk.index, {
        ...retryMetadata,
        hasData: !retryUsingD1
    }, context);

    while (retryCount < maxRetries) {
        if (retryCount > 0) {
            const delay = Math.min(300 * Math.pow(2, retryCount - 1), 3000);
            console.log(`Chunk ${chunk.index} retry ${retryCount + 1}/${maxRetries}, waiting ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        try {
            // 根据渠道重新上传，添加超时保护
            const retryPromise = (async () => {
                if (uploadChannel === 'cfr2') {
                    return await uploadSingleChunkToR2Multipart(context, chunkData, chunk.index, totalChunks, uploadId, originalFileName, originalFileType);
                } else if (uploadChannel === 's3') {
                    return await uploadSingleChunkToS3Multipart(context, chunkData, chunk.index, totalChunks, uploadId, originalFileName, originalFileType);
                } else if (uploadChannel === 'telegram') {
                    return await uploadSingleChunkToTelegram(context, chunkData, chunk.index, totalChunks, uploadId, originalFileName, originalFileType);
                } else if (uploadChannel === 'discord') {
                    return await uploadSingleChunkToDiscord(context, chunkData, chunk.index, totalChunks, uploadId, originalFileName, originalFileType);
                }
                return null;
            })();

            const timeoutPromise = new Promise((resolve) => {
                setTimeout(() => resolve({
                    success: false,
                    error: 'Retry timeout'
                }), retryTimeout);
            });

            const uploadResult = await Promise.race([retryPromise, timeoutPromise]);

            if (uploadResult && uploadResult.success) {
                // 更新状态为成功
                const updatedMetadata = {
                    ...chunkRecord.metadata,
                    status: 'completed',
                    uploadResult: uploadResult,
                    retryCount: retryCount + 1,
                    completedTime: Date.now()
                };

                // 删除原始数据，只保留上传结果，设置过期时间
                await db.put(chunk.key, '', {
                    metadata: updatedMetadata,
                    expirationTtl: getChunkRecordTtlSeconds(context)
                });
                await updateUploadManifestChunk(env, uploadId, chunk.index, {
                    ...updatedMetadata,
                    hasData: false
                }, context);

                console.log(`Chunk ${chunk.index} retry successful after ${retryCount + 1} attempts`);
                return { success: true, chunk, retryCount: retryCount + 1 };
            }

            lastError = uploadResult?.error || 'Unknown error';
            console.warn(`Chunk ${chunk.index} retry ${retryCount + 1}/${maxRetries} failed: ${lastError}`);
        } catch (error) {
            lastError = error.message || 'Unknown error';
            const isTimeout = error.message === 'Retry timeout';
            console.warn(`Chunk ${chunk.index} retry ${retryCount + 1}/${maxRetries} ${isTimeout ? 'timed out' : 'threw error'}: ${lastError}`);
        }

        retryCount++;
    }

    // 所有重试耗尽，更新最终失败状态
    try {
        const finalRecord = await db.getWithMetadata(chunk.key, { type: 'arrayBuffer' });
        if (finalRecord) {
            const failedRetryMetadata = {
                ...finalRecord.metadata,
                status: 'retry_failed',
                retryCount: retryCount,
                error: lastError,
                failedTime: Date.now()
            };

            await db.put(chunk.key, finalRecord.value || '', {
                metadata: failedRetryMetadata,
                expirationTtl: getChunkRecordTtlSeconds(context)
            });
            await updateUploadManifestChunk(env, uploadId, chunk.index, {
                ...failedRetryMetadata,
                hasData: Boolean(finalRecord.value && finalRecord.value.byteLength > 0)
            }, context);
        }
    } catch (metaError) {
        console.error(`Failed to update retry error metadata for chunk ${chunk.index}:`, metaError);
    }

    console.error(`Chunk ${chunk.index} failed after ${maxRetries} retry attempts`);
    return { success: false, chunk, retryCount, error: lastError || 'Max retries exceeded' };
}


// 清理失败的multipart upload
export async function cleanupFailedMultipartUploads(context, uploadId, uploadChannel) {
    const { env, uploadConfig } = context;
    const db = getDatabase(env);

    try {
        const multipartKey = `multipart_${uploadId}`;
        const multipartInfoData = await db.get(multipartKey);

        if (!multipartInfoData) {
            return; // 没有multipart upload需要清理
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        if (uploadChannel === 'cfr2') {
            // 清理R2 multipart upload
            const R2DataBase = env.img_r2;
            const multipartUpload = R2DataBase.resumeMultipartUpload(multipartInfo.key, multipartInfo.uploadId);
            await multipartUpload.abort();

        } else if (uploadChannel === 's3') {
            // 清理S3 multipart upload
            const s3Settings = uploadConfig.s3;
            const s3Channels = s3Settings.channels;
            
            // 优先使用指定的渠道名称
            let s3Channel;
            const specifiedChannelName = context.specifiedChannelName;
            if (specifiedChannelName) {
                s3Channel = s3Channels.find(ch => ch.name === specifiedChannelName);
            }
            if (!s3Channel) {
                s3Channel = selectConsistentChannel(s3Channels, uploadId, s3Settings.loadBalance.enabled);
            }

            if (s3Channel) {
                const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

                const s3Client = new S3Client({
                    region: region || "auto",
                    endpoint,
                    credentials: { accessKeyId, secretAccessKey },
                    forcePathStyle: pathStyle
                });

                await s3Client.send(new AbortMultipartUploadCommand({
                    Bucket: bucketName,
                    Key: multipartInfo.key,
                    UploadId: multipartInfo.uploadId
                }));
            }
        }

        // 清理multipart info
        await db.delete(multipartKey);
        console.log(`Cleaned up failed multipart upload for ${uploadId}`);

    } catch (error) {
        console.error(`Failed to cleanup multipart upload for ${uploadId}:`, error);
    }
}


// 检查分块上传状态
export async function checkChunkUploadStatuses(env, uploadId, totalChunks) {
    const chunkStatuses = [];
    const currentTime = Date.now();

    const db = getDatabase(env);

    const CHUNK_STATUS_CONCURRENCY = 12;
    for (let offset = 0; offset < totalChunks; offset += CHUNK_STATUS_CONCURRENCY) {
        const indices = [];
        for (let i = offset; i < Math.min(offset + CHUNK_STATUS_CONCURRENCY, totalChunks); i++) {
            indices.push(i);
        }

        const batchResults = await Promise.all(indices.map(async (i) => {
            const chunkKey = `chunk_${uploadId}_${i.toString().padStart(3, '0')}`;
            try {
                const chunkRecord = await db.getWithMetadata(chunkKey, { type: 'arrayBuffer' });
                if (chunkRecord && chunkRecord.metadata) {
                    let status = chunkRecord.metadata.status || 'unknown';

                    // 如果 chunk 已有 uploadResult（上传到 TG/R2/S3 成功的产物），
                    // 无论 status 字段是什么，都视为 'completed'。
                    // 这修复了 KV 最终一致性导致 status 回退为 'uploading'，
                    // 进而被超时检查标记为 'timeout' → 终态失败 → 合并 500 的问题。
                    if (chunkRecord.metadata.uploadResult && chunkRecord.metadata.uploadResult.success) {
                        status = 'completed';
                    } else if (status === 'uploading' && chunkRecord.metadata.timeoutThreshold && currentTime > chunkRecord.metadata.timeoutThreshold) {
                        status = 'timeout';

                        const timeoutMetadata = {
                            ...chunkRecord.metadata,
                            status: 'timeout',
                            error: 'Upload timeout detected',
                            timeoutDetectedTime: currentTime
                        };

                        // D1模式下不保存二进制数据，避免SQLITE_TOOBIG
                        const { usingD1 } = checkDatabaseConfig(env);
                        await db.put(chunkKey, usingD1 ? '' : chunkRecord.value, {
                            metadata: timeoutMetadata,
                            expirationTtl: getChunkRecordTtlSeconds(uploadId)
                        }).catch(err => console.warn(`Failed to update timeout status for chunk ${i}:`, err));
                        await updateUploadManifestChunk(env, uploadId, i, {
                            ...timeoutMetadata,
                            hasData: !usingD1 && Boolean(chunkRecord.value && chunkRecord.value.byteLength > 0)
                        }).catch(err => console.warn(`Failed to update timeout manifest for chunk ${i}:`, err));
                    }

                    const hasData = status === 'completed'
                        ? false
                        : Boolean(chunkRecord.value && chunkRecord.value.byteLength > 0);

                    return {
                        index: i,
                        key: chunkKey,
                        status: status,
                        uploadResult: chunkRecord.metadata.uploadResult,
                        error: chunkRecord.metadata.error,
                        hasData: hasData,
                        chunkSize: chunkRecord.metadata.chunkSize,
                        uploadTime: chunkRecord.metadata.uploadTime,
                        uploadStartTime: chunkRecord.metadata.uploadStartTime,
                        timeoutThreshold: chunkRecord.metadata.timeoutThreshold,
                        uploadChannel: chunkRecord.metadata.uploadChannel,
                        isTimeout: status === 'timeout'
                    };
                }

                return {
                    index: i,
                    key: chunkKey,
                    status: 'missing',
                    hasData: false
                };
            } catch (error) {
                return {
                    index: i,
                    key: chunkKey,
                    status: 'error',
                    error: error.message,
                    hasData: false
                };
            }
        }));

        chunkStatuses.push(...batchResults);
    }

    chunkStatuses.sort((a, b) => a.index - b.index);
    return chunkStatuses;
}

export async function getChunkUploadStatusesWithManifest(env, uploadId, totalChunks) {
    const recordStatuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);
    const manifest = await getUploadManifest(env, uploadId);
    const manifestChunks = manifest?.chunks || {};

    const mergedStatuses = recordStatuses.map((recordStatus) => {
        const manifestChunk = manifestChunks[String(recordStatus.index)];
        if (!manifestChunk) {
            return recordStatus;
        }

        // 如果 record 或 manifest 中任一已有 uploadResult.success，
        // 说明分块已成功上传到存储端，直接视为 'completed'。
        // 这修复了 KV 最终一致性导致 status 回退的问题。
        const recordHasSuccess = Boolean(recordStatus.uploadResult && recordStatus.uploadResult.success);
        const manifestHasSuccess = Boolean(manifestChunk.uploadResult && manifestChunk.uploadResult.success);
        if (recordHasSuccess || manifestHasSuccess) {
            return {
                ...recordStatus,
                ...manifestChunk,
                key: recordStatus.key,
                index: recordStatus.index,
                status: 'completed',
                uploadResult: recordStatus.uploadResult || manifestChunk.uploadResult,
                error: null,
                hasData: false,
                isTimeout: false
            };
        }

        const manifestStatus = manifestChunk.status || recordStatus.status;
        // chunk record 是按分片独立写入的（无并发覆盖问题），比 manifest 更可靠。
        // 当 record 已是 'completed'（终态）时，不应被 manifest 中过时的非 'completed'
        // 状态覆盖——后者可能因 waitUntil 延迟写入或 manifest 并发读写丢失而被回退为 'uploading'。
        const recordCompleted = recordStatus.status === 'completed';
        const shouldPreferManifest = manifestStatus === 'completed'
            || ['missing', 'error', 'unknown'].includes(recordStatus.status)
            || (!recordCompleted && Number(manifestChunk.updatedAt || 0) >= Number(recordStatus.uploadTime || recordStatus.uploadStartTime || 0));

        if (!shouldPreferManifest) {
            return recordStatus;
        }

        return {
            ...recordStatus,
            ...manifestChunk,
            key: recordStatus.key,
            index: recordStatus.index,
            status: manifestStatus,
            uploadResult: manifestChunk.uploadResult || recordStatus.uploadResult,
            error: manifestChunk.error || recordStatus.error,
            hasData: manifestStatus === 'completed' ? false : Boolean(manifestChunk.hasData || recordStatus.hasData),
            isTimeout: manifestStatus === 'timeout'
        };
    });

    mergedStatuses.sort((a, b) => a.index - b.index);
    return mergedStatuses;
}


async function isCleanupBlockedByActiveMerge(env, uploadId) {
    try {
        const db = getDatabase(env);
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);

        if (!sessionData) {
            return { blocked: false, sessionInfo: null };
        }

        const sessionInfo = JSON.parse(sessionData);
        return {
            blocked: isCleanupProtectedByMerge(sessionInfo, Date.now()),
            sessionInfo
        };
    } catch (error) {
        console.warn(`Failed to inspect merge cleanup guard for ${uploadId}:`, error);
        return { blocked: false, sessionInfo: null };
    }
}


// 清理临时分块数据
export async function cleanupChunkData(env, uploadId, totalChunks, options = {}) {
    const { ignoreMergeProtection = false } = options;

    try {
        if (!ignoreMergeProtection) {
            const { blocked } = await isCleanupBlockedByActiveMerge(env, uploadId);
            if (blocked) {
                console.log(`Skip cleanupChunkData for ${uploadId}: merge is still in progress`);
                return {
                    skipped: true,
                    reason: 'MERGE_IN_PROGRESS'
                };
            }
        }

        const db = getDatabase(env);

        for (let i = 0; i < totalChunks; i++) {
            const chunkKey = `chunk_${uploadId}_${i.toString().padStart(3, '0')}`;

            // 删除数据库中的分块记录
            await db.delete(chunkKey);
        }

        // 清理multipart info（如果存在）
        const multipartKey = `multipart_${uploadId}`;
        await db.delete(multipartKey);
        await db.delete(getUploadManifestKey(uploadId));

        return {
            skipped: false
        };

    } catch (cleanupError) {
        console.warn('Failed to cleanup chunk data:', cleanupError);
        return {
            skipped: false,
            error: cleanupError.message
        };
    }
}

// 清理上传会话
export async function cleanupUploadSession(env, uploadId) {
    try {
        const db = getDatabase(env);

        const sessionKey = `upload_session_${uploadId}`;
        await db.delete(sessionKey);
        await db.delete(getUploadManifestKey(uploadId));
        console.log(`Cleaned up upload session for ${uploadId}`);
    } catch (cleanupError) {
        console.warn('Failed to cleanup upload session:', cleanupError);
    }
}

// 强制清理所有相关数据（用于彻底清理失败的上传）
export async function forceCleanupUpload(context, uploadId, totalChunks, options = {}) {
    const { env } = context;
    const db = getDatabase(env);
    const { ignoreMergeProtection = false } = options;

    try {
        if (!ignoreMergeProtection) {
            const { blocked, sessionInfo } = await isCleanupBlockedByActiveMerge(env, uploadId);
            if (blocked) {
                console.log(`Skip forceCleanupUpload for ${uploadId}: merge is still in progress`);
                return {
                    skipped: true,
                    reason: 'MERGE_IN_PROGRESS',
                    sessionInfo
                };
            }
        }

        // 读取 session 信息
        const sessionKey = `upload_session_${uploadId}`;
        const sessionRecord = await db.get(sessionKey);
        const uploadChannel = sessionRecord ? JSON.parse(sessionRecord).uploadChannel : 'cfr2'; // 默认使用 cfr2

        // 清理 multipart upload信息
        await cleanupFailedMultipartUploads(context, uploadId, uploadChannel);

        const cleanupPromises = [];

        // 清理所有分块
        for (let i = 0; i < totalChunks; i++) {
            const chunkKey = `chunk_${uploadId}_${i.toString().padStart(3, '0')}`;
            cleanupPromises.push(db.delete(chunkKey).catch(err =>
                console.warn(`Failed to delete chunk ${i}:`, err)
            ));
        }

        // 清理相关的键
        const keysToCleanup = [
            `upload_session_${uploadId}`,
            `multipart_${uploadId}`,
            getUploadManifestKey(uploadId)
        ];

        keysToCleanup.forEach(key => {
            cleanupPromises.push(db.delete(key).catch(err =>
                console.warn(`Failed to delete key ${key}:`, err)
            ));
        });

        await Promise.allSettled(cleanupPromises);
        console.log(`Force cleanup completed for ${uploadId}`);

        return {
            skipped: false
        };

    } catch (cleanupError) {
        console.warn('Failed to force cleanup upload:', cleanupError);
        return {
            skipped: false,
            error: cleanupError.message
        };
    }
}

/* ======= 单个大文件大文件分块上传到Telegram ======= */
export async function uploadLargeFileToTelegram(context, file, fullId, metadata, fileName, fileType, returnLink, tgBotToken, tgChatId, tgChannel) {
    const { env, waitUntil } = context;
    const db = getDatabase(env);

    const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB (TG Bot getFile 下载限制 20MB，预留 4MB 余量)
    // 并发上传数：TG Bot API 对单 bot 有速率限制，5 是兼顾速度与限流的平衡值
    const MAX_CONCURRENT_UPLOADS = 5;
    const fileSize = file.size;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    const chunks = new Array(totalChunks);
    const uploadedChunks = [];

    try {
        let nextChunkIndex = 0;
        let uploadFailure = null;
        const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, totalChunks);

        const uploadChunkWorker = async () => {
            while (true) {
                if (uploadFailure) {
                    return;
                }

                const i = nextChunkIndex;
                nextChunkIndex += 1;

                if (i >= totalChunks) {
                    return;
                }

                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, fileSize);
                const chunkBlob = file.slice(start, end);
                const chunkChannel = selectTelegramChunkChannel(context, fullId, i, tgChannel);

                if (!chunkChannel) {
                    uploadFailure = new Error('No Telegram channel provided');
                    return;
                }

                const chunkBotToken = chunkChannel.botToken;
                const chunkChatId = chunkChannel.chatId;
                const chunkProxyUrl = chunkChannel.proxyUrl || '';

                // 生成分片文件名
                const chunkFileName = `${fileName}.part${i.toString().padStart(3, '0')}`;

                // 上传分片（带重试机制）
                const chunkUploadResult = await uploadChunkToTelegramWithRetry(
                    chunkBotToken,
                    chunkChatId,
                    chunkProxyUrl,
                    chunkBlob,
                    chunkFileName,
                    i,
                    totalChunks
                );

                if (!chunkUploadResult.success) {
                    uploadFailure = new Error(chunkUploadResult.error || `Failed to upload chunk ${i + 1}/${totalChunks} after retries`);
                    return;
                }

                const chunkInfo = chunkUploadResult.fileInfo;

                // 验证分片信息完整性
                if (!chunkInfo.file_id || !chunkInfo.file_size) {
                    uploadFailure = new Error(`Invalid chunk info for chunk ${i + 1}/${totalChunks}`);
                    return;
                }

                chunks[i] = {
                    index: i,
                    fileId: chunkInfo.file_id,
                    size: chunkInfo.file_size,
                    fileName: chunkFileName,
                    tgChannel: chunkChannel.name,
                    tgBotToken: chunkBotToken,
                    tgChatId: chunkChatId,
                    tgProxyUrl: chunkProxyUrl
                };

                uploadedChunks[i] = chunkInfo.file_id;
            }
        };

        await Promise.all(
            Array.from({ length: workerCount }, () => uploadChunkWorker())
        );

        if (uploadFailure) {
            throw uploadFailure;
        }

        const primaryChunk = chunks[0] || null;

        // 所有分片上传成功，更新metadata
        if (isChatRequestFromUrl(context.url)) {
            applyChatTransferMetadata(metadata, 'file');
        }
        metadata.Channel = "TelegramNew";
        if (primaryChunk?.tgChannel) {
            metadata.ChannelName = primaryChunk.tgChannel;
        }
        if (primaryChunk?.tgChatId) {
            metadata.TgChatId = primaryChunk.tgChatId;
        }
        if (primaryChunk?.tgBotToken) {
            metadata.TgBotToken = primaryChunk.tgBotToken;
        }
        if (primaryChunk?.tgProxyUrl) {
            metadata.TgProxyUrl = primaryChunk.tgProxyUrl;
        }
        metadata.IsChunked = true;
        metadata.TotalChunks = totalChunks;
        metadata.FileSize = (fileSize / 1024 / 1024).toFixed(2);


        // 将分片信息存储到value中
        const chunksData = JSON.stringify(chunks);

        // 验证分片完整性
        if (chunks.length !== totalChunks) {
            throw new Error(`Chunk count mismatch: expected ${totalChunks}, got ${chunks.length}`);
        }

        // 写入最终的数据库记录，分片信息作为value
        cleanPersistedMetadataInPlace(metadata);
        await db.put(fullId, chunksData, { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, fullId, metadata));

        return createUploadJsonResponse(buildUploadResults(context, returnLink));

    } catch (error) {
        return createResponse(`Telegram Channel Error: Large file upload failed - ${error.message}`, { status: 500 });
    }
}

// 将每个分块上传至Telegram，支持失败重试（支持代理域名）
function isTelegramRetryableError(error) {
    const status = Number(error?.status || 0);
    if (status === 429 || status >= 500) {
        return true;
    }

    const message = (error?.message || '').toLowerCase();
    const retryableKeywords = [
        'timeout',
        'network',
        'fetch',
        'temporarily',
        'econn',
        'etimedout',
        'socket'
    ];

    return retryableKeywords.some(keyword => message.includes(keyword));
}

function calculateTelegramRetryDelayMs(error, attempt) {
    const retryAfterSeconds = Number(error?.retryAfter || 0);
    if (retryAfterSeconds > 0) {
        // 尊重 Telegram 的 retry-after，但上限收紧到 8s，避免单次退避过长拖垮整体吞吐
        return Math.min(retryAfterSeconds * 1000 + 150, 8000);
    }

    // 指数退避上限 4s + 较大 jitter（0~800ms），防止多个分片同步重试形成共振 429
    const exponentialBackoffMs = Math.min(800 * Math.pow(2, attempt), 4000);
    const jitterMs = Math.floor(Math.random() * 800);
    return exponentialBackoffMs + jitterMs;
}

function buildTelegramChunkErrorMessage(error, chunkIndex, attempt, maxRetries) {
    const status = Number(error?.status || 0);
    const retryAfterSeconds = Number(error?.retryAfter || 0);
    const message = error?.description || error?.message || 'Unknown Telegram upload error';
    const statusPrefix = status ? `[status:${status}] ` : '';
    const retryAfterPrefix = retryAfterSeconds > 0 ? `[retry_after:${retryAfterSeconds}s] ` : '';
    return `Chunk ${chunkIndex + 1} upload attempt ${attempt}/${maxRetries} failed ${statusPrefix}${retryAfterPrefix}${message}`;
}

async function uploadChunkToTelegramWithRetry(tgBotToken, tgChatId, tgProxyUrl, chunkBlob, chunkFileName, chunkIndex, totalChunks, maxRetries = 3) {
    // 第一次上传不等待，只有失败重试时才等待
    // 内层重试次数收紧到 3：配合更短的退避上限，单分片最长阻塞 ~5s，避免车道被 429 长时间拖住
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // 只有在重试时才等待（attempt > 0 表示是重试）
        if (attempt > 0) {
            const delayMs = calculateTelegramRetryDelayMs(lastError, attempt - 1);
            console.log(`Chunk ${chunkIndex + 1} retry ${attempt}/${maxRetries - 1}, waiting ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        try {
            const tgAPI = new TelegramAPI(tgBotToken, tgProxyUrl);
            // 不传 caption：减少请求体大小和 TG 服务端处理开销，分片信息已通过文件名 .partNNN 体现
            const response = await tgAPI.sendFile(chunkBlob, tgChatId, 'sendDocument', 'document', '', chunkFileName);
            if (!response.ok) {
                throw new Error(response.description || 'Telegram API error');
            }

            const fileInfo = tgAPI.getFileInfo(response);
            if (!fileInfo) {
                throw new Error('Failed to extract file info from response');
            }

            return {
                success: true,
                fileInfo
            };

        } catch (error) {
            lastError = error;
            const currentAttempt = attempt + 1;
            const retryable = isTelegramRetryableError(error);
            const errorMessage = buildTelegramChunkErrorMessage(error, chunkIndex, currentAttempt, maxRetries);
            console.warn(errorMessage);

            // 不可重试的错误或已达到最大重试次数，直接返回失败
            if (!retryable || attempt === maxRetries - 1) {
                return {
                    success: false,
                    error: errorMessage
                };
            }
        }
    }

    return {
        success: false,
        error: `Chunk ${chunkIndex + 1} upload exhausted retries (${maxRetries})`
    };
}
