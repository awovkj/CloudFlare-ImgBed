import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { fetchSecurityConfig } from "../utils/sysConfig";
import { TelegramAPI } from "../utils/telegramAPI";
import { DiscordAPI } from "../utils/discordAPI";
import { HuggingFaceAPI } from "../utils/huggingfaceAPI";
import {
    setCommonHeaders, setRangeHeaders, handleHeadRequest, getFileContent, isTgChannel,
    returnWithCheck, return404, returnBlockImg, isDomainAllowed, createFixedLengthBody, decodeFilePathParam
} from './fileTools';
import { getDatabase } from '../utils/databaseAdapter.js';


export async function onRequest(context) {  // Contents of context object
    const {
        request, // same as existing Worker API
        env, // same as existing Worker API
        params, // if filename includes [id] or [[path]]
        waitUntil, // same as ctx.waitUntil in existing Worker API
        next, // used for middleware or to fetch assets
        data, // arbitrary space for passing data between middlewares
    } = context;

    // 解码文件ID
    let fileId = '';
    try {
        params.path = decodeFilePathParam(params.path);
        fileId = params.path;
    } catch (e) {
        return new Response('Error: Decode Image ID Failed', { status: 400 });
    }

    // 读取安全配置，解析必要参数
    // 优化：并行读取安全配置和数据库记录，节省一次网络往返
    const db = getDatabase(env);
    const [securityConfig, imgRecord] = await Promise.all([
        fetchSecurityConfig(env),
        db.getWithMetadata(fileId),
    ]);

    context.securityConfig = securityConfig;

    const url = new URL(request.url);
    context.url = url;

    const Referer = request.headers.get('Referer')
    context.Referer = Referer;

    // 检查引用域名是否被允许
    if (!isDomainAllowed(context)) {
        return await returnBlockImg(url);
    }

    // 从数据库中获取图片记录
    if (!imgRecord) {
        return new Response('Error: Image Not Found', { status: 404 });
    }

    // 如果metadata不存在，只可能是之前未设置KV，且存储在Telegraph上的图片
    if (!imgRecord.metadata) {
        imgRecord.metadata = {};
    }

    const fileName = imgRecord.metadata?.FileName || fileId;
    const encodedFileName = encodeURIComponent(fileName);
    const fileType = imgRecord.metadata?.FileType || null;

    // 检查文件可访问状态
    let accessRes = await returnWithCheck(context, imgRecord);
    if (accessRes.status !== 200) {
        return accessRes; // 如果不可访问，直接返回
    }

    /* Cloudflare R2渠道 */
    if (imgRecord.metadata?.Channel === 'CloudflareR2') {
        return await handleR2File(context, fileId, encodedFileName, fileType);
    }

    /* S3渠道 */
    if (imgRecord.metadata?.Channel === "S3") {
        return await handleS3File(context, imgRecord.metadata, encodedFileName, fileType);
    }

    /* Discord 渠道 */
    if (imgRecord.metadata?.Channel === 'Discord') {
        // 检查是否为分片文件
        if (imgRecord.metadata?.IsChunked === true) {
            return await handleDiscordChunkedFile(context, imgRecord, encodedFileName, fileType);
        }
        return await handleDiscordFile(context, imgRecord.metadata, encodedFileName, fileType);
    }

    /* HuggingFace 渠道 */
    if (imgRecord.metadata?.Channel === 'HuggingFace') {
        return await handleHuggingFaceFile(context, imgRecord.metadata, encodedFileName, fileType);
    }

    /* 外链渠道 */
    if (imgRecord.metadata?.Channel === 'External') {
        // 直接重定向到外链
        return Response.redirect(imgRecord.metadata?.ExternalLink, 302);
    }

    /* Telegram及Telegraph渠道 */

    // 构建目标 URL
    let targetUrl = '';

    if (isTgChannel(imgRecord)) {
        let TgFileID = ''; // Tg的file_id

        if (imgRecord.metadata?.Channel === 'Telegram') {
            TgFileID = fileId.split('.')[0]; // id为file_id + ext
        } else if (imgRecord.metadata?.Channel === 'TelegramNew') {
            // 检查是否为分片文件
            if (imgRecord.metadata?.IsChunked === true) {
                return await handleTelegramChunkedFile(context, imgRecord, encodedFileName, fileType);
            }

            TgFileID = imgRecord.metadata?.TgFileId;

            if (TgFileID === null) {
                return new Response('Error: Failed to fetch image', { status: 500 });
            }
        }

        // 获取TG图片真实地址（支持代理域名）
        const TgBotToken = imgRecord.metadata?.TgBotToken || env.TG_BOT_TOKEN;
        const TgProxyUrl = imgRecord.metadata?.TgProxyUrl || '';
        const tgApi = new TelegramAPI(TgBotToken, TgProxyUrl);
        const filePath = await tgApi.getFilePath(TgFileID);
        if (filePath === null) {
            return new Response('Error: Failed to fetch image path', { status: 500 });
        }
        // 使用代理域名或官方域名
        const fileDomain = TgProxyUrl ? `https://${TgProxyUrl}` : 'https://api.telegram.org';
        targetUrl = `${fileDomain}/file/bot${TgBotToken}/${filePath}`;
    } else {
        targetUrl = 'https://telegra.ph/' + url.pathname + url.search;
    }

    try {
        const response = await getFileContent(request, targetUrl);

        if (response === null) {
            return new Response('Error: Failed to fetch image', { status: 500 });
        } else if (response.status === 404) {
            return await return404(url);
        }

        const headers = new Headers(response.headers);
        setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

        // 确保设置 Content-Length，使用元数据中的文件大小作为后备
        // 这对于 IDM 等下载工具正确显示文件大小至关重要
        if (!headers.has('Content-Length') && imgRecord.metadata?.FileSizeBytes) {
            headers.set('Content-Length', imgRecord.metadata.FileSizeBytes.toString());
        }

        // 使用 FixedLengthStream 包装响应体，确保 CF Workers 不剥离 Content-Length
        const contentLength = parseInt(headers.get('Content-Length'));
        const body = (contentLength > 0 && response.body)
            ? createFixedLengthBody(response.body, contentLength)
            : response.body;

        const newRes = new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });

        return newRes;
    } catch (error) {
        return new Response('Error: ' + error, { status: 500 });
    }
}


