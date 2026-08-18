import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { fetchSecurityConfig } from "../utils/sysConfig";
import { TelegramAPI } from "../utils/telegramAPI.js";
import { DiscordAPI } from "../utils/discordAPI.js";
import { HuggingFaceAPI } from "../utils/huggingfaceAPI.js";
import { buildWebDAVUrl, WebDAVAPI } from "../utils/storage/webdavAPI";
import {
    setCommonHeaders, setRangeHeaders, handleHeadRequest, getFileContent, isTgChannel,
    returnWithCheck, return404, returnBlockImg, isDomainAllowed, FILE_CACHE_CONTROL,
    createFixedLengthBody, resolveResponseLength, parseSingleRange
} from './fileTools';
import { getDatabase } from '../utils/databaseAdapter.js';
import { authenticate, AUTH_SCOPE } from '../utils/auth/authCore.js';
import {
    resolveDiscordCredentials,
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveTelegramCredentials,
    resolveWebDAVCredentials,
} from '../utils/metadata/channelCredentials.js';
import { buildCdnFileUrl } from '../utils/metadata/metadataView.js';


export async function onRequest(context) {  // Contents of context object
    const {
        request, // same as existing Worker API
        env, // same as existing Worker API
        params, // if filename includes [id] or [[path]]
        waitUntil, // same as ctx.waitUntil in existing Worker API
        next, // used for middleware or to fetch assets
        data, // arbitrary space for passing data between middlewares
    } = context;

    // 瑙ｇ爜鏂囦欢ID
    let fileId = '';
    try {
        params.path = decodeURIComponent(params.path);
        fileId = params.path.split(',').join('/');
    } catch (e) {
        return new Response('Error: Decode Image ID Failed', { status: 400 });
    }

    const url = new URL(request.url);
    context.url = url;

    const Referer = request.headers.get('Referer')
    context.Referer = Referer;

    const db = getDatabase(env);

    // Fetch security config, admin-preview auth and file record in parallel
    // (independent KV round-trips on the hot file-serving path)
    const [securityConfig, fileAccess, imgRecord] = await Promise.all([
        fetchSecurityConfig(env),
        buildFileAccessContext(context),
        db.getWithMetadata(fileId),
    ]);
    context.securityConfig = securityConfig;
    // 若上游已设置 fileAccess（如 /temp/{token} 转发），保留之；否则使用本次构建的结果
    if (!context.fileAccess) {
        context.fileAccess = fileAccess;
    }

    // 临时链接访问跳过域名白名单检查（链接本身即是访问凭据）
    if (!context.skipDomainCheck && !isDomainAllowed(context)) {
        return await returnBlockImg(url);
    }

    if (!imgRecord) {
        return new Response('Error: Image Not Found', { status: 404 });
    }

    // 濡傛灉metadata涓嶅瓨鍦紝鍙彲鑳芥槸涔嬪墠鏈缃甂V锛屼笖瀛樺偍鍦═elegraph涓婄殑鍥剧墖
    if (!imgRecord.metadata) {
        imgRecord.metadata = {};
    }

    const fileName = imgRecord.metadata?.FileName || fileId;
    const encodedFileName = encodeURIComponent(fileName);
    const fileType = imgRecord.metadata?.FileType || null;

    // 妫€鏌ユ枃浠跺彲璁块棶鐘舵€?
    let accessRes = await returnWithCheck(context, imgRecord);
    if (accessRes.status !== 200) {
        return accessRes; // 濡傛灉涓嶅彲璁块棶锛岀洿鎺ヨ繑鍥?
    }

    /* Cloudflare R2娓犻亾 */
    if (imgRecord.metadata?.Channel === 'CloudflareR2') {
        return await handleR2File(context, fileId, encodedFileName, fileType);
    }

    /* S3娓犻亾 */
    if (imgRecord.metadata?.Channel === "S3") {
        return await handleS3File(context, imgRecord.metadata, encodedFileName, fileType);
    }

    /* Discord 娓犻亾 */
    if (imgRecord.metadata?.Channel === 'Discord') {
        // 妫€鏌ユ槸鍚︿负鍒嗙墖鏂囦欢
        if (imgRecord.metadata?.IsChunked === true) {
            return await handleDiscordChunkedFile(context, imgRecord, encodedFileName, fileType);
        }
        return await handleDiscordFile(context, imgRecord.metadata, encodedFileName, fileType);
    }

    /* HuggingFace 娓犻亾 */
    if (imgRecord.metadata?.Channel === 'HuggingFace') {
        return await handleHuggingFaceFile(context, imgRecord.metadata, encodedFileName, fileType);
    }

    /* WebDAV 娓犻亾 */
    if (imgRecord.metadata?.Channel === 'WebDAV') {
        return await handleWebDAVFile(context, imgRecord.metadata, encodedFileName, fileType);
    }

    /* 澶栭摼娓犻亾 */
    if (imgRecord.metadata?.Channel === 'External') {
        // 仅允许 http/https 外链重定向，防止历史数据中的 javascript:/data: 等协议造成开放重定向或 XSS
        const externalLink = imgRecord.metadata?.ExternalLink;
        try {
            const parsed = new URL(String(externalLink));
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return new Response('Error: Invalid external link', { status: 400 });
            }
            return Response.redirect(parsed.toString(), 302);
        } catch {
            return new Response('Error: Invalid external link', { status: 400 });
        }
    }

    /* Telegram鍙奣elegraph娓犻亾 */

    // 鏋勫缓鐩爣 URL
    let targetUrl = '';

    if (isTgChannel(imgRecord)) {
        let TgFileID = ''; // Tg鐨刦ile_id

        if (imgRecord.metadata?.Channel === 'Telegram') {
            TgFileID = fileId.split('.')[0]; // id涓篺ile_id + ext
        } else if (imgRecord.metadata?.Channel === 'TelegramNew') {
            // 妫€鏌ユ槸鍚︿负鍒嗙墖鏂囦欢
            if (imgRecord.metadata?.IsChunked === true) {
                return await handleTelegramChunkedFile(context, imgRecord, encodedFileName, fileType);
            }

            TgFileID = imgRecord.metadata?.TgFileId;

            if (TgFileID === null) {
                return new Response('Error: Failed to fetch image', { status: 500 });
            }
        }

        // 鑾峰彇TG鍥剧墖鐪熷疄鍦板潃锛堟敮鎸佷唬鐞嗗煙鍚嶏級
        const tgCredentials = await resolveTelegramCredentials(db, env, imgRecord.metadata);
        const TgBotToken = tgCredentials.botToken;
        const TgProxyUrl = tgCredentials.proxyUrl || '';
        const tgApi = new TelegramAPI(TgBotToken, TgProxyUrl);
        const filePath = await tgApi.getFilePath(TgFileID);
        if (filePath === null) {
            return new Response('Error: Failed to fetch image path', { status: 500 });
        }
        // 浣跨敤浠ｇ悊鍩熷悕鎴栧畼鏂瑰煙鍚?
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
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

        if (response.status === 304) {
            return new Response(null, { status: 304, headers });
        }

        const fallbackSize = response.status === 206
            ? null
            : getMetadataFileSize(imgRecord.metadata);
        const body = prepareFileBody(headers, response.body, fallbackSize);

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

async function buildFileAccessContext(context) {
    const { request, env, url } = context;
    const fromAdmin = url.searchParams.get('from') === 'admin';
    const fileAccess = {
        isAdminPreview: fromAdmin,
        adminAuthResult: { authorized: false, authType: null },
        cacheControl: undefined,
    };

    if (fileAccess.isAdminPreview) {
        try {
            fileAccess.adminAuthResult = await authenticate({
                env,
                request,
                requiredPermission: 'manage',
                authScope: AUTH_SCOPE.ADMIN,
            });
        } catch (e) {
            // 鉴权异常（如安全配置加载失败）不应阻断文件请求；
            // 标记为未授权，交由 returnWithCheck 的同源 Referer 兜底处理。
            console.error('Admin preview auth failed:', e.message);
        }
    }

    return fileAccess;
}

function getFileCacheControl(context) {
    return context.fileAccess?.cacheControl;
}

function getChunkedFileCacheControl(context) {
    return getFileCacheControl(context) === FILE_CACHE_CONTROL.NO_STORE
        ? FILE_CACHE_CONTROL.NO_STORE
        : FILE_CACHE_CONTROL.PRIVATE;
}

function getMetadataFileSize(metadata) {
    // FileSize is a rounded MB display string and must never be treated as bytes.
    const candidates = [metadata?.FileSizeBytes];
    for (const candidate of candidates) {
        if (candidate === null || candidate === undefined || candidate === '') continue;
        const size = Number(candidate);
        if (Number.isSafeInteger(size) && size >= 0) return size;
    }
    return null;
}

/**
 * Normalize an upstream/object response so Workers can keep its exact length.
 * A manually supplied Content-Length is not enough for arbitrary streams in
 * Workers; FixedLengthStream also makes premature/overlong bodies observable.
 */
function prepareFileBody(headers, body, fallbackSize = null) {
    const contentLength = resolveResponseLength(headers, fallbackSize);
    if (contentLength === null) return body;

    headers.set('Content-Length', contentLength.toString());
    return body ? createFixedLengthBody(body, contentLength) : body;
}

function rangeNotSatisfiable(totalSize) {
    const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${totalSize}`,
        'Content-Length': '0',
    });
    return new Response(null, { status: 416, headers });
}

function normalizeChunkList(chunks) {
    let totalSize = 0;
    const normalizedChunks = [];

    for (const chunk of chunks) {
        const size = Number(chunk?.size);
        if (!Number.isSafeInteger(size) || size <= 0) return null;
        totalSize += size;
        if (!Number.isSafeInteger(totalSize)) return null;
        normalizedChunks.push({ ...chunk, size });
    }

    return { chunks: normalizedChunks, totalSize };
}


// 澶勭悊 Telegram 娓犻亾鍒嗙墖鏂囦欢璇诲彇
async function handleTelegramChunkedFile(context, imgRecord, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    const metadata = imgRecord.metadata;
    const db = getDatabase(env);
    const tgCredentials = await resolveTelegramCredentials(db, env, metadata);
    const fallbackTgBotToken = tgCredentials.botToken;
    const fallbackTgProxyUrl = tgCredentials.proxyUrl || '';

    // 浠嶬V鐨剉alue涓鍙栧垎鐗囦俊鎭?
    let chunks = [];
    try {
        if (imgRecord.value) {
            chunks = JSON.parse(imgRecord.value);
            chunks.sort((a, b) => a.index - b.index);
        }
    } catch (parseError) {
        console.error('Failed to parse chunks data:', parseError);
        return new Response('Error: Invalid chunks data', { status: 500 });
    }

    if (chunks.length === 0) {
        return new Response('Error: No chunks found for this file', { status: 500 });
    }

    // 楠岃瘉鍒嗙墖瀹屾暣鎬?
    const expectedChunks = metadata.TotalChunks || chunks.length;
    if (chunks.length !== expectedChunks) {
        return new Response(`Error: Missing chunks, expected ${expectedChunks}, got ${chunks.length}`, { status: 500 });
    }

    const normalized = normalizeChunkList(chunks);
    if (!normalized || normalized.totalSize <= 0) {
        return new Response('Error: Invalid chunk sizes', { status: 500 });
    }
    chunks = normalized.chunks;
    const totalSize = normalized.totalSize;

    // 鏋勫缓鍝嶅簲澶?
    const headers = new Headers();
    setCommonHeaders(headers, encodedFileName, fileType, getChunkedFileCacheControl(context));
    headers.set('Content-Length', totalSize.toString());

    // 娣诲姞ETag鏀寔
    const etag = `"${metadata.TimeStamp || Date.now()}-${totalSize}"`;
    headers.set('ETag', etag);

    // 妫€鏌f-None-Match澶达紙304缂撳瓨锛?
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

    // 妫€鏌ange璇锋眰澶?
    const range = request.headers.get('Range');
    let rangeStart = 0;
    let rangeEnd = totalSize - 1;
    let isRangeRequest = false;

    if (range) {
        const parsedRange = parseSingleRange(range, totalSize);
        if (!parsedRange) return rangeNotSatisfiable(totalSize);
        rangeStart = parsedRange.start;
        rangeEnd = parsedRange.end;
        isRangeRequest = true;
    }

    // 澶勭悊HEAD璇锋眰
    if (request.method === 'HEAD') {
        return handleHeadRequest(headers, etag);
    }

    try {
        // 鍒涘缓鏀寔Range璇锋眰鐨勬祦
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    let currentPosition = 0;

                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        const chunkSize = chunk.size || 0;

                        // 濡傛灉褰撳墠鍒嗙墖瀹屽叏鍦ㄨ姹傝寖鍥翠箣鍓嶏紝璺宠繃
                        if (currentPosition + chunkSize <= rangeStart) {
                            currentPosition += chunkSize;
                            continue;
                        }

                        // 濡傛灉褰撳墠鍒嗙墖瀹屽叏鍦ㄨ姹傝寖鍥翠箣鍚庯紝缁撴潫
                        if (currentPosition > rangeEnd) {
                            break;
                        }

                        // 鑾峰彇鍒嗙墖鏁版嵁锛堟敮鎸佷唬鐞嗗煙鍚嶏級
                        // Compatibility for historical uploads whose chunks were
                        // spread across multiple bots. Telegram file_ids are
                        // bot-scoped, so each chunk must use its original token.
                        const chunkBotToken = chunk.tgBotToken || fallbackTgBotToken;
                        const chunkProxyUrl = typeof chunk.tgProxyUrl === 'string'
                            ? chunk.tgProxyUrl
                            : fallbackTgProxyUrl;
                        const chunkData = await fetchTelegramChunkWithRetry(chunkBotToken, chunk, chunkProxyUrl, 3);
                        if (!chunkData) {
                            throw new Error(`Failed to fetch chunk ${chunk.index} after retries`);
                        }

                        // 璁＄畻鍦ㄥ綋鍓嶅垎鐗囦腑鐨勮捣濮嬪拰缁撴潫浣嶇疆
                        const chunkStart = Math.max(0, rangeStart - currentPosition);
                        const chunkEnd = Math.min(chunkSize, rangeEnd - currentPosition + 1);

                        // 濡傛灉闇€瑕侀儴鍒嗗垎鐗囨暟鎹?
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

        // 璁剧疆Range鐩稿叧澶撮儴
        if (isRangeRequest) {
            setRangeHeaders(headers, rangeStart, rangeEnd, totalSize);

            return new Response(prepareFileBody(headers, stream), {
                status: 206, // Partial Content
                headers,
            });
        } else {
            headers.set('Cache-Control', getChunkedFileCacheControl(context)); // CDN 涓嶇紦瀛樺畬鏁存枃浠讹紝閬垮厤 CDN 涓嶆敮鎸?Range 璇锋眰

            return new Response(prepareFileBody(headers, stream, totalSize), {
                status: 200,
                headers,
            });
        }

    } catch (error) {
        return new Response(`Error: Failed to reconstruct chunked file - ${error.message}`, { status: 500 });
    }
}

// 甯﹂噸璇曟満鍒剁殑Telegram鍒嗙墖鑾峰彇鍑芥暟锛堟敮鎸佷唬鐞嗗煙鍚嶏級
async function fetchTelegramChunkWithRetry(botToken, chunk, proxyUrl = '', maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const tgApi = new TelegramAPI(botToken, proxyUrl);

            const response = await tgApi.getFileContent(chunk.fileId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // 楠岃瘉鍒嗙墖澶у皬鏄惁鍖归厤
            const chunkData = await response.arrayBuffer();
            const actualSize = chunkData.byteLength;

            // A short/overlong upstream response must not be appended to the
            // reconstructed file. Retry it; otherwise archives are corrupted.
            if (actualSize !== chunk.size) {
                throw new Error(`size mismatch: expected ${chunk.size}, got ${actualSize}`);
            }

            return new Uint8Array(chunkData);

        } catch (error) {
            console.warn(`Chunk ${chunk.index} fetch attempt ${attempt + 1} failed:`, error.message);

            if (attempt === maxRetries - 1) {
                return null; // 鏈€鍚庝竴娆″皾璇曚篃澶辫触浜?
            }

            // 閲嶈瘯鍓嶇瓑寰呬竴娈垫椂闂?
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }

    return null;
}

// 澶勭悊 Discord 娓犻亾鍒嗙墖鏂囦欢璇诲彇
async function handleDiscordChunkedFile(context, imgRecord, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    const metadata = imgRecord.metadata;
    const db = getDatabase(env);
    const discordCredentials = await resolveDiscordCredentials(db, env, metadata);
    const botToken = discordCredentials.botToken;
    const channelId = discordCredentials.channelId;
    const proxyUrl = discordCredentials.proxyUrl;

    // 浠嶬V鐨剉alue涓鍙栧垎鐗囦俊鎭?
    let chunks = [];
    try {
        if (imgRecord.value) {
            chunks = JSON.parse(imgRecord.value);
            chunks.sort((a, b) => a.index - b.index);
        }
    } catch (parseError) {
        console.error('Failed to parse Discord chunks data:', parseError);
        return new Response('Error: Invalid chunks data', { status: 500 });
    }

    if (chunks.length === 0) {
        return new Response('Error: No chunks found for this file', { status: 500 });
    }

    // 楠岃瘉鍒嗙墖瀹屾暣鎬?
    const expectedChunks = metadata.TotalChunks || chunks.length;
    if (chunks.length !== expectedChunks) {
        return new Response(`Error: Missing chunks, expected ${expectedChunks}, got ${chunks.length}`, { status: 500 });
    }

    const normalized = normalizeChunkList(chunks);
    if (!normalized || normalized.totalSize <= 0) {
        return new Response('Error: Invalid chunk sizes', { status: 500 });
    }
    chunks = normalized.chunks;
    const totalSize = normalized.totalSize;

    // 鏋勫缓鍝嶅簲澶?
    const headers = new Headers();
    setCommonHeaders(headers, encodedFileName, fileType, getChunkedFileCacheControl(context));
    headers.set('Content-Length', totalSize.toString());

    // 娣诲姞ETag鏀寔
    const etag = `"${metadata.TimeStamp || Date.now()}-${totalSize}"`;
    headers.set('ETag', etag);

    // 妫€鏌f-None-Match澶达紙304缂撳瓨锛?
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

    // 妫€鏌ange璇锋眰澶?
    const range = request.headers.get('Range');
    let rangeStart = 0;
    let rangeEnd = totalSize - 1;
    let isRangeRequest = false;

    if (range) {
        const parsedRange = parseSingleRange(range, totalSize);
        if (!parsedRange) return rangeNotSatisfiable(totalSize);
        rangeStart = parsedRange.start;
        rangeEnd = parsedRange.end;
        isRangeRequest = true;
    }

    // 澶勭悊HEAD璇锋眰
    if (request.method === 'HEAD') {
        return handleHeadRequest(headers, etag);
    }

    try {
        // 鍒涘缓鏀寔Range璇锋眰鐨勬祦
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    let currentPosition = 0;

                    for (let i = 0; i < chunks.length; i++) {
                        const chunk = chunks[i];
                        const chunkSize = chunk.size || 0;

                        // 濡傛灉褰撳墠鍒嗙墖瀹屽叏鍦ㄨ姹傝寖鍥翠箣鍓嶏紝璺宠繃
                        if (currentPosition + chunkSize <= rangeStart) {
                            currentPosition += chunkSize;
                            continue;
                        }

                        // 濡傛灉褰撳墠鍒嗙墖瀹屽叏鍦ㄨ姹傝寖鍥翠箣鍚庯紝缁撴潫
                        if (currentPosition > rangeEnd) {
                            break;
                        }

                        // 鑾峰彇鍒嗙墖鏁版嵁锛堟瘡娆￠€氳繃 API 鑾峰彇鏂扮殑闄勪欢 URL锛?
                        const chunkData = await fetchDiscordChunkWithRetry(botToken, channelId, chunk, proxyUrl, 3);
                        if (!chunkData) {
                            throw new Error(`Failed to fetch Discord chunk ${chunk.index} after retries`);
                        }

                        // 璁＄畻鍦ㄥ綋鍓嶅垎鐗囦腑鐨勮捣濮嬪拰缁撴潫浣嶇疆
                        const chunkStart = Math.max(0, rangeStart - currentPosition);
                        const chunkEnd = Math.min(chunkSize, rangeEnd - currentPosition + 1);

                        // 濡傛灉闇€瑕侀儴鍒嗗垎鐗囨暟鎹?
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

        // 璁剧疆Range鐩稿叧澶撮儴
        if (isRangeRequest) {
            setRangeHeaders(headers, rangeStart, rangeEnd, totalSize);

            return new Response(prepareFileBody(headers, stream), {
                status: 206, // Partial Content
                headers,
            });
        } else {
            headers.set('Cache-Control', getChunkedFileCacheControl(context));

            return new Response(prepareFileBody(headers, stream, totalSize), {
                status: 200,
                headers,
            });
        }

    } catch (error) {
        return new Response(`Error: Failed to reconstruct Discord chunked file - ${error.message}`, { status: 500 });
    }
}

// 甯﹂噸璇曟満鍒剁殑Discord鍒嗙墖鑾峰彇鍑芥暟锛堟瘡娆￠€氳繃 API 鑾峰彇鏂扮殑闄勪欢 URL锛?
async function fetchDiscordChunkWithRetry(botToken, channelId, chunk, proxyUrl, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // 閫氳繃 Discord API 鑾峰彇鏂扮殑闄勪欢 URL锛堝洜涓?URL 浼氬湪绾?4灏忔椂鍚庤繃鏈燂級
            const discordAPI = new DiscordAPI(botToken);
            let fileUrl = await discordAPI.getFileURL(channelId, chunk.messageId);

            if (!fileUrl) {
                throw new Error('Failed to get attachment URL from Discord API');
            }

            // 濡傛灉閰嶇疆浜嗕唬鐞?URL锛屾浛鎹?Discord CDN 鍩熷悕
            if (proxyUrl) {
                fileUrl = fileUrl.replace('https://cdn.discordapp.com', `https://${proxyUrl}`);
            }

            const response = await fetch(fileUrl);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // 楠岃瘉鍒嗙墖澶у皬鏄惁鍖归厤
            const chunkData = await response.arrayBuffer();
            const actualSize = chunkData.byteLength;

            // Reject incomplete CDN reads instead of silently assembling a
            // corrupt file. The surrounding loop will retry with a fresh URL.
            if (actualSize !== chunk.size) {
                throw new Error(`size mismatch: expected ${chunk.size}, got ${actualSize}`);
            }

            return new Uint8Array(chunkData);

        } catch (error) {
            console.warn(`Discord chunk ${chunk.index} fetch attempt ${attempt + 1} failed:`, error.message);

            if (attempt === maxRetries - 1) {
                return null; // 鏈€鍚庝竴娆″皾璇曚篃澶辫触浜?
            }

            // 閲嶈瘯鍓嶇瓑寰呬竴娈垫椂闂?
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }

    return null;
}

