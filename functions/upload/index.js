import { userAuthCheck, UnauthorizedResponse } from "../utils/userAuth";
import { fetchUploadConfig, fetchSecurityConfig } from "../utils/sysConfig";
import {
    createResponse, getUploadIp, getIPAddress, resolveFileExt,
    moderateContent, purgeCDNCache, isBlockedUploadIp, buildUniqueFileId, endUpload, getImageDimensions,
    sanitizeUploadFolder, buildReturnLink, selectChannel
} from "./uploadTools";
import { initializeChunkedUpload, handleChunkUpload, uploadLargeFileToTelegram, handleCleanupRequest } from "./chunkUpload";
import { handleChunkMerge } from "./chunkMerge";
import { TelegramAPI } from "../utils/telegramAPI";
import { DiscordAPI } from "../utils/discordAPI";
import { HuggingFaceAPI } from "../utils/huggingfaceAPI";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getDatabase } from '../utils/databaseAdapter.js';
import { createUploadJsonResponse, getNormalizedUploadFolder, resolveUploadChannel } from './uploadShared.js';


export async function onRequest(context) {  // Contents of context object
    const { request, env, params, waitUntil, next, data } = context;

    // 解析请求的URL，存入 context
    const url = new URL(request.url);
    context.url = url;

    // 优化：并行读取安全配置和上传配置，节省一次网络往返
    const [securityConfig, uploadConfig] = await Promise.all([
        fetchSecurityConfig(env),
        fetchUploadConfig(env, context),
    ]);

    context.securityConfig = securityConfig;
    context.uploadConfig = uploadConfig;

    // 鉴权
    const requiredPermission = 'upload';
    if (!await userAuthCheck(env, url, request, requiredPermission)) {
        return UnauthorizedResponse('Unauthorized');
    }

    // 获得上传IP
    const uploadIp = getUploadIp(request);
    // 判断上传ip是否被封禁
    const isBlockedIp = await isBlockedUploadIp(env, uploadIp);
    if (isBlockedIp) {
        return createResponse('Error: Your IP is blocked', { status: 403 });
    }

    // 检查是否为清理请求
    const cleanupRequest = url.searchParams.get('cleanup') === 'true';
    if (cleanupRequest) {
        const uploadId = url.searchParams.get('uploadId');
        const totalChunks = parseInt(url.searchParams.get('totalChunks')) || 0;
        return await handleCleanupRequest(context, uploadId, totalChunks);
    }

    // 检查是否为初始化分块上传请求
    const initChunked = url.searchParams.get('initChunked') === 'true';
    if (initChunked) {
        return await initializeChunkedUpload(context);
    }

    // 检查是否为分块上传
    const isChunked = url.searchParams.get('chunked') === 'true';
    const isMerge = url.searchParams.get('merge') === 'true';

    if (isChunked) {
        if (isMerge) {
            return await handleChunkMerge(context);
        } else {
            return await handleChunkUpload(context);
        }
    }

    // 处理非分块文件上传
    return await processFileUpload(context);
}