// 处理 Telegram 渠道分片文件读取
async function handleTelegramChunkedFile(context, imgRecord, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    const metadata = imgRecord.metadata;
    const fallbackTgBotToken = metadata.TgBotToken || env.TG_BOT_TOKEN;
    const fallbackTgProxyUrl = metadata.TgProxyUrl || '';

    // 从KV的value中读取分片信息
    let chunks = [];
    try {
        if (imgRecord.value) {
            chunks = JSON.parse(imgRecord.value);
            // 确保分片按索引排序
            chunks.sort((a, b) => a.index - b.index);
        }
    } catch (parseError) {
        console.error('Failed to parse chunks data:', parseError);
        return new Response('Error: Invalid chunks data', { status: 500 });
    }

    if (chunks.length === 0) {
        return new Response('Error: No chunks found for this file', { status: 500 });
    }

    // 验证分片完整性
    const expectedChunks = metadata.TotalChunks || chunks.length;
    if (chunks.length !== expectedChunks) {
        return new Response(`Error: Missing chunks, expected ${expectedChunks}, got ${chunks.length}`, { status: 500 });
    }

    // 计算文件总大小
    const totalSize = chunks.reduce((total, chunk) => total + (chunk.size || 0), 0);

    // 构建响应头
    const headers = new Headers();
    setCommonHeaders(headers, encodedFileName, fileType, Referer, url);
    headers.set('Content-Length', totalSize.toString());

    // 添加ETag支持
    const etag = `"${metadata.TimeStamp || Date.now()}-${totalSize}"`;
    headers.set('ETag', etag);

    // 检查If-None-Match头（304缓存）
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                'ETag': etag,
                'Cache-Control': headers.get('Cache-Control'),
                'Accept-Ranges': 'bytes'
            }
        });
    }

    // 检查Range请求头
    const range = request.headers.get('Range');
    let rangeStart = 0;
    let rangeEnd = totalSize - 1;
    let isRangeRequest = false;

    if (range) {
        const matches = range.match(/bytes=(\d+)-(\d*)/);
        if (matches) {
            rangeStart = parseInt(matches[1]);
            rangeEnd = matches[2] ? parseInt(matches[2]) : totalSize - 1;
            isRangeRequest = true;

            // 验证范围有效性
            if (rangeStart >= totalSize || rangeEnd >= totalSize || rangeStart > rangeEnd) {
                return new Response('Range Not Satisfiable', { status: 416 });
            }
        }
    }

    // 处理HEAD请求
    if (request.method === 'HEAD') {
        return handleHeadRequest(headers, etag);
    }

    try {
        // 创建支持Range请求的流
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    let currentPosition = 0;

                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        const chunkSize = chunk.size || 0;

                        // 如果当前分片完全在请求范围之前，跳过
                        if (currentPosition + chunkSize <= rangeStart) {
                            currentPosition += chunkSize;
                            continue;
                        }

                        // 如果当前分片完全在请求范围之后，结束
                        if (currentPosition > rangeEnd) {
                            break;
                        }

                        // 获取分片数据（支持代理域名）
                        const chunkBotToken = chunk.tgBotToken || fallbackTgBotToken;
                        const chunkProxyUrl = chunk.tgProxyUrl || fallbackTgProxyUrl;
                        const chunkData = await fetchTelegramChunkWithRetry(chunkBotToken, chunk, chunkProxyUrl, 3);
                        if (!chunkData) {
                            throw new Error(`Failed to fetch chunk ${chunk.index} after retries`);
                        }

                        // 计算在当前分片中的起始和结束位置
                        const chunkStart = Math.max(0, rangeStart - currentPosition);
                        const chunkEnd = Math.min(chunkSize, rangeEnd - currentPosition + 1);

                        // 如果需要部分分片数据
                        if (chunkStart > 0 || chunkEnd < chunkSize) {
                            const partialData = chunkData.slice(chunkStart, chunkEnd);
                            controller.enqueue(partialData);
                        } else {
                            controller.enqueue(chunkData);
                        }

                        currentPosition += chunkSize;
                    }

                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            }
        });

        // 设置Range相关头部
        if (isRangeRequest) {
            setRangeHeaders(headers, rangeStart, rangeEnd, totalSize);
            const rangeLength = rangeEnd - rangeStart + 1;

            return new Response(createFixedLengthBody(stream, rangeLength), {
                status: 206, // Partial Content
                headers,
            });
        } else {
            headers.set('Cache-Control', 'private, max-age=86400'); // CDN 不缓存完整文件，避免 CDN 不支持 Range 请求

            return new Response(createFixedLengthBody(stream, totalSize), {
                status: 200,
                headers,
            });
        }

    } catch (error) {
        return new Response(`Error: Failed to reconstruct chunked file - ${error.message}`, { status: 500 });
    }
}