// 澶勭悊R2鏂囦欢璇诲彇
async function handleR2File(context, fileId, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    try {
        // 妫€鏌ユ槸鍚﹂厤缃簡R2
        if (typeof env.img_r2 == "undefined" || env.img_r2 == null || env.img_r2 == "") {
            return new Response('Error: Please configure R2 database', { status: 500 });
        }

        const R2DataBase = env.img_r2;

        // 妫€鏌ange璇锋眰澶?
        const range = request.headers.get('Range');
        let object;

        if (range) {
            // 澶勭悊Range璇锋眰
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
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));
        headers.set('Content-Length', object.size.toString());

        // 澶勭悊HEAD璇锋眰
        if (request.method === 'HEAD') {
            return handleHeadRequest(headers);
        }

        // 濡傛灉鏄疪ange璇锋眰锛岃缃浉搴旂殑鐘舵€佺爜鍜屽ご
        if (range && object.range) {
            headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
            headers.set('Content-Length', object.range.length.toString());

            return new Response(prepareFileBody(headers, object.body), {
                status: 206, // Partial Content
                headers,
            });
        }

        // 姝ｅ父璇锋眰
        return new Response(prepareFileBody(headers, object.body, object.size), {
            status: 200,
            headers,
        });
    } catch (error) {
        return new Response(`Error: Failed to fetch from R2 - ${error.message}`, { status: 500 });
    }
}