// 通用文件上传处理函数
async function processFileUpload(context, formdata = null) {
    const { request, url } = context;

    // 解析表单数据
    formdata = formdata || await request.formData();

    // 将 formdata 存储在 context 中
    context.formdata = formdata;

    // 获得上传渠道类型
    const urlParamUploadChannel = url.searchParams.get('uploadChannel');
    // 获得指定的渠道名称（可选）
    const urlParamChannelName = url.searchParams.get('channelName');

    // 获取IP地址
    const uploadIp = getUploadIp(request);
    // 优化：IP 地理位置查询涉及 2 次外部 HTTP 请求（美团 API），
    // 但仅用于 metadata 记录，不影响上传逻辑。
    // 使用 Promise 延迟求值，仅在构建 metadata 时才 await。
    const ipAddressPromise = getIPAddress(uploadIp);

    // 获取上传文件夹路径
    let uploadFolder = url.searchParams.get('uploadFolder') || '';
    uploadFolder = sanitizeUploadFolder(uploadFolder);

    const uploadChannel = resolveUploadChannel(urlParamUploadChannel);

    // 将指定的渠道名称存入 context，供后续上传函数使用
    context.specifiedChannelName = urlParamChannelName || null;

    // 获取文件信息
    const time = new Date().getTime();
    const file = formdata.get('file');
    const fileType = file.type;
    let fileName = file.name;
    const fileSizeBytes = file.size; // 文件大小，单位字节
    const fileSize = (fileSizeBytes / 1024 / 1024).toFixed(2); // 文件大小，单位MB

    // 检查fileType和fileName是否存在
    if (fileType === null || fileType === undefined || fileName === null || fileName === undefined) {
        return createResponse('Error: fileType or fileName is wrong, check the integrity of this file!', { status: 400 });
    }

    // 提取图片尺寸
    let imageDimensions = null;
    if (fileType.startsWith('image/')) {
        try {
            // 统一读取 64KB，足以覆盖 JPEG 的 EXIF 数据和其他格式
            const headerBuffer = await file.slice(0, 65536).arrayBuffer();
            imageDimensions = getImageDimensions(headerBuffer, fileType);
        } catch (error) {
            console.error('Error reading image dimensions:', error);
        }
    }

    // 如果上传文件夹路径为空，尝试从文件名中获取
    if (uploadFolder === '' || uploadFolder === null || uploadFolder === undefined) {
        const normalizedUpload = getNormalizedUploadFolder(url, fileName);
        uploadFolder = normalizedUpload.uploadFolder;
        fileName = normalizedUpload.fileName;
    }
    const normalizedFolder = uploadFolder;

    const metadata = {
        FileName: fileName,
        FileType: fileType,
        FileSize: fileSize,
        FileSizeBytes: fileSizeBytes,
        UploadIP: uploadIp,
        UploadAddress: await ipAddressPromise,
        ListType: "None",
        TimeStamp: time,
        Label: "None",
        Directory: normalizedFolder === '' ? '' : normalizedFolder + '/',
        Tags: []
    };

    // 添加图片尺寸信息
    if (imageDimensions) {
        metadata.Width = imageDimensions.width;
        metadata.Height = imageDimensions.height;
    }

    const fileExt = resolveFileExt(fileName, fileType);

    // 构建文件ID
    const fullId = await buildUniqueFileId(context, fileName, fileType);

    // 获得返回链接
    const returnLink = buildReturnLink(url, fullId);

    /* ====================================不同渠道上传======================================= */
    // 出错是否切换渠道自动重试，默认开启
    const autoRetry = url.searchParams.get('autoRetry') !== 'false';

    // 优化：用调度表替代 if/else 链，消除重复代码
    const UPLOAD_DISPATCHERS = {
        'CloudflareR2': (ctx, id, meta, link) => uploadFileToCloudflareR2(ctx, id, meta, link),
        'S3':           (ctx, id, meta, link) => uploadFileToS3(ctx, id, meta, link),
        'Discord':      (ctx, id, meta, link) => uploadFileToDiscord(ctx, id, meta, link),
        'HuggingFace':  (ctx, id, meta, link) => uploadFileToHuggingFace(ctx, id, meta, link),
        'External':     (ctx, id, meta, link) => uploadFileToExternal(ctx, id, meta, link),
        'TelegramNew':  (ctx, id, meta, link) => uploadFileToTelegram(ctx, id, meta, fileExt, fileName, fileType, link),
    };

    const dispatcher = UPLOAD_DISPATCHERS[uploadChannel] || UPLOAD_DISPATCHERS['TelegramNew'];
    const res = await dispatcher(context, fullId, metadata, returnLink);

    // External 渠道不支持自动重试
    if (res.status === 200 || !autoRetry || uploadChannel === 'External') {
        return res;
    }

    const err = await res.text();

    // 上传失败，开始自动切换渠道重试
    return await tryRetry(err, context, uploadChannel, fullId, metadata, fileExt, fileName, fileType, returnLink);
}