// 带重试机制的Telegram分片获取函数（支持代理域名）
// 优化：在循环外创建 TelegramAPI 实例，避免每次重试都重新实例化
// 优化：使用指数退避 (500ms, 1000ms, 2000ms) 替代线性递增
async function fetchTelegramChunkWithRetry(botToken, chunk, proxyUrl = '', maxRetries = 3) {
    const tgApi = new TelegramAPI(botToken, proxyUrl);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await tgApi.getFileContent(chunk.fileId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // 验证分片大小是否匹配
            const chunkData = await response.arrayBuffer();
            const actualSize = chunkData.byteLength;

            // 如果有期望大小且不匹配，抛出错误
            if (chunk.size && actualSize !== chunk.size) {
                console.warn(`Chunk ${chunk.index} size mismatch: expected ${chunk.size}, got ${actualSize}`);
            }

            return new Uint8Array(chunkData);

        } catch (error) {
            console.warn(`Chunk ${chunk.index} fetch attempt ${attempt + 1} failed:`, error.message);

            if (attempt === maxRetries - 1) {
                return null; // 最后一次尝试也失败了
            }

            // 指数退避重试: 500ms, 1000ms, 2000ms
            await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
        }
    }

    return null;
}

// 处理 Discord 渠道分片文件读取
async function handleDiscordChunkedFile(context, imgRecord, encodedFileName, fileType) {
    const { request, url, Referer } = context;

    const metadata = imgRecord.metadata;
    const botToken = metadata.DiscordBotToken;
    const proxyUrl = metadata.DiscordProxyUrl;

    // 从KV的value中读取分片信息
    let chunks = [];
    try {
        if (imgRecord.value) {
            chunks = JSON.parse(imgRecord.value);
            // 确保分片按索引排序
            chunks.sort((a, b) => a.index - b.index);
        }
    } catch (parseError) {
        console.error('Failed to parse Discord chunks data:', parseError);
        return new Response('Error: Invalid chunks data', { status: 500 });
    }

    if (chunks.length === 0) {
        return new Response('Error: No chunks found for this file', { status: 500 });
    }

    // 验证分片完整性
    const expectedChunks = metadata.TotalChunks || chunks.length;
    if (chunks.length !== expectedChunks) {
        return new Response(`Error: Missing chunks, expected ${expectedChunks}, got ${chunks.length}`, { status: 500 });
    }

    // 计算文件总大小
    const totalSize = chunks.reduce((total, chunk) => total + (chunk.size || 0), 0);

    // 构建响应头
    const headers = new Headers();
    setCommonHeaders(headers, encodedFileName, fileType, Referer, url);
    headers.set('Content-Length', totalSize.toString());

    // 添加ETag支持
    const etag = `"${metadata.TimeStamp || Date.now()}-${totalSize}"`;
    headers.set('ETag', etag);

    // 检查If-None-Match头（304缓存）
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
            status: 304,
            headers: {
                'ETag': etag,
                'Cache-Control': headers.get('Cache-Control'),
                'Accept-Ranges': 'bytes'
            }
        });
    }

    // 检查Range请求头
    const range = request.headers.get('Range');
    let rangeStart = 0;
    let rangeEnd = totalSize - 1;
    let isRangeRequest = false;

    if (range) {
        const matches = range.match(/bytes=(\d+)-(\d*)/);
        if (matches) {
            rangeStart = parseInt(matches[1]);
            rangeEnd = matches[2] ? parseInt(matches[2]) : totalSize - 1;
            isRangeRequest = true;

            // 验证范围有效性
            if (rangeStart >= totalSize || rangeEnd >= totalSize || rangeStart > rangeEnd) {
                return new Response('Range Not Satisfiable', { status: 416 });
            }
        }
    }

    // 处理HEAD请求
    if (request.method === 'HEAD') {
        return handleHeadRequest(headers, etag);
    }

    try {
        // 创建支持Range请求的流
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    let currentPosition = 0;

                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        const chunkSize = chunk.size || 0;

                        // 如果当前分片完全在请求范围之前，跳过
                        if (currentPosition + chunkSize <= rangeStart) {
                            currentPosition += chunkSize;
                            continue;
                        }

                        // 如果当前分片完全在请求范围之后，结束
                        if (currentPosition > rangeEnd) {
                            break;
                        }

                        // 获取分片数据（每次通过 API 获取新的附件 URL）
                        const chunkData = await fetchDiscordChunkWithRetry(botToken, metadata.DiscordChannelId, chunk, proxyUrl, 3);
                        if (!chunkData) {
                            throw new Error(`Failed to fetch Discord chunk ${chunk.index} after retries`);
                        }

                        // 计算在当前分片中的起始和结束位置
                        const chunkStart = Math.max(0, rangeStart - currentPosition);
                        const chunkEnd = Math.min(chunkSize, rangeEnd - currentPosition + 1);

                        // 如果需要部分分片数据
                        if (chunkStart > 0 || chunkEnd < chunkSize) {
                            const partialData = chunkData.slice(chunkStart, chunkEnd);
                            controller.enqueue(partialData);
                        } else {
                            controller.enqueue(chunkData);
                        }

                        currentPosition += chunkSize;
                    }

                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            }
        });

        // 设置Range相关头部
        if (isRangeRequest) {
            setRangeHeaders(headers, rangeStart, rangeEnd, totalSize);
            const rangeLength = rangeEnd - rangeStart + 1;

            return new Response(createFixedLengthBody(stream, rangeLength), {
                status: 206, // Partial Content
                headers,
            });
        } else {
            headers.set('Cache-Control', 'private, max-age=86400');

            return new Response(createFixedLengthBody(stream, totalSize), {
                status: 200,
                headers,
            });
        }

    } catch (error) {
        return new Response(`Error: Failed to reconstruct Discord chunked file - ${error.message}`, { status: 500 });
    }
}