// 澶勭悊S3鏂囦欢璇诲彇
async function handleS3File(context, metadata, encodedFileName, fileType) {
    const { Referer, url, request } = context;

    // 妫€鏌ユ槸鍚﹂厤缃簡 CDN 鏂囦欢瀹屾暣璺緞
    const cdnFileUrl = await getS3CdnFileUrl(context.env, metadata);

    // 濡傛灉閰嶇疆浜?CDN 鏂囦欢璺緞锛岄€氳繃 CDN 璇诲彇鏂囦欢
    if (cdnFileUrl) {
        try {
            // 澶勭悊 HEAD 璇锋眰
            if (request.method === 'HEAD') {
                const headers = new Headers();
                setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));
                const fileSize = getMetadataFileSize(metadata);
                if (fileSize !== null) headers.set('Content-Length', fileSize.toString());
                return handleHeadRequest(headers);
            }

            // 鏋勫缓璇锋眰澶?
            const fetchHeaders = {};

            // 鏀寔 Range 璇锋眰
            const range = request.headers.get('Range');
            if (range) {
                fetchHeaders['Range'] = range;
            }

            // 閫氳繃 CDN 鑾峰彇鏂囦欢锛堢洿鎺ヤ娇鐢ㄥ畬鏁磋矾寰勶紝鏃犻渶鎷兼帴锛?
            const response = await fetch(cdnFileUrl, {
                method: 'GET',
                headers: fetchHeaders
            });

            if (!response.ok && response.status !== 206) {
                // CDN 璇诲彇澶辫触锛屽洖閫€鍒?S3 API
                console.warn(`CDN fetch failed (${response.status}), falling back to S3 API`);
                return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
            }

            // 鏋勫缓鍝嶅簲澶?
            const headers = new Headers();
            setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

            // 澶嶅埗鐩稿叧澶撮儴
            if (response.headers.get('Content-Length')) {
                headers.set('Content-Length', response.headers.get('Content-Length'));
            }
            if (response.headers.get('Content-Range')) {
                headers.set('Content-Range', response.headers.get('Content-Range'));
            }

            const fallbackSize = response.status === 206 ? null : getMetadataFileSize(metadata);
            const body = prepareFileBody(headers, response.body, fallbackSize);

            return new Response(body, {
                status: response.status,
                headers
            });

        } catch (error) {
            // CDN 璇诲彇鍑洪敊锛屽洖閫€鍒?S3 API
            console.error(`CDN fetch error: ${error.message}, falling back to S3 API`);
            return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
        }
    }

    // 娌℃湁閰嶇疆 CDN 鏂囦欢璺緞锛屼娇鐢?S3 API
    return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
}

