import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { fetchSecurityConfig } from "../utils/sysConfig.js";
import { createServerErrorResponse } from '../utils/response.js';
import { validateHttpUrl } from '../utils/urlSafety.js';
import { TelegramAPI } from "../utils/telegramAPI.js";
import { DiscordAPI } from "../utils/discordAPI.js";
import { buildWebDAVUrl, WebDAVAPI } from "../utils/storage/webdavAPI.js";
import {
    setCommonHeaders, setRangeHeaders, handleHeadRequest, getFileContent, isTgChannel,
    returnWithCheck, return404, returnBlockImg, isDomainAllowed, FILE_CACHE_CONTROL,
    createFixedLengthBody, resolveResponseLength, parseSingleRange,
    resolveContentType, resolveDispositionIntent, buildUpstreamHeaders
} from './fileTools.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { authenticate, AUTH_SCOPE } from '../utils/auth/authCore.js';
import { validateSession } from '../utils/auth/sessionManager.js';
import { validateApiToken } from '../utils/auth/tokenValidator.js';
import {
    resolveDiscordCredentials,
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveTelegramCredentials,
    resolveWebDAVCredentials,
} from '../utils/metadata/channelCredentials.js';
import { buildCdnFileUrl } from '../utils/metadata/metadataView.js';