// 带重试机制的Discord分片获取函数（每次通过 API 获取新的附件 URL）
// 优化：在循环外创建 DiscordAPI 实例，避免每次重试都重新实例化
// 优化：使用指数退避替代线性递增
async function fetchDiscordChunkWithRetry(botToken, channelId, chunk, proxyUrl, maxRetries = 3) {
    const discordAPI = new DiscordAPI(botToken);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // 通过 Discord API 获取新的附件 URL（因为 URL 会在约24小时后过期）
            let fileUrl = await discordAPI.getFileURL(channelId, chunk.messageId);

            if (!fileUrl) {
                throw new Error('Failed to get attachment URL from Discord API');
            }

            // 如果配置了代理 URL，替换 Discord CDN 域名
            if (proxyUrl) {
                fileUrl = fileUrl.replace('https://cdn.discordapp.com', `https://${proxyUrl}`);
            }

            const response = await fetch(fileUrl);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // 验证分片大小是否匹配
            const chunkData = await response.arrayBuffer();
            const actualSize = chunkData.byteLength;

            // 如果有期望大小且不匹配，记录警告
            if (chunk.size && actualSize !== chunk.size) {
                console.warn(`Discord chunk ${chunk.index} size mismatch: expected ${chunk.size}, got ${actualSize}`);
            }

            return new Uint8Array(chunkData);

        } catch (error) {
            console.warn(`Discord chunk ${chunk.index} fetch attempt ${attempt + 1} failed:`, error.message);

            if (attempt === maxRetries - 1) {
                return null; // 最后一次尝试也失败了
            }

            // 指数退避重试: 500ms, 1000ms, 2000ms
            await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
        }
    }

    return null;
}