async function getS3CdnFileUrl(env, metadata) {
    try {
        const db = getDatabase(env);
        const s3Credentials = await resolveS3Credentials(db, env, metadata);
        return buildCdnFileUrl(s3Credentials.cdnDomain, s3Credentials.key);
    } catch (error) {
        console.warn('Failed to build S3 CDN file URL:', error.message);
        return '';
    }
}

// 閫氳繃 S3 API 璇诲彇鏂囦欢
async function handleS3FileViaAPI(context, metadata, encodedFileName, fileType) {
    const { Referer, url, request, env } = context;
    const db = getDatabase(env);
    const s3Credentials = await resolveS3Credentials(db, env, metadata);

    const s3Client = new S3Client({
        region: s3Credentials.region || "auto",
        endpoint: s3Credentials.endpoint,
        credentials: {
            accessKeyId: s3Credentials.accessKeyId,
            secretAccessKey: s3Credentials.secretAccessKey
        },
        forcePathStyle: s3Credentials.pathStyle || false
    });

    const bucketName = s3Credentials.bucketName;
    const key = s3Credentials.key;

    try {
        // 妫€鏌ange璇锋眰澶?
        const range = request.headers.get('Range');
        const commandParams = {
            Bucket: bucketName,
            Key: key
        };

        if (range) {
            // 娣诲姞Range鍙傛暟鐢ㄤ簬閮ㄥ垎鍐呭璇锋眰
            commandParams.Range = range;
        }

        const command = new GetObjectCommand(commandParams);
        const response = await s3Client.send(command);

        // 璁剧疆鍝嶅簲澶?
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

        // 璁剧疆Content-Length鍜孋ontent-Range澶?
        if (response.ContentLength !== undefined && response.ContentLength !== null) {
            headers.set('Content-Length', response.ContentLength.toString());
        }

        if (response.ContentRange) {
            headers.set('Content-Range', response.ContentRange);
        }

        const isPartialResponse = Boolean(response.ContentRange);
        const fallbackSize = isPartialResponse ? null : getMetadataFileSize(metadata);
        const contentLength = resolveResponseLength(headers, fallbackSize);
        if (contentLength !== null) headers.set('Content-Length', contentLength.toString());

        // 澶勭悊HEAD璇锋眰
        if (request.method === 'HEAD') {
            return handleHeadRequest(headers);
        }

        // 杩斿洖鍝嶅簲锛屾敮鎸佹祦寮忎紶杈?
        const statusCode = isPartialResponse ? 206 : 200;
        return new Response(prepareFileBody(headers, response.Body, fallbackSize), {
            status: statusCode,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from S3 - ${error.message}`, { status: 500 });
    }
}


// 澶勭悊 Discord 鏂囦欢璇诲彇
async function handleDiscordFile(context, metadata, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    try {
        const db = getDatabase(env);
        const discordCredentials = await resolveDiscordCredentials(db, env, metadata);
        // 姣忔璇诲彇閮介€氳繃 API 鑾峰彇鏂扮殑闄勪欢 URL锛堝洜涓?Discord 闄勪欢 URL 浼氬湪绾?4灏忔椂鍚庤繃鏈燂級
        let fileUrl = null;
        if (discordCredentials.messageId && discordCredentials.channelId && discordCredentials.botToken) {
            const discordAPI = new DiscordAPI(discordCredentials.botToken);
            fileUrl = await discordAPI.getFileURL(discordCredentials.channelId, discordCredentials.messageId);
        }

        if (!fileUrl) {
            return new Response('Error: Discord file URL not found', { status: 500 });
        }

        // 濡傛灉閰嶇疆浜嗕唬鐞?URL锛屾浛鎹?Discord CDN 鍩熷悕
        if (discordCredentials.proxyUrl) {
            fileUrl = fileUrl.replace('https://cdn.discordapp.com', `https://${discordCredentials.proxyUrl}`);
        }

        // 澶勭悊 HEAD 璇锋眰
        if (request.method === 'HEAD') {
            const headers = new Headers();
            setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));
            const fileSize = getMetadataFileSize(metadata);
            if (fileSize !== null) headers.set('Content-Length', fileSize.toString());
            return handleHeadRequest(headers);
        }

        // 鑾峰彇鏂囦欢鍐呭锛堟敮鎸?Range 璇锋眰锛?
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

        // 鏋勫缓鍝嶅簲澶?
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

        // 澶嶅埗鐩稿叧澶撮儴
        if (response.headers.get('Content-Length')) {
            headers.set('Content-Length', response.headers.get('Content-Length'));
        }
        if (response.headers.get('Content-Range')) {
            headers.set('Content-Range', response.headers.get('Content-Range'));
        }

        const fallbackSize = response.status === 206 ? null : getMetadataFileSize(metadata);
        const body = prepareFileBody(headers, response.body, fallbackSize);

        return new Response(body, {
            status: response.status,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from Discord - ${error.message}`, { status: 500 });
    }
}


// 澶勭悊 HuggingFace 鏂囦欢璇诲彇
async function handleHuggingFaceFile(context, metadata, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    try {
        const db = getDatabase(env);
        const hfCredentials = await resolveHuggingFaceCredentials(db, env, metadata);
        const hfRepo = hfCredentials.repo;
        const hfFilePath = hfCredentials.filePath;
        const hfToken = hfCredentials.token;
        const hfIsPrivate = hfCredentials.isPrivate || false;

        if (!hfRepo || !hfFilePath) {
            return new Response('Error: HuggingFace file info not found', { status: 500 });
        }

        // 鏋勫缓鏂囦欢 URL
        const fileUrl = `https://huggingface.co/datasets/${hfRepo}/resolve/main/${hfFilePath}`;
        const fileSize = HuggingFaceAPI.getMetadataFileSize(metadata);

        // 澶勭悊 HEAD 璇锋眰
        if (request.method === 'HEAD') {
            const headers = new Headers();
            setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));
            if (fileSize) {
                headers.set('Content-Length', fileSize.toString());
            }
            return handleHeadRequest(headers);
        }

        // 鏋勫缓璇锋眰澶?
        const fetchHeaders = {};

        // 绉佹湁浠撳簱闇€瑕?Authorization
        if (hfIsPrivate && hfToken) {
            fetchHeaders['Authorization'] = `Bearer ${hfToken}`;
        }

        // 鏀寔 Range 璇锋眰
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

        // 鏋勫缓鍝嶅簲澶?
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

        // 澶嶅埗鐩稿叧澶撮儴
        if (response.headers.get('Content-Length')) {
            headers.set('Content-Length', response.headers.get('Content-Length'));
        }
        if (response.headers.get('Content-Range')) {
            headers.set('Content-Range', response.headers.get('Content-Range'));
        }

        const fallbackSize = response.status === 206 ? null : fileSize;
        const body = prepareFileBody(headers, response.body, fallbackSize);

        return new Response(body, {
            status: response.status,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from HuggingFace - ${error.message}`, { status: 500 });
    }
}


// 澶勭悊 WebDAV 鏂囦欢璇诲彇
async function handleWebDAVFile(context, metadata, encodedFileName, fileType) {
    const { request, url, Referer } = context;

    try {
        const db = getDatabase(context.env);
        const webdavCredentials = await resolveWebDAVCredentials(db, context.env, metadata);
        const filePath = webdavCredentials.filePath;
        const publicUrl = getWebDAVPublicFileUrl(webdavCredentials, filePath);

        if (!filePath && !publicUrl) {
            return new Response('Error: WebDAV file info not found', { status: 500 });
        }

        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

        const fetchHeaders = {};
        const range = request.headers.get('Range');
        if (range) {
            fetchHeaders['Range'] = range;
        }

        let response;
        if (publicUrl) {
            response = await fetch(publicUrl, {
                method: request.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: fetchHeaders,
            });

            if (!response.ok && response.status !== 206 && response.status !== 304 && webdavCredentials.baseUrl && filePath) {
                try {
                    const webdavAPI = new WebDAVAPI(webdavCredentials);
                    response = await webdavAPI.getFile(filePath, {
                        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
                        headers: fetchHeaders,
                    });
                } catch (fallbackError) {
                    console.warn('WebDAV public URL fallback failed:', fallbackError.message);
                }
            }
        } else {
            if (!webdavCredentials.baseUrl || !filePath) {
                return new Response('Error: WebDAV channel config not found', { status: 500 });
            }

            const webdavAPI = new WebDAVAPI(webdavCredentials);
            response = await webdavAPI.getFile(filePath, {
                method: request.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: fetchHeaders,
            });
        }

        if (!response.ok && response.status !== 206 && response.status !== 304) {
            return new Response(`Error: Failed to fetch from WebDAV - ${response.status}`, { status: response.status });
        }

        if (response.headers.get('Content-Length')) {
            headers.set('Content-Length', response.headers.get('Content-Length'));
        }
        if (response.headers.get('Content-Range')) {
            headers.set('Content-Range', response.headers.get('Content-Range'));
        }
        if (response.headers.get('ETag')) {
            headers.set('ETag', response.headers.get('ETag'));
        }
        if (response.status === 304) {
            return new Response(null, { status: 304, headers });
        }

        const fallbackSize = response.status === 206 ? null : getMetadataFileSize(metadata);
        const contentLength = resolveResponseLength(headers, fallbackSize);
        if (contentLength !== null) headers.set('Content-Length', contentLength.toString());

        if (request.method === 'HEAD') {
            return handleHeadRequest(headers, response.headers.get('ETag'));
        }

        return new Response(prepareFileBody(headers, response.body, fallbackSize), {
            status: response.status,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from WebDAV - ${error.message}`, { status: 500 });
    }
}

function getWebDAVPublicFileUrl(webdavCredentials, filePath) {
    if (webdavCredentials.publicUrl && filePath) {
        try {
            return buildWebDAVUrl(webdavCredentials.publicUrl, filePath);
        } catch (error) {
            console.warn('Invalid WebDAV public URL config:', error.message);
        }
    }

    return '';
}

// upstream-274-safe-integration: HuggingFace HEAD Content-Length uses metadata.FileSizeBytes when present.
