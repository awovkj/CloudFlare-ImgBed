/* ========== 分块合并处理 ========== */
import { createResponse, getUploadIp, getIPAddress, selectConsistentChannel, buildUniqueFileId, endUpload } from './uploadTools';
import { retryFailedChunks, cleanupFailedMultipartUploads, checkChunkUploadStatuses, cleanupChunkData, cleanupUploadSession } from './chunkUpload';
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getDatabase } from '../utils/databaseAdapter.js';

const INITIAL_SETTLE_WAIT_MS = 180000;
const RETRY_SETTLE_WAIT_MS = 240000;
const SETTLE_INTERVAL_MS = 2000;
const FINAL_PENDING_GRACE_MS = 30000;

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

        // 获取指定的渠道名称（优先URL参数，其次会话信息）
        const channelName = url.searchParams.get('channelName') || sessionInfo.channelName || '';
        context.specifiedChannelName = channelName;

        // 检查分块上传状态
        const chunkStatuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);

        // 输出初始状态摘要
        const initialStatusSummary = summarizeChunkStatuses(chunkStatuses);
        console.log(`Initial chunk status summary: ${JSON.stringify(initialStatusSummary)}`);

        // 开始合并处理
        return await startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel);

    } catch (error) {
        // 清理失败的multipart uploads
        if (uploadChannel === 'cfr2' || uploadChannel === 's3') {
            waitUntil(cleanupFailedMultipartUploads(context, uploadId, uploadChannel));
        }

        // 清理临时分块数据
        waitUntil(cleanupChunkData(env, uploadId, totalChunks));

        // 清理上传会话
        waitUntil(cleanupUploadSession(env, uploadId));

        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
}

// 开始合并处理
async function startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel) {
    const { env } = context;

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
            await cleanupChunkData(env, uploadId, totalChunks);

            // 清理上传会话
            await cleanupUploadSession(env, uploadId);

            return createResponse(JSON.stringify(result.result), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        throw new Error(result.error || 'Merge failed');

    } catch (error) {
        // 清理失败的multipart uploads
        if (uploadChannel === 'cfr2' || uploadChannel === 's3') {
            await cleanupFailedMultipartUploads(context, uploadId, uploadChannel);
        }

        // 清理分块数据
        await cleanupChunkData(env, uploadId, totalChunks);

        // 清理上传会话
        await cleanupUploadSession(env, uploadId);

        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
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

        let chunkStatuses = await waitForChunksToSettle(env, uploadId, totalChunks, {
            maxWaitMs: INITIAL_SETTLE_WAIT_MS,
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
                maxWaitMs: RETRY_SETTLE_WAIT_MS,
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
                throw new Error(`Merge aborted because ${processingChunks.length} chunks are still processing. Final status: ${JSON.stringify(finalStatusSummary)}`);
            }

            throw new Error(`Only ${completedChunks.length}/${totalChunks} chunks completed successfully. Final status: ${JSON.stringify(finalStatusSummary)}`);
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
        // 从 R2 设置中获取渠道名称（优先使用指定的渠道名称）
        const r2Settings = context.uploadConfig.cfr2;
        let r2ChannelName = "R2_env";
        if (specifiedChannelName) {
            const r2Channel = r2Settings.channels?.find(ch => ch.name === specifiedChannelName);
            if (r2Channel) {
                r2ChannelName = r2Channel.name;
            }
        } else if (r2Settings.channels?.[0]?.name) {
            r2ChannelName = r2Settings.channels[0].name;
        }
        metadata.ChannelName = r2ChannelName;
        metadata.FileSize = (totalSize / 1024 / 1024).toFixed(2);
        metadata.FileSizeBytes = totalSize;

        // 清理multipart info
        await db.delete(multipartKey);

        // 写入数据库
        await db.put(finalFileId, "", { metadata });

        // 结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 更新返回链接
        const returnFormat = url.searchParams.get('returnFormat') || 'default';
        let updatedReturnLink = '';
        if (returnFormat === 'full') {
            updatedReturnLink = `${url.origin}/file/${finalFileId}`;
        } else {
            updatedReturnLink = `/file/${finalFileId}`;
        }

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
        const returnFormat = url.searchParams.get('returnFormat') || 'default';
        let updatedReturnLink = '';
        if (returnFormat === 'full') {
            updatedReturnLink = `${url.origin}/file/${finalFileId}`;
        } else {
            updatedReturnLink = `/file/${finalFileId}`;
        }

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
        const tgChannels = tgSettings.channels;
        
        // 优先使用指定的渠道名称
        let tgChannel;
        if (specifiedChannelName) {
            tgChannel = tgChannels.find(ch => ch.name === specifiedChannelName);
        }
        if (!tgChannel) {
            tgChannel = selectConsistentChannel(tgChannels, uploadId, tgSettings.loadBalance.enabled);
        }

        if (!tgChannel) {
            throw new Error('No Telegram channel provided');
        }

        console.log(`Merging Telegram chunks for uploadId: ${uploadId}, selected channel: ${tgChannel.name || 'default'}`);

        const tgBotToken = tgChannel.botToken;
        const tgChatId = tgChannel.chatId;

        // 按顺序排列分块
        const sortedChunks = completedChunks.sort((a, b) => a.index - b.index);

        // 计算总大小
        const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.uploadResult.size, 0);

        // 构建分块信息数组
        const chunks = sortedChunks.map(chunk => ({
            index: chunk.index,
            fileId: chunk.uploadResult.fileId,
            size: chunk.uploadResult.size,
            fileName: chunk.uploadResult.fileName
        }));

        // 生成 finalFileId
        const finalFileId = await buildUniqueFileId(context, metadata.FileName, metadata.FileType);

        // 更新metadata
        metadata.Channel = "TelegramNew";
        metadata.ChannelName = tgChannel.name;
        metadata.TgChatId = tgChatId;
        metadata.TgBotToken = tgBotToken;
        // 保存代理域名配置（如果有）
        if (tgChannel.proxyUrl) {
            metadata.TgProxyUrl = tgChannel.proxyUrl;
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
        const returnFormat = url.searchParams.get('returnFormat') || 'default';
        let updatedReturnLink = '';
        if (returnFormat === 'full') {
            updatedReturnLink = `${url.origin}/file/${finalFileId}`;
        } else {
            updatedReturnLink = `/file/${finalFileId}`;
        }

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
        const returnFormat = url.searchParams.get('returnFormat') || 'default';
        let updatedReturnLink = '';
        if (returnFormat === 'full') {
            updatedReturnLink = `${url.origin}/file/${finalFileId}`;
        } else {
            updatedReturnLink = `/file/${finalFileId}`;
        }

        return {
            success: true,
            result: [{ 'src': updatedReturnLink }]
        };

    } catch (error) {
        throw new Error(`Discord merge failed: ${error.message}`);
    }
}