// 上传到Cloudflare R2
async function uploadFileToCloudflareR2(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    // 检查R2数据库是否配置
    if (typeof env.img_r2 == "undefined" || env.img_r2 == null || env.img_r2 == "") {
        return createResponse('Error: Please configure R2 database', { status: 500 });
    }

    // 检查 R2 渠道是否启用
    const r2Settings = uploadConfig.cfr2;
    if (!r2Settings.channels || r2Settings.channels.length === 0) {
        return createResponse('Error: No R2 channel provided', { status: 400 });
    }

    // 选择渠道
    const r2Channel = selectChannel(r2Settings, specifiedChannelName);

    const R2DataBase = env.img_r2;

    // 写入R2数据库
    await R2DataBase.put(fullId, formdata.get('file'));

    // 更新metadata
    metadata.Channel = "CloudflareR2";
    metadata.ChannelName = r2Channel.name || "R2_env";

    // 图像审查，采用R2的publicUrl
    const R2PublicUrl = r2Channel.publicUrl;
    let moderateUrl = `${R2PublicUrl}/${fullId}`;
    metadata.Label = await moderateContent(env, moderateUrl, context.securityConfig);

    // 写入数据库
    try {
        await db.put(fullId, "", {
            metadata: metadata,
        });
    } catch (error) {
        return createResponse('Error: Failed to write to database', { status: 500 });
    }

    // 结束上传
    waitUntil(endUpload(context, fullId, metadata));

    // 成功上传，将文件ID返回给客户端
    return createUploadJsonResponse([{ src: `${returnLink}` }]);
}