// 处理R2文件读取
async function handleR2File(context, fileId, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    try {
        // 检查是否配置了R2
        if (typeof env.img_r2 == "undefined" || env.img_r2 == null || env.img_r2 == "") {
            return new Response('Error: Please configure R2 database', { status: 500 });
        }

        const R2DataBase = env.img_r2;

        // 检查Range请求头
        const range = request.headers.get('Range');
        let object;

        if (range) {
            // 处理Range请求
            const matches = range.match(/bytes=(\d+)-(\d*)/);
            if (matches) {
                const start = parseInt(matches[1]);
                const end = matches[2] ? parseInt(matches[2]) : undefined;

                const rangeOptions = {
                    range: {
                        offset: start
                    }
                };
                if (end !== undefined) {
                    rangeOptions.range.length = end - start + 1;
                }

                object = await R2DataBase.get(fileId, rangeOptions);
            } else {
                object = await R2DataBase.get(fileId);
            }
        } else {
            object = await R2DataBase.get(fileId);
        }

        if (object === null) {
            return new Response('Error: Failed to fetch file', { status: 500 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

        // 确保设置 Content-Length（用于HEAD请求和正常请求）
        if (!headers.has('Content-Length') && object.size) {
            headers.set('Content-Length', object.size.toString());
        }

        // 处理HEAD请求
        if (request.method === 'HEAD') {
            return handleHeadRequest(headers);
        }

        // 如果是Range请求，设置相应的状态码和头
        if (range && object.range) {
            headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
            headers.set('Content-Length', object.range.length.toString());

            return new Response(createFixedLengthBody(object.body, object.range.length), {
                status: 206, // Partial Content
                headers,
            });
        }

        // 正常请求 - 确保设置 Content-Length
        if (!headers.has('Content-Length') && object.size) {
            headers.set('Content-Length', object.size.toString());
        }

        const r2Body = object.size ? createFixedLengthBody(object.body, object.size) : object.body;
        return new Response(r2Body, {
            status: 200,
            headers,
        });
    } catch (error) {
        return new Response(`Error: Failed to fetch from R2 - ${error.message}`, { status: 500 });
    }
}

// 处理S3文件读取
async function handleS3File(context, metadata, encodedFileName, fileType) {
    const { Referer, url, request } = context;

    // 检查是否配置了 CDN 文件完整路径
    const cdnFileUrl = metadata?.S3CdnFileUrl;

    // 如果配置了 CDN 文件路径，通过 CDN 读取文件
    if (cdnFileUrl) {
        try {
            // 处理 HEAD 请求
            if (request.method === 'HEAD') {
                const headers = new Headers();
                setCommonHeaders(headers, encodedFileName, fileType, Referer, url);
                if (metadata?.FileSizeBytes) {
                    headers.set('Content-Length', metadata.FileSizeBytes.toString());
                }
                return handleHeadRequest(headers);
            }

            // 构建请求头
            const fetchHeaders = {};

            // 支持 Range 请求
            const range = request.headers.get('Range');
            if (range) {
                fetchHeaders['Range'] = range;
            }

            // 通过 CDN 获取文件（直接使用完整路径，无需拼接）
            const response = await fetch(cdnFileUrl, {
                method: 'GET',
                headers: fetchHeaders
            });

            if (!response.ok && response.status !== 206) {
                // CDN 读取失败，回退到 S3 API
                console.warn(`CDN fetch failed (${response.status}), falling back to S3 API`);
                return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
            }

            // 构建响应头
            const headers = new Headers();
            setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

            // 复制相关头部
            if (response.headers.get('Content-Length')) {
                headers.set('Content-Length', response.headers.get('Content-Length'));
            }
            if (response.headers.get('Content-Range')) {
                headers.set('Content-Range', response.headers.get('Content-Range'));
            }

            // 确保 Content-Length 存在，使用元数据中的文件大小作为后备
            if (!headers.has('Content-Length') && metadata?.FileSizeBytes) {
                headers.set('Content-Length', metadata.FileSizeBytes.toString());
            }

            // 使用 FixedLengthStream 确保 Content-Length 不被剥离
            const s3CdnCL = parseInt(headers.get('Content-Length'));
            const s3CdnBody = (s3CdnCL > 0 && response.body)
                ? createFixedLengthBody(response.body, s3CdnCL)
                : response.body;

            return new Response(s3CdnBody, {
                status: response.status,
                headers
            });

        } catch (error) {
            // CDN 读取出错，回退到 S3 API
            console.error(`CDN fetch error: ${error.message}, falling back to S3 API`);
            return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
        }
    }

    // 没有配置 CDN 文件路径，使用 S3 API
    return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
}

// 通过 S3 API 读取文件
async function handleS3FileViaAPI(context, metadata, encodedFileName, fileType) {
    const { Referer, url, request } = context;

    const s3Client = new S3Client({
        region: metadata?.S3Region || "auto",
        endpoint: metadata?.S3Endpoint,
        credentials: {
            accessKeyId: metadata?.S3AccessKeyId,
            secretAccessKey: metadata?.S3SecretAccessKey
        },
        forcePathStyle: metadata?.S3PathStyle || false
    });

    const bucketName = metadata?.S3BucketName;
    const key = metadata?.S3FileKey;

    try {
        // 检查Range请求头
        const range = request.headers.get('Range');
        const commandParams = {
            Bucket: bucketName,
            Key: key
        };

        if (range) {
            // 添加Range参数用于部分内容请求
            commandParams.Range = range;
        }

        const command = new GetObjectCommand(commandParams);
        const response = await s3Client.send(command);

        // 设置响应头
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

        // 设置Content-Length和Content-Range头
        if (response.ContentLength) {
            headers.set('Content-Length', response.ContentLength.toString());
        }

        if (response.ContentRange) {
            headers.set('Content-Range', response.ContentRange);
        }

        // 确保 Content-Length 存在，使用元数据中的文件大小作为后备
        if (!headers.has('Content-Length') && metadata?.FileSizeBytes) {
            headers.set('Content-Length', metadata.FileSizeBytes.toString());
        }

        // 处理HEAD请求
        if (request.method === 'HEAD') {
            return handleHeadRequest(headers);
        }

        // 返回响应，支持流式传输
        const statusCode = range ? 206 : 200; // Range请求返回206 Partial Content
        const s3ApiCL = parseInt(headers.get('Content-Length'));
        const s3ApiBody = (s3ApiCL > 0 && response.Body)
            ? createFixedLengthBody(response.Body, s3ApiCL)
            : response.Body;

        return new Response(s3ApiBody, {
            status: statusCode,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from S3 - ${error.message}`, { status: 500 });
    }
}


// 处理 Discord 文件读取
async function handleDiscordFile(context, metadata, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    try {
        // 每次读取都通过 API 获取新的附件 URL（因为 Discord 附件 URL 会在约24小时后过期）
        let fileUrl = null;
        if (metadata.DiscordMessageId && metadata.DiscordChannelId && metadata.DiscordBotToken) {
            const discordAPI = new DiscordAPI(metadata.DiscordBotToken);
            fileUrl = await discordAPI.getFileURL(metadata.DiscordChannelId, metadata.DiscordMessageId);
        }

        if (!fileUrl) {
            return new Response('Error: Discord file URL not found', { status: 500 });
        }

        // 如果配置了代理 URL，替换 Discord CDN 域名
        if (metadata.DiscordProxyUrl) {
            fileUrl = fileUrl.replace('https://cdn.discordapp.com', `https://${metadata.DiscordProxyUrl}`);
        }

        // 处理 HEAD 请求
        if (request.method === 'HEAD') {
            const headers = new Headers();
            setCommonHeaders(headers, encodedFileName, fileType, Referer, url);
            if (metadata.FileSizeBytes) {
                headers.set('Content-Length', metadata.FileSizeBytes.toString());
            }
            return handleHeadRequest(headers);
        }

        // 获取文件内容（支持 Range 请求）
        const fetchHeaders = {};
        const range = request.headers.get('Range');
        if (range) {
            fetchHeaders['Range'] = range;
        }

        const response = await fetch(fileUrl, {
            method: 'GET',
            headers: fetchHeaders
        });

        if (!response.ok && response.status !== 206) {
            return new Response(`Error: Failed to fetch from Discord - ${response.status}`, { status: response.status });
        }

        // 构建响应头
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

        // 复制相关头部
        if (response.headers.get('Content-Length')) {
            headers.set('Content-Length', response.headers.get('Content-Length'));
        }
        if (response.headers.get('Content-Range')) {
            headers.set('Content-Range', response.headers.get('Content-Range'));
        }

        // 确保 Content-Length 存在，使用元数据中的文件大小作为后备
        if (!headers.has('Content-Length') && metadata.FileSizeBytes) {
            headers.set('Content-Length', metadata.FileSizeBytes.toString());
        }

        // 使用 FixedLengthStream 确保 Content-Length 不被剥离
        const discordCL = parseInt(headers.get('Content-Length'));
        const discordBody = (discordCL > 0 && response.body)
            ? createFixedLengthBody(response.body, discordCL)
            : response.body;

        return new Response(discordBody, {
            status: response.status,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from Discord - ${error.message}`, { status: 500 });
    }
}


// 处理 HuggingFace 文件读取
async function handleHuggingFaceFile(context, metadata, encodedFileName, fileType) {
    const { request, url, Referer } = context;

    try {
        const hfRepo = metadata.HfRepo;
        const hfFilePath = metadata.HfFilePath;
        const hfToken = metadata.HfToken;
        const hfIsPrivate = metadata.HfIsPrivate || false;

        if (!hfRepo || !hfFilePath) {
            return new Response('Error: HuggingFace file info not found', { status: 500 });
        }

        // 构建文件 URL
        const fileUrl = metadata.HfFileUrl || `https://huggingface.co/datasets/${hfRepo}/resolve/main/${hfFilePath}`;

        // 处理 HEAD 请求
        if (request.method === 'HEAD') {
            const headers = new Headers();
            setCommonHeaders(headers, encodedFileName, fileType, Referer, url);
            if (metadata.FileSizeBytes) {
                headers.set('Content-Length', metadata.FileSizeBytes.toString());
            }
            return handleHeadRequest(headers);
        }

        // 构建请求头
        const fetchHeaders = {};

        // 私有仓库需要 Authorization
        if (hfIsPrivate && hfToken) {
            fetchHeaders['Authorization'] = `Bearer ${hfToken}`;
        }

        // 支持 Range 请求
        const range = request.headers.get('Range');
        if (range) {
            fetchHeaders['Range'] = range;
        }

        const response = await fetch(fileUrl, {
            method: 'GET',
            headers: fetchHeaders
        });

        if (!response.ok && response.status !== 206) {
            return new Response(`Error: Failed to fetch from HuggingFace - ${response.status}`, { status: response.status });
        }

        // 构建响应头
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, Referer, url);

        // 复制相关头部
        if (response.headers.get('Content-Length')) {
            headers.set('Content-Length', response.headers.get('Content-Length'));
        }
        if (response.headers.get('Content-Range')) {
            headers.set('Content-Range', response.headers.get('Content-Range'));
        }

        // 确保 Content-Length 存在，使用元数据中的文件大小作为后备
        if (!headers.has('Content-Length') && metadata.FileSizeBytes) {
            headers.set('Content-Length', metadata.FileSizeBytes.toString());
        }

        return new Response(response.body, {
            status: response.status,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from HuggingFace - ${error.message}`, { status: 500 });
    }
}