export async function onRequest(context) {
    const { request, env, params } = context;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
            status: 405,
            headers: { 'Allow': 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' },
        });
    }

    // 瑙ｇ爜鏂囦欢ID
    let fileId = '';
    try {
        params.path = decodeURIComponent(params.path);
        fileId = params.path.split(',').join('/');
    } catch (e) {
        return new Response('Error: Decode Image ID Failed', { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const url = new URL(request.url);
    context.url = url;

    const Referer = request.headers.get('Referer')
    context.Referer = Referer;

    const db = getDatabase(env);

    // Fetch security config, admin-preview auth and file record in parallel
    // (independent KV round-trips on the hot file-serving path)
    const securityConfigPromise = fetchSecurityConfig(env);
    const [securityConfig, fileAccess, imgRecord] = await Promise.all([
        securityConfigPromise,
        buildFileAccessContext(context, securityConfigPromise),
        db.getWithMetadata(fileId),
    ]);
    context.securityConfig = securityConfig;
    // 若上游已设置 fileAccess（如 /temp/{token} 转发），保留之；否则使用本次构建的结果
    if (!context.fileAccess) {
        context.fileAccess = fileAccess;
    }
    // 转发场景下上游 fileAccess 不含本次请求的 disposition 意图，这里补齐
    if (context.fileAccess.disposition === undefined) {
        context.fileAccess.disposition = fileAccess.disposition;
    }

    // 临时链接访问跳过域名白名单检查（链接本身即是访问凭据）
    if (!context.skipDomainCheck && !isDomainAllowed(context)) {
        const blocked = await returnBlockImg(url);
        return request.method === 'HEAD' ? new Response(null, blocked) : blocked;
    }

    if (!imgRecord || (imgRecord.value === null && imgRecord.metadata === null)) {
        return new Response('Error: Image Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    // 濡傛灉metadata涓嶅瓨鍦紝鍙彲鑳芥槸涔嬪墠鏈缃甂V锛屼笖瀛樺偍鍦═elegraph涓婄殑鍥剧墖
    if (!imgRecord.metadata) {
        imgRecord.metadata = {};
    }

    const fileName = imgRecord.metadata?.FileName || fileId;
    const encodedFileName = encodeURIComponent(fileName).replace(/['()*]/g, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    // 以扩展名为准解析 Content-Type：metadata.FileType 常为 octet-stream/空串，
    // 配合 nosniff 会让 PDF/文本等文件只能下载而无法在线预览。
    const fileType = resolveContentType(fileName, imgRecord.metadata?.FileType, fileId);

    // 妫€鏌ユ枃浠跺彲璁块棶鐘舵€?
    let accessRes = await returnWithCheck(context, imgRecord);
    if (accessRes.status !== 200) {
        return request.method === 'HEAD' ? new Response(null, accessRes) : accessRes;
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
            const checked = validateHttpUrl(String(externalLink), { allowedHosts: env.EXTERNAL_ALLOWED_HOSTS });
            if (!checked.ok) return new Response('Error: Invalid external link', { status: 400, headers: { 'Cache-Control': 'no-store' } });
            return new Response(null, {
                status: 302,
                headers: { 'Location': checked.parsed.toString(), 'Cache-Control': getFileCacheControl(context) || 'no-store' },
            });
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
        // preview/download/disposition 是本服务自己的控制参数，不转发给 telegra.ph
        targetUrl = 'https://telegra.ph/' + url.pathname + buildUpstreamSearch(url);
    }

    try {
        const response = await getFileContent(request, targetUrl);

        if (response === null) {
            return new Response('Error: Failed to fetch image', { status: 500 });
        } else if (response.status === 404) {
            return await return404(url);
        }

        return createUpstreamFileResponse(context, response, encodedFileName, fileType, getMetadataFileSize(imgRecord.metadata));
    } catch (error) {
        return createServerErrorResponse(context.env, error, { pathname: context.url?.pathname });
    }
}

async function buildFileAccessContext(context, securityConfigPromise) {
    const { request, env, url } = context;
    const hasAdminCookie = /(?:^|;)\s*admin_session\s*=/.test(request.headers.get('Cookie') || '');
    const hasAuthorization = Boolean(request.headers.get('Authorization')?.trim());
    const fileAccess = {
        isAdminPreview: !context.fileAccess?.isTempLinkAccess && (hasAdminCookie || hasAuthorization),
        adminAuthResult: { authorized: false, authType: null },
        cacheControl: undefined,
        disposition: resolveDispositionIntent(url),
    };

    if (fileAccess.isAdminPreview) {
        try {
            const session = hasAdminCookie ? await validateSession(env, request, 'admin') : { valid: false };
            if (session.valid) {
                fileAccess.adminAuthResult = { authorized: true, authType: 'admin' };
            } else if (hasAuthorization) {
                const security = await securityConfigPromise;
                const configured = Boolean(security?.auth?.admin?.adminUsername?.trim() || security?.auth?.admin?.adminPassword?.trim());
                if (configured) {
                    fileAccess.adminAuthResult = await authenticate({ env, request, requiredPermission: 'admin', authScope: AUTH_SCOPE.ADMIN });
                } else {
                    // authCore's intentionally open setup mode must not turn an
                    // arbitrary Authorization header into access to blocked files.
                    const token = await validateApiToken(request, getDatabase(env), 'admin');
                    fileAccess.adminAuthResult = { authorized: token.valid, authType: token.valid ? 'admin' : null };
                }
            }
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

// 传给 setCommonHeaders 的附加选项：仅携带 disposition 意图，
// 不传 url —— 避免激活 setCommonHeaders 中基于 Referer 的缓存分支，保持原有缓存行为。
function getFileHeaderOptions(context) {
    return { disposition: context.fileAccess?.disposition || null };
}

// 本服务自有的响应控制参数，不应转发给第三方上游
const LOCAL_ONLY_SEARCH_PARAMS = ['preview', 'download', 'disposition', 'from', 'authCode'];

function buildUpstreamSearch(url) {
    const params = new URLSearchParams(url.search);
    for (const key of LOCAL_ONLY_SEARCH_PARAMS) params.delete(key);
    const search = params.toString();
    return search ? `?${search}` : '';
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

function rangeNotSatisfiable(totalSize, fileHeaders = null) {
    const headers = new Headers(fileHeaders);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes */${totalSize}`);
    headers.set('Content-Length', '0');
    headers.set('Cache-Control', FILE_CACHE_CONTROL.NO_STORE);
    return new Response(null, { status: 416, headers });
}

function isNotModified(request, etag, lastModified = null) {
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch !== null) {
        return ifNoneMatch.split(',').some(value => value.trim() === '*'
            || (etag && value.trim().replace(/^W\//, '') === etag.replace(/^W\//, '')));
    }
    const since = Date.parse(request.headers.get('If-Modified-Since') || '');
    const modified = Date.parse(lastModified || '');
    return Number.isFinite(since) && Number.isFinite(modified) && modified <= since;
}

function matchesIfRange(request, etag, lastModified = null) {
    const ifRange = request.headers.get('If-Range');
    if (!ifRange) return true;
    if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
        return Boolean(etag) && !ifRange.startsWith('W/') && ifRange === etag;
    }
    const date = Date.parse(ifRange);
    const modified = Date.parse(lastModified || '');
    return Number.isFinite(date) && Number.isFinite(modified) && modified <= date;
}

function notModifiedResponse(headers) {
    headers.delete('Content-Length');
    headers.delete('Content-Range');
    return new Response(null, { status: 304, headers });
}

// Preserve the upstream status: an ignored Range is a complete 200, never 206.
function createUpstreamFileResponse(context, response, encodedFileName, fileType, fallbackSize = null) {
    const headers = new Headers();
    for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified', 'Content-Encoding', 'Accept-Ranges', 'Vary']) {
        const value = response.headers.get(name);
        if (value !== null) headers.set(name, value);
    }
    setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context), getFileHeaderOptions(context));
    if (response.headers.get('Accept-Ranges') === 'none') headers.set('Accept-Ranges', 'none');
    if (response.status === 304) return notModifiedResponse(headers);
    if (response.status === 416 || response.status === 412) {
        response.body?.cancel().catch(() => {});
        headers.set('Cache-Control', FILE_CACHE_CONTROL.NO_STORE);
        headers.set('Content-Length', '0');
        return new Response(null, { status: response.status, headers });
    }
    const contentRange = (headers.get('Content-Range') || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    const validRange = contentRange && Number.isSafeInteger(Number(contentRange[1]))
        && Number.isSafeInteger(Number(contentRange[2])) && Number(contentRange[2]) >= Number(contentRange[1])
        && (contentRange[3] === '*' || (Number.isSafeInteger(Number(contentRange[3])) && Number(contentRange[2]) < Number(contentRange[3])));
    if (response.status === 206 && !validRange) {
        response.body?.cancel().catch(() => {});
        return new Response('Error: Invalid upstream partial response', {
            status: 502,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
    if (response.status !== 206) headers.delete('Content-Range');
    const size = response.status === 206 || !response.ok ? null : fallbackSize;
    if (!response.ok) headers.set('Cache-Control', FILE_CACHE_CONTROL.NO_STORE);
    if (context.request.method === 'HEAD') {
        response.body?.cancel().catch(() => {});
        const length = resolveResponseLength(headers, size);
        if (length !== null) headers.set('Content-Length', String(length));
        return new Response(null, { status: response.status, headers });
    }
    return new Response(prepareFileBody(headers, response.body, size), {
        status: response.status,
        headers,
    });
}

// Read only one bounded chunk per pull; slow/cancelled clients must not queue
// the entire reconstructed file in Worker memory.
function createChunkedBody(chunks, rangeStart, rangeEnd, fetchChunk) {
    let index = 0;
    let position = 0;
    let cancelled = false;
    return new ReadableStream({
        async pull(controller) {
            while (index < chunks.length) {
                const chunk = chunks[index++];
                const start = position;
                position += chunk.size;
                if (position <= rangeStart) continue;
                if (start > rangeEnd) break;
                const bytes = await fetchChunk(chunk);
                if (cancelled) return;
                if (!bytes) throw new Error(`Failed to fetch chunk ${chunk.index} after retries`);
                controller.enqueue(bytes.subarray(Math.max(0, rangeStart - start), Math.min(chunk.size, rangeEnd - start + 1)));
                if (position > rangeEnd || index === chunks.length) controller.close();
                return;
            }
            controller.close();
        },
        cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
}

function normalizeChunkList(chunks) {
    let totalSize = 0;
    const normalizedChunks = [];

    for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        const size = Number(chunk?.size);
        if (Number(chunk?.index) !== index || !Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024) return null;
        totalSize += size;
        if (!Number.isSafeInteger(totalSize)) return null;
        normalizedChunks.push({ ...chunk, size });
    }

    return { chunks: normalizedChunks, totalSize };
}

// Telegram/Discord chunks are at most 25 MiB. Never arrayBuffer() an unbounded
// upstream response before checking its size; that can exceed Worker memory.
async function readChunkBytes(response, expectedSize) {
    const length = response.headers.get('Content-Length');
    if (length !== null && Number(length) !== expectedSize) {
        response.body?.cancel().catch(() => {});
        throw new Error(`size mismatch: expected ${expectedSize}, got ${length}`);
    }
    if (!response.body) throw new Error('Missing upstream chunk body');
    const bytes = new Uint8Array(expectedSize);
    const reader = response.body.getReader();
    let offset = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.byteLength > expectedSize) {
                await reader.cancel();
                throw new Error(`size mismatch: upstream chunk exceeds ${expectedSize} bytes`);
            }
            bytes.set(value, offset);
            offset += value.byteLength;
        }
        if (offset !== expectedSize) throw new Error(`size mismatch: expected ${expectedSize}, got ${offset}`);
        return bytes;
    } finally {
        reader.releaseLock();
    }
}


// 澶勭悊 Telegram 娓犻亾鍒嗙墖鏂囦欢璇诲彇
async function handleTelegramChunkedFile(context, imgRecord, encodedFileName, fileType) {
    const db = getDatabase(context.env);
    const credentials = await resolveTelegramCredentials(db, context.env, imgRecord.metadata);
    return serveChunkedFile(context, imgRecord, encodedFileName, fileType, chunk => {
        // Historical file_ids are bot-scoped; retain each chunk's original bot.
        const botToken = chunk.tgBotToken || credentials.botToken;
        const proxyUrl = typeof chunk.tgProxyUrl === 'string' ? chunk.tgProxyUrl : (credentials.proxyUrl || '');
        return fetchTelegramChunkWithRetry(botToken, chunk, proxyUrl, 3);
    });
}

async function serveChunkedFile(context, imgRecord, encodedFileName, fileType, fetchChunk) {
    const { request } = context;
    const metadata = imgRecord.metadata;
    let chunks;
    try {
        chunks = JSON.parse(imgRecord.value || '[]');
        if (!Array.isArray(chunks)) throw new Error('Invalid chunk manifest');
        chunks.sort((a, b) => a.index - b.index);
    } catch {
        return new Response('Error: Invalid chunks data', { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
    const expectedChunks = Number(metadata.TotalChunks || chunks.length);
    if (!chunks.length || !Number.isSafeInteger(expectedChunks) || chunks.length !== expectedChunks) {
        return new Response('Error: Missing chunks', { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
    const normalized = normalizeChunkList(chunks);
    if (!normalized || normalized.totalSize <= 0) {
        return new Response('Error: Invalid chunk sizes', { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
    chunks = normalized.chunks;
    const totalSize = normalized.totalSize;
    const headers = new Headers();
    setCommonHeaders(headers, encodedFileName, fileType, getChunkedFileCacheControl(context), getFileHeaderOptions(context));
    headers.set('Content-Length', String(totalSize));
    let etag;
    const timestamp = Number(metadata.TimeStamp);
    if (Number.isSafeInteger(timestamp) && timestamp > 0) {
        etag = '"' + timestamp + '-' + totalSize + '"';
    } else {
        const manifest = chunks.map(chunk => [chunk.index, chunk.fileId || chunk.messageId, chunk.size].join(':')).join('|');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifest));
        etag = '"' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') + '"';
    }
    headers.set('ETag', etag);
    const modified = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toUTCString() : null;
    if (modified && modified !== 'Invalid Date') headers.set('Last-Modified', modified);
    const precondition = filePreconditionResponse(request, headers);
    if (precondition) return precondition;
    // RFC 9110: Range applies to GET, not HEAD.
    if (request.method === 'HEAD') return handleHeadRequest(headers, etag);
    const range = matchesIfRange(request, etag, modified) ? request.headers.get('Range') : null;
    let rangeStart = 0;
    let rangeEnd = totalSize - 1;
    if (range) {
        const parsed = parseSingleRange(range, totalSize);
        if (!parsed) return rangeNotSatisfiable(totalSize, headers);
        rangeStart = parsed.start;
        rangeEnd = parsed.end;
        setRangeHeaders(headers, rangeStart, rangeEnd, totalSize);
    }
    const stream = createChunkedBody(chunks, rangeStart, rangeEnd, fetchChunk);
    return new Response(prepareFileBody(headers, stream), { status: range ? 206 : 200, headers });
}

async function fetchTelegramChunkWithRetry(botToken, chunk, proxyUrl = '', maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const tgApi = new TelegramAPI(botToken, proxyUrl);

            const response = await tgApi.getFileContent(chunk.fileId);

            if (!response.ok) {
                response.body?.cancel().catch(() => {});
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await readChunkBytes(response, chunk.size);

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
    const db = getDatabase(context.env);
    const credentials = await resolveDiscordCredentials(db, context.env, imgRecord.metadata);
    return serveChunkedFile(context, imgRecord, encodedFileName, fileType, chunk =>
        fetchDiscordChunkWithRetry(credentials.botToken, credentials.channelId, chunk, credentials.proxyUrl, 3));
}

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
                response.body?.cancel().catch(() => {});
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await readChunkBytes(response, chunk.size);

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
function buildR2Headers(context, object, encodedFileName, fileType) {
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context), getFileHeaderOptions(context));
    headers.set('Content-Length', String(object.size));
    const etag = object.httpEtag || (object.etag ? '"' + object.etag + '"' : null);
    if (etag) headers.set('ETag', etag);
    if (object.uploaded) {
        const modified = new Date(object.uploaded).toUTCString();
        if (modified !== 'Invalid Date') headers.set('Last-Modified', modified);
    }
    return headers;
}

function cancelUnusedBody(object) {
    object?.body?.cancel().catch(() => {});
}

function filePreconditionResponse(request, headers) {
    const etag = headers.get('ETag');
    const ifMatch = request.headers.get('If-Match');
    const ifUnmodifiedSince = Date.parse(request.headers.get('If-Unmodified-Since') || '');
    const modified = Date.parse(headers.get('Last-Modified') || '');
    const failedMatch = ifMatch !== null && !ifMatch.split(',').some(value => value.trim() === '*'
        || (etag && !value.trim().startsWith('W/') && value.trim() === etag));
    const failedDate = ifMatch === null && Number.isFinite(ifUnmodifiedSince)
        && Number.isFinite(modified) && modified > ifUnmodifiedSince;
    if (failedMatch || failedDate) {
        headers.set('Content-Length', '0');
        headers.set('Cache-Control', FILE_CACHE_CONTROL.NO_STORE);
        return new Response(null, { status: 412, headers });
    }
    if (isNotModified(request, etag, headers.get('Last-Modified'))) return notModifiedResponse(headers);
    return null;
}

async function handleR2File(context, fileId, encodedFileName, fileType) {
    const { env, request } = context;
    try {
        const bucket = env.img_r2;
        if (!bucket) return new Response('Error: Please configure R2 database', { status: 500, headers: { 'Cache-Control': 'no-store' } });
        const requestedRange = request.method === 'GET' ? request.headers.get('Range') : null;
        const hasConditions = ['If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'].some(name => request.headers.has(name));
        const needsMetadata = request.method === 'HEAD' || requestedRange || hasConditions;
        // HEAD must not open a large object stream. The fallback supports legacy
        // adapters without head(); its unused stream is explicitly cancelled.
        let object = needsMetadata && typeof bucket.head === 'function'
            ? await bucket.head(fileId) : await bucket.get(fileId);
        if (!object) return new Response('Error: File Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        let headers = buildR2Headers(context, object, encodedFileName, fileType);
        const precondition = filePreconditionResponse(request, headers);
        if (precondition) { cancelUnusedBody(object); return precondition; }
        if (request.method === 'HEAD') { cancelUnusedBody(object); return handleHeadRequest(headers); }
        const range = requestedRange && matchesIfRange(request, headers.get('ETag'), headers.get('Last-Modified'))
            ? parseSingleRange(requestedRange, object.size) : null;
        if (requestedRange && matchesIfRange(request, headers.get('ETag'), headers.get('Last-Modified')) && !range) {
            cancelUnusedBody(object);
            return rangeNotSatisfiable(object.size, headers);
        }
        let partial = Boolean(range);
        if (partial) {
            cancelUnusedBody(object);
            const options = { range: { offset: range.start, length: range.length } };
            // Prevent an overwrite between head() and get() from mixing versions.
            if (object.etag) options.onlyIf = { etagMatches: object.etag };
            object = await bucket.get(fileId, options);
            if (object && (!('body' in object) || !object.range)) {
                cancelUnusedBody(object);
                object = await bucket.get(fileId);
                partial = false;
            }
        } else if (!('body' in object)) {
            object = await bucket.get(fileId);
        }
        if (!object) return new Response('Error: File Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        headers = buildR2Headers(context, object, encodedFileName, fileType);
        const changedPrecondition = filePreconditionResponse(request, headers);
        if (changedPrecondition) { cancelUnusedBody(object); return changedPrecondition; }
        if (partial) {
            setRangeHeaders(headers, object.range.offset, object.range.offset + object.range.length - 1, object.size);
        }
        return new Response(prepareFileBody(headers, object.body), { status: partial ? 206 : 200, headers });
    } catch (error) {
        return createServerErrorResponse(context.env, error, { pathname: context.url?.pathname });
    }
}

async function handleS3File(context, metadata, encodedFileName, fileType) {
    const cdnFileUrl = await getS3CdnFileUrl(context.env, metadata);
    if (cdnFileUrl) {
        try {
            const response = await fetch(cdnFileUrl, {
                method: context.request.method,
                headers: buildUpstreamHeaders(context.request),
            });
            if (response.ok || [304, 412, 416].includes(response.status)) {
                return createUpstreamFileResponse(context, response, encodedFileName, fileType, getMetadataFileSize(metadata));
            }
            response.body?.cancel().catch(() => {});
            console.warn('S3 CDN fetch failed; falling back to S3 API:', response.status);
        } catch {
            console.warn('S3 CDN fetch failed; falling back to S3 API');
        }
    }
    return handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
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
    const { request, env } = context;
    try {
        const db = getDatabase(env);
        const credentials = await resolveS3Credentials(db, env, metadata);
        const client = new S3Client({
            region: credentials.region || 'auto',
            endpoint: credentials.endpoint,
            credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
            forcePathStyle: credentials.pathStyle || false,
        });
        const params = { Bucket: credentials.bucketName, Key: credentials.key };
        const range = request.method === 'GET' ? request.headers.get('Range') : null;
        if (range) {
            if (request.headers.has('If-Range')) {
                const head = await client.send(new HeadObjectCommand(params));
                if (matchesIfRange(request, head.ETag, head.LastModified?.toUTCString())) params.Range = range;
            } else {
                params.Range = range;
            }
        }
        for (const [header, field] of [['If-Match', 'IfMatch'], ['If-None-Match', 'IfNoneMatch']]) {
            const value = request.headers.get(header);
            if (value) params[field] = value;
        }
        for (const [header, field] of [['If-Modified-Since', 'IfModifiedSince'], ['If-Unmodified-Since', 'IfUnmodifiedSince']]) {
            const value = Date.parse(request.headers.get(header) || '');
            if (Number.isFinite(value)) params[field] = new Date(value);
        }
        const Command = request.method === 'HEAD' ? HeadObjectCommand : GetObjectCommand;
        const object = await client.send(new Command(params));
        const headers = new Headers();
        if (object.ContentLength !== undefined && object.ContentLength !== null) headers.set('Content-Length', String(object.ContentLength));
        if (object.ContentRange) headers.set('Content-Range', object.ContentRange);
        if (object.ETag) headers.set('ETag', object.ETag);
        if (object.LastModified) headers.set('Last-Modified', object.LastModified.toUTCString());
        let body = request.method === 'HEAD' ? null : object.Body;
        if (body?.transformToWebStream) body = body.transformToWebStream();
        const response = new Response(body, { status: object.ContentRange ? 206 : 200, headers });
        return createUpstreamFileResponse(context, response, encodedFileName, fileType, getMetadataFileSize(metadata));
    } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context), getFileHeaderOptions(context));
        if (status === 304) return notModifiedResponse(headers);
        if (status === 416) {
            const size = getMetadataFileSize(metadata);
            if (size !== null) return rangeNotSatisfiable(size, headers);
        }
        if ([404, 412, 416].includes(status)) {
            headers.set('Cache-Control', FILE_CACHE_CONTROL.NO_STORE);
            headers.set('Content-Length', '0');
            return new Response(null, { status, headers });
        }
        return createServerErrorResponse(context.env, error, { pathname: context.url?.pathname });
    }
}

async function handleDiscordFile(context, metadata, encodedFileName, fileType) {
    try {
        const db = getDatabase(context.env);
        const credentials = await resolveDiscordCredentials(db, context.env, metadata);
        let fileUrl = null;
        if (credentials.messageId && credentials.channelId && credentials.botToken) {
            const api = new DiscordAPI(credentials.botToken);
            fileUrl = await api.getFileURL(credentials.channelId, credentials.messageId);
        }
        if (!fileUrl) return new Response('Error: Discord file URL not found', { status: 502, headers: { 'Cache-Control': 'no-store' } });
        if (credentials.proxyUrl) fileUrl = fileUrl.replace('https://cdn.discordapp.com', 'https://' + credentials.proxyUrl);
        const response = await fetch(fileUrl, { method: context.request.method, headers: buildUpstreamHeaders(context.request) });
        if (!response.ok && ![304, 412, 416].includes(response.status)) {
            response.body?.cancel().catch(() => {});
            return new Response('Error: Failed to fetch from Discord', { status: response.status, headers: { 'Cache-Control': 'no-store' } });
        }
        return createUpstreamFileResponse(context, response, encodedFileName, fileType, getMetadataFileSize(metadata));
    } catch (error) {
        return createServerErrorResponse(context.env, error, { pathname: context.url?.pathname });
    }
}

async function handleHuggingFaceFile(context, metadata, encodedFileName, fileType) {
    try {
        const db = getDatabase(context.env);
        const credentials = await resolveHuggingFaceCredentials(db, context.env, metadata);
        if (!credentials.repo || !credentials.filePath) {
            return new Response('Error: HuggingFace file info not found', { status: 500, headers: { 'Cache-Control': 'no-store' } });
        }
        const fileUrl = 'https://huggingface.co/datasets/' + credentials.repo + '/resolve/main/' + credentials.filePath;
        const headers = buildUpstreamHeaders(context.request);
        if (credentials.isPrivate && credentials.token) headers.set('Authorization', 'Bearer ' + credentials.token);
        const response = await fetchHuggingFaceContent(fileUrl, { method: context.request.method, headers });
        if (!response.ok && ![304, 412, 416].includes(response.status)) {
            response.body?.cancel().catch(() => {});
            return new Response('Error: Failed to fetch from HuggingFace', { status: response.status, headers: { 'Cache-Control': 'no-store' } });
        }
        return createUpstreamFileResponse(context, response, encodedFileName, fileType, getMetadataFileSize(metadata));
    } catch (error) {
        return createServerErrorResponse(context.env, error, { pathname: context.url?.pathname });
    }
}

async function fetchHuggingFaceContent(fileUrl, { method, headers }, maxRedirects = 5) {
    const failure = () => new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    let checked = validateHttpUrl(fileUrl);
    if (!checked.ok || checked.parsed.protocol !== 'https:') return failure();
    let current = checked.parsed;
    const forwarded = new Headers(headers);
    for (let hop = 0; hop <= maxRedirects; hop++) {
        // Workers may forward credentials on automatic cross-origin redirects.
        // Follow explicitly so private Hub tokens never reach its storage CDN.
        const response = await fetch(current.toString(), { method, headers: new Headers(forwarded), redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('Location');
        await response.body?.cancel().catch(() => {});
        if (!location || hop === maxRedirects) return failure();
        let nextUrl;
        try { nextUrl = new URL(location, current).toString(); }
        catch { return failure(); }
        checked = validateHttpUrl(nextUrl);
        if (!checked.ok || checked.parsed.protocol !== 'https:') return failure();
        if (checked.parsed.origin !== current.origin) {
            for (const name of ['Authorization', 'Cookie', 'Proxy-Authorization']) forwarded.delete(name);
        }
        current = checked.parsed;
    }
    return failure();
}

async function handleWebDAVFile(context, metadata, encodedFileName, fileType) {
    const { request } = context;
    try {
        const db = getDatabase(context.env);
        const credentials = await resolveWebDAVCredentials(db, context.env, metadata);
        const filePath = credentials.filePath;
        const publicUrl = getWebDAVPublicFileUrl(credentials, filePath);
        const options = { method: request.method, headers: Object.fromEntries(buildUpstreamHeaders(request)) };
        let response;
        if (publicUrl) {
            response = await fetch(publicUrl, options);
            if (!response.ok && ![304, 412, 416].includes(response.status) && credentials.baseUrl && filePath) {
                response.body?.cancel().catch(() => {});
                response = await new WebDAVAPI(credentials).getFile(filePath, options);
            }
        } else {
            if (!credentials.baseUrl || !filePath) {
                return new Response('Error: WebDAV channel config not found', { status: 500, headers: { 'Cache-Control': 'no-store' } });
            }
            response = await new WebDAVAPI(credentials).getFile(filePath, options);
        }
        if (!response.ok && ![304, 412, 416].includes(response.status)) {
            response.body?.cancel().catch(() => {});
            return new Response('Error: Failed to fetch from WebDAV', { status: response.status, headers: { 'Cache-Control': 'no-store' } });
        }
        return createUpstreamFileResponse(context, response, encodedFileName, fileType, getMetadataFileSize(metadata));
    } catch (error) {
        return createServerErrorResponse(context.env, error, { pathname: context.url?.pathname });
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