// 上传到 S3（支持自定义端点）
async function uploadFileToS3(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, securityConfig, url, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    const uploadModerate = securityConfig.upload.moderate;

    const s3Settings = uploadConfig.s3;

    // 选择渠道
    const s3Channel = selectChannel(s3Settings, specifiedChannelName);

    if (!s3Channel) {
        return createResponse('Error: No S3 channel provided', { status: 400 });
    }

    const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region, cdnDomain } = s3Channel;

    // 创建 S3 客户端
    const s3Client = new S3Client({
        region: region || "auto", // R2 可用 "auto"
        endpoint, // 自定义 S3 端点
        credentials: {
            accessKeyId,
            secretAccessKey
        },
        forcePathStyle: pathStyle // 是否启用路径风格
    });

    // 获取文件
    const file = formdata.get("file");
    if (!file) return createResponse("Error: No file provided", { status: 400 });

    // 转换 Blob 为 Uint8Array
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const s3FileName = fullId;

    try {
        // S3 上传参数
        const putObjectParams = {
            Bucket: bucketName,
            Key: s3FileName,
            Body: uint8Array, // 直接使用 Blob
            ContentType: file.type
        };

        // 执行上传
        await s3Client.send(new PutObjectCommand(putObjectParams));

        // 更新 metadata
        metadata.Channel = "S3";
        metadata.ChannelName = s3Channel.name;

        const s3ServerDomain = endpoint.replace(/https?:\/\//, "");
        if (pathStyle) {
            metadata.S3Location = `https://${s3ServerDomain}/${bucketName}/${s3FileName}`; // 采用路径风格的 URL
        } else {
            metadata.S3Location = `https://${bucketName}.${s3ServerDomain}/${s3FileName}`; // 采用虚拟主机风格的 URL
        }
        metadata.S3Endpoint = endpoint;
        metadata.S3PathStyle = pathStyle;
        metadata.S3AccessKeyId = accessKeyId;
        metadata.S3SecretAccessKey = secretAccessKey;
        metadata.S3Region = region || "auto";
        metadata.S3BucketName = bucketName;
        metadata.S3FileKey = s3FileName;
        // 保存 CDN 文件完整路径（如果配置了 CDN 域名）
        if (cdnDomain) {
            // 存储完整的 CDN 文件路径，而不是仅存储域名
            metadata.S3CdnFileUrl = `${cdnDomain.replace(/\/$/, '')}/${s3FileName}`;
        }

        // 图像审查
        if (uploadModerate && uploadModerate.enabled) {
            try {
                await db.put(fullId, "", { metadata });
            } catch {
                return createResponse("Error: Failed to write to KV database", { status: 500 });
            }

            const moderateUrl = `https://${url.hostname}/file/${fullId}`;
            await purgeCDNCache(env, moderateUrl, url);
            metadata.Label = await moderateContent(env, moderateUrl, context.securityConfig);
        }

        // 写入数据库
        try {
            await db.put(fullId, "", { metadata });
        } catch {
            return createResponse("Error: Failed to write to database", { status: 500 });
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

        return createUploadJsonResponse([{ src: returnLink }]);
    } catch (error) {
        return createResponse(`Error: Failed to upload to S3 - ${error.message}`, { status: 500 });
    }
}


// 上传到Telegram
async function uploadFileToTelegram(context, fullId, metadata, fileExt, fileName, fileType, returnLink) {
    const { env, waitUntil, uploadConfig, url, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    // 选择一个 Telegram 渠道上传
    const tgSettings = uploadConfig.telegram;

    const tgChannel = selectChannel(tgSettings, specifiedChannelName);
    if (!tgChannel) {
        return createResponse('Error: No Telegram channel provided', { status: 400 });
    }

    const tgBotToken = tgChannel.botToken;
    const tgChatId = tgChannel.chatId;
    const tgProxyUrl = tgChannel.proxyUrl || '';
    const file = formdata.get('file');
    const fileSize = file.size;

    const telegramAPI = new TelegramAPI(tgBotToken, tgProxyUrl);

    const CHUNK_SIZE = 19 * 1024 * 1024; // 19MB (TG Bot upload limit: 20MB)

    if (fileSize > CHUNK_SIZE) {
        // 大文件分片上传
        return await uploadLargeFileToTelegram(context, file, fullId, metadata, fileName, fileType, returnLink, tgBotToken, tgChatId, tgChannel);
    }

    // 由于TG会把gif后缀的文件转为视频，所以需要修改后缀名绕过限制
    if (fileExt === 'gif') {
        const newFileName = fileName.replace(/\.gif$/, '.jpeg');
        const newFile = new File([formdata.get('file')], newFileName, { type: fileType });
        formdata.set('file', newFile);
    } else if (fileExt === 'webp') {
        const newFileName = fileName.replace(/\.webp$/, '.jpeg');
        const newFile = new File([formdata.get('file')], newFileName, { type: fileType });
        formdata.set('file', newFile);
    }

    // 选择对应的发送接口
    const fileTypeMap = {
        'image/': { 'url': 'sendPhoto', 'type': 'photo' },
        'video/': { 'url': 'sendVideo', 'type': 'video' },
        'audio/': { 'url': 'sendAudio', 'type': 'audio' },
        'application/pdf': { 'url': 'sendDocument', 'type': 'document' },
    };

    const defaultType = { 'url': 'sendDocument', 'type': 'document' };

    let sendFunction = Object.keys(fileTypeMap).find(key => fileType.startsWith(key))
        ? fileTypeMap[Object.keys(fileTypeMap).find(key => fileType.startsWith(key))]
        : defaultType;

    // GIF ICO 等发送接口特殊处理
    if (fileType === 'image/gif' || fileType === 'image/webp' || fileExt === 'gif' || fileExt === 'webp') {
        sendFunction = { 'url': 'sendAnimation', 'type': 'animation' };
    } else if (fileType === 'image/svg+xml' || fileType === 'image/x-icon') {
        sendFunction = { 'url': 'sendDocument', 'type': 'document' };
    }

    // 根据服务端压缩设置处理接口：从参数中获取serverCompress，如果为false，则使用sendDocument接口
    if (url.searchParams.get('serverCompress') === 'false') {
        sendFunction = { 'url': 'sendDocument', 'type': 'document' };
    }

    // 上传文件到 Telegram
    let res = createResponse('upload error, check your environment params about telegram channel!', { status: 400 });
    try {
        const response = await telegramAPI.sendFile(formdata.get('file'), tgChatId, sendFunction.url, sendFunction.type);
        const fileInfo = telegramAPI.getFileInfo(response);
        const filePath = await telegramAPI.getFilePath(fileInfo.file_id);
        const id = fileInfo.file_id;
        // 更新FileSize
        metadata.FileSize = (fileInfo.file_size / 1024 / 1024).toFixed(2);

        // 将响应返回给客户端
        res = createUploadJsonResponse([{ src: `${returnLink}` }]);


        // 图像审查（使用代理域名或官方域名）
        const moderateDomain = tgProxyUrl ? `https://${tgProxyUrl}` : 'https://api.telegram.org';
        const moderateUrl = `${moderateDomain}/file/bot${tgBotToken}/${filePath}`;
        metadata.Label = await moderateContent(env, moderateUrl, context.securityConfig);

        // 更新metadata，写入KV数据库
        try {
            metadata.Channel = "TelegramNew";
            metadata.ChannelName = tgChannel.name;

            metadata.TgFileId = id;
            metadata.TgChatId = tgChatId;
            metadata.TgBotToken = tgBotToken;
            // 保存代理域名配置
            if (tgProxyUrl) {
                metadata.TgProxyUrl = tgProxyUrl;
            }
            await db.put(fullId, "", {
                metadata: metadata,
            });
        } catch (error) {
            res = createResponse('Error: Failed to write to KV database', { status: 500 });
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

    } catch (error) {
        console.log('Telegram upload error:', error.message);
        res = createResponse('upload error, check your environment params about telegram channel!', { status: 400 });
    } finally {
        return res;
    }
}


// 外链渠道
async function uploadFileToExternal(context, fullId, metadata, returnLink) {
    const { env, waitUntil, formdata } = context;
    const db = getDatabase(env);

    // 直接将外链写入metadata
    metadata.Channel = "External";
    metadata.ChannelName = "External";
    // 从 formdata 中获取外链
    const extUrl = formdata.get('url');
    if (extUrl === null || extUrl === undefined) {
        return createResponse('Error: No url provided', { status: 400 });
    }
    metadata.ExternalLink = extUrl;
    // 写入KV数据库
    try {
        await db.put(fullId, "", {
            metadata: metadata,
        });
    } catch (error) {
        return createResponse('Error: Failed to write to KV database', { status: 500 });
    }

    // 结束上传
    waitUntil(endUpload(context, fullId, metadata));

    // 返回结果
    return createUploadJsonResponse([{ src: `${returnLink}` }]);
}


// 上传到 Discord
async function uploadFileToDiscord(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    // 获取 Discord 渠道配置
    const discordSettings = uploadConfig.discord;
    if (!discordSettings || !discordSettings.channels || discordSettings.channels.length === 0) {
        return createResponse('Error: No Discord channel configured', { status: 400 });
    }

    // 选择渠道
    const discordChannel = selectChannel(discordSettings, specifiedChannelName);

    if (!discordChannel || !discordChannel.botToken || !discordChannel.channelId) {
        return createResponse('Error: Discord channel not properly configured', { status: 400 });
    }

    const file = formdata.get('file');
    const fileSize = file.size;
    const fileName = metadata.FileName;

    // Discord 文件大小限制：Nitro 会员 25MB，免费用户 10MB
    const isNitro = discordChannel.isNitro || false;
    const DISCORD_MAX_SIZE = isNitro ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
    if (fileSize > DISCORD_MAX_SIZE) {
        const limitMB = isNitro ? 25 : 10;
        return createResponse(`Error: File size exceeds Discord limit (${limitMB}MB), please use another channel`, { status: 413 });
    }

    const discordAPI = new DiscordAPI(discordChannel.botToken);

    try {
        // 上传文件到 Discord
        const response = await discordAPI.sendFile(file, discordChannel.channelId, fileName);
        const fileInfo = discordAPI.getFileInfo(response);

        if (!fileInfo) {
            throw new Error('Failed to get file info from Discord response');
        }

        // 更新 metadata
        metadata.Channel = "Discord";
        metadata.ChannelName = discordChannel.name || "Discord_env";
        metadata.FileSize = (fileInfo.file_size / 1024 / 1024).toFixed(2);
        metadata.DiscordMessageId = fileInfo.message_id;
        metadata.DiscordChannelId = discordChannel.channelId;
        metadata.DiscordBotToken = discordChannel.botToken;
        // 注意：不存储 DiscordAttachmentUrl，因为 Discord 附件 URL 会在约24小时后过期
        // 读取时会通过 API 获取新的 URL

        // 如果配置了代理 URL，保存代理信息
        if (discordChannel.proxyUrl) {
            metadata.DiscordProxyUrl = discordChannel.proxyUrl;
        }

        // 图像审查（使用 Discord CDN URL 或代理 URL）
        let moderateUrl = fileInfo.url;
        if (discordChannel.proxyUrl) {
            moderateUrl = fileInfo.url.replace('https://cdn.discordapp.com', `https://${discordChannel.proxyUrl}`);
        }
        metadata.Label = await moderateContent(env, moderateUrl, context.securityConfig);

        // 写入 KV 数据库
        try {
            await db.put(fullId, "", { metadata });
        } catch (error) {
            return createResponse('Error: Failed to write to KV database', { status: 500 });
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

        // 返回成功响应
        return createUploadJsonResponse([{ src: returnLink }]);

    } catch (error) {
        console.error('Discord upload error:', error.message);
        return createResponse(`Error: Discord upload failed - ${error.message}`, { status: 500 });
    }
}


// 上传到 HuggingFace
async function uploadFileToHuggingFace(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    // 获取 HuggingFace 渠道配置
    const hfSettings = uploadConfig.huggingface;
    if (!hfSettings || !hfSettings.channels || hfSettings.channels.length === 0) {
        return createResponse('Error: No HuggingFace channel configured', { status: 400 });
    }

    // 选择渠道
    const hfChannel = selectChannel(hfSettings, specifiedChannelName);

    if (!hfChannel || !hfChannel.token || !hfChannel.repo) {
        return createResponse('Error: HuggingFace channel not properly configured', { status: 400 });
    }

    const file = formdata.get('file');
    const fileName = metadata.FileName;
    // 获取前端预计算的 SHA256（如果有）
    const precomputedSha256 = formdata.get('sha256') || null;
    // 构建文件路径：直接使用 fullId（与其他渠道保持一致）
    const hfFilePath = fullId;
    const huggingfaceAPI = new HuggingFaceAPI(hfChannel.token, hfChannel.repo, hfChannel.isPrivate || false);

    try {
        // 上传文件到 HuggingFace（传入预计算的 SHA256）
        const result = await huggingfaceAPI.uploadFile(file, hfFilePath, `Upload ${fileName}`, precomputedSha256);
        if (!result.success) {
            throw new Error('Failed to upload file to HuggingFace');
        }

        // 更新 metadata
        metadata.Channel = "HuggingFace";
        metadata.ChannelName = hfChannel.name || "HuggingFace_env";
        metadata.HfRepo = hfChannel.repo;
        metadata.HfFilePath = hfFilePath;
        metadata.HfToken = hfChannel.token;
        metadata.HfIsPrivate = hfChannel.isPrivate || false;
        metadata.HfFileUrl = result.fileUrl;

        // 图像审查
        const securityConfig = context.securityConfig;
        const uploadModerate = securityConfig.upload?.moderate;
        
        if (uploadModerate && uploadModerate.enabled) {
            if (!hfChannel.isPrivate) {
                // 公开仓库：直接通过公开URL访问进行审查，只写入1次KV
                metadata.Label = await moderateContent(env, result.fileUrl, context.securityConfig);
            } else {
                // 私有仓库：先写入KV，再通过自己的域名访问进行审查
                try {
                    await db.put(fullId, "", { metadata });
                } catch (error) {
                    return createResponse('Error: Failed to write to KV database', { status: 500 });
                }
                
                const moderateUrl = `https://${context.url.hostname}/file/${fullId}`;
                await purgeCDNCache(env, moderateUrl, context.url);
                metadata.Label = await moderateContent(env, moderateUrl, context.securityConfig);
            }
        }

        // 写入 KV 数据库
        try {
            await db.put(fullId, "", { metadata });
        } catch (error) {
            return createResponse('Error: Failed to write to KV database', { status: 500 });
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

        // 返回成功响应
        return createUploadJsonResponse([{ src: returnLink }]);

    } catch (error) {
        console.error('HuggingFace upload error:', error.message);
        return createResponse(`Error: HuggingFace upload failed - ${error.message}`, { status: 500 });
    }
}


// 自动切换渠道重试
// 优化：用调度表消除重复 if/else，减少代码体积（影响冷启动解析时间）
async function tryRetry(err, context, uploadChannel, fullId, metadata, fileExt, fileName, fileType, returnLink) {
    const { url } = context;

    const RETRY_DISPATCHERS = {
        'CloudflareR2': (ctx, id, meta, link) => uploadFileToCloudflareR2(ctx, id, meta, link),
        'TelegramNew':  (ctx, id, meta, link) => uploadFileToTelegram(ctx, id, meta, fileExt, fileName, fileType, link),
        'S3':           (ctx, id, meta, link) => uploadFileToS3(ctx, id, meta, link),
        'HuggingFace':  (ctx, id, meta, link) => uploadFileToHuggingFace(ctx, id, meta, link),
        'Discord':      (ctx, id, meta, link) => uploadFileToDiscord(ctx, id, meta, link),
    };

    // 渠道列表（Discord 因为有 10MB 限制，放在最后尝试）
    const channelList = ['CloudflareR2', 'TelegramNew', 'S3', 'HuggingFace', 'Discord'];
    const errMessages = { [uploadChannel]: 'Error: ' + uploadChannel + err };

    // 先用原渠道再试一次（关闭服务端压缩）
    url.searchParams.set('serverCompress', 'false');
    const retryDispatcher = RETRY_DISPATCHERS[uploadChannel];
    if (retryDispatcher) {
        const retryRes = await retryDispatcher(context, fullId, metadata, returnLink);
        if (retryRes && retryRes.status === 200) {
            return retryRes;
        }
        if (retryRes) {
            errMessages[uploadChannel + '_retry'] = 'Error: ' + uploadChannel + ' retry - ' + await retryRes.text();
        }
    }

    // 原渠道重试失败，切换到其他渠道
    for (const channel of channelList) {
        if (channel === uploadChannel) continue;
        const dispatcher = RETRY_DISPATCHERS[channel];
        if (!dispatcher) continue;

        const res = await dispatcher(context, fullId, metadata, returnLink);
        if (res && res.status === 200) {
            return res;
        }
        if (res) {
            errMessages[channel] = 'Error: ' + channel + await res.text();
        }
    }

    return createResponse(JSON.stringify(errMessages), { status: 500 });
}
