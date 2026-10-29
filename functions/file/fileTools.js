import { normalizeMime } from '../utils/fileTypes.js';
export { resolveContentType } from '../utils/fileTypes.js';

/* ======== 文件读取工具函数 ======== */

/**
 * 使用 FixedLengthStream 包装响应体，确保 Cloudflare Workers 保留 Content-Length 头。
 * 当 new Response(readableStream, ...) 时，CF Workers 会剥离 Content-Length 并使用 chunked 传输，
 * 这导致 IDM 等下载工具无法获取文件大小。FixedLengthStream 声明了流的确切长度，使 CF 保留该头。
 *
 * @param {ReadableStream} body - 原始响应体
 * @param {number} contentLength - 已知的内容长度（字节）
 * @returns {ReadableStream} 包装后的固定长度流
 */
export function createFixedLengthBody(body, contentLength) {
    if (!body || !Number.isSafeInteger(contentLength) || contentLength < 0) {
        return body;
    }

    const { readable, writable } = new FixedLengthStream(contentLength);
    body.pipeTo(writable).catch(() => {});
    return readable;
}

/**
 * Resolve the exact byte length represented by a response.
 * Content-Range takes precedence because metadata sizes describe the whole file,
 * while a 206 response only contains the requested segment.
 */
export function resolveResponseLength(headers, fallbackSize = null) {
    const contentRange = headers.get('Content-Range');
    const rangeMatch = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i);
    if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) {
            return end - start + 1;
        }
    }

    const headerValue = headers.get('Content-Length');
    if (headerValue !== null && headerValue.trim() !== '') {
        const headerLength = Number(headerValue);
        if (Number.isSafeInteger(headerLength) && headerLength >= 0) {
            return headerLength;
        }
    }

    if (fallbackSize !== null && fallbackSize !== undefined && fallbackSize !== '') {
        const fallbackLength = Number(fallbackSize);
        if (Number.isSafeInteger(fallbackLength) && fallbackLength >= 0) {
            return fallbackLength;
        }
    }

    return null;
}

/**
 * Parse one RFC 9110 byte range. Multi-range requests are intentionally
 * rejected because the file endpoint does not produce multipart/byteranges.
 */
export function parseSingleRange(rangeHeader, totalSize) {
    if (!rangeHeader || !Number.isSafeInteger(totalSize) || totalSize <= 0) {
        return null;
    }

    const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
    if (!match || (!match[1] && !match[2])) {
        return null;
    }

    let start;
    let end;

    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            return null;
        }
        start = Math.max(totalSize - suffixLength, 0);
        end = totalSize - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : totalSize - 1;

        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
            return null;
        }
        if (start >= totalSize || start > end) {
            return null;
        }
        end = Math.min(end, totalSize - 1);
    }

    return {
        start,
        end,
        length: end - start + 1,
    };
}

export function decodeFilePathParam(path) {
    return decodeURIComponent(path).split(',').join('/');
}

// 域名正则表达式缓存（模块生命周期内有效）
let _domainRegexCache = null;
let _domainRegexCacheKey = null;

export const FILE_CACHE_CONTROL = {
    PUBLIC: 'public, max-age=300, s-maxage=3600',
    PRIVATE: 'private, max-age=300',
    NO_STORE: 'private, no-store, max-age=0',
};

// 判断请求域名是否在允许的域名列表中
export function isDomainAllowed(context) {
    const { Referer, securityConfig, url } = context;

    const allowedDomains = securityConfig.access.allowedDomains;

    if (Referer) {
        try {
            const refererUrl = new URL(Referer);
            if (allowedDomains && allowedDomains.trim() !== '') {
                // 构建缓存键（包含 hostname 以匹配自身域名）
                const cacheKey = allowedDomains + '|' + url.hostname;
                if (_domainRegexCacheKey !== cacheKey) {
                    const domains = allowedDomains.split(',');
                    domains.push(url.hostname); // 把自身域名加入白名单
                    _domainRegexCache = domains.map(domain =>
                        new RegExp(`(^|\\.)${domain.trim().replace(/\./g, '\\.')}$`)
                    );
                    _domainRegexCacheKey = cacheKey;
                }

                const isAllowed = _domainRegexCache.some(re => re.test(refererUrl.hostname));
                if (!isAllowed) {
                    return false;
                }
            }
        } catch (e) {
            return false;
        }
    }

    return true;
}

// 判断请求是否来自公开图库页面 (/browse 或 /browse/*)
export function isFromPublicBrowse(Referer, origin) {
    if (!Referer) return false;
    try {
        const refererUrl = new URL(Referer);
        // 检查是否来自同源的 /browse 或 /browse/* 路径
        if (refererUrl.origin === origin) {
            const pathname = refererUrl.pathname;
            if (pathname === '/browse' || pathname.startsWith('/browse/')) {
                return true;
            }
        }
    } catch (e) {
        return false;
    }
    return false;
}

// 严格的同源判断：必须解析 Referer 的 origin 后与本站 origin 精确相等。
// 不能用 referer.includes(origin)——https://evil.com/?x=https://mysite.com 会被误判为同源，
// 从而绕过黑名单/成人内容访问控制。
export function isSameOrigin(referer, origin) {
    if (!referer || !origin) return false;
    try {
        return new URL(referer).origin === origin;
    } catch (e) {
        return false;
    }
}

// 页面型活跃内容：直接以文档形式渲染即可执行脚本，必须强制下载（attachment）。
const FORCE_DOWNLOAD_TYPES = new Set([
    'text/html', 'application/xhtml+xml',
    'application/javascript', 'text/javascript', 'application/x-javascript',
    'text/ecmascript', 'application/ecmascript',
    'text/css',
]);

/**
 * 解析请求中显式的 Content-Disposition 意图。
 *
 * 除了让"预览/下载"两种用途可以各自拿到正确的 disposition，带上参数还顺带
 * 换掉了缓存键：老链接此前可能已被浏览器/CDN 以 max-age=2592000 缓存成
 * octet-stream + 下载，只改后端不换 URL 的话用户看到的仍是下载。
 *
 * 支持 ?disposition=inline|attachment、?preview[=1]、?download[=1]
 * @returns {'inline'|'attachment'|null}
 */
export function resolveDispositionIntent(url) {
    const params = url?.searchParams;
    if (!params) return null;

    const explicit = (params.get('disposition') || '').trim().toLowerCase();
    if (explicit === 'inline' || explicit === 'attachment') return explicit;

    if (isEnabledFlag(params.get('download'))) return 'attachment';
    if (isEnabledFlag(params.get('preview'))) return 'inline';

    return null;
}

function isEnabledFlag(value) {
    if (value === null || value === undefined) return false;
    const flag = String(value).trim().toLowerCase();
    return flag === '' || flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

// 可内联但需沙箱化的活跃内容：SVG/XML 直接导航时可能执行脚本，
// 保留 inline 展示（图标/图片场景），用 CSP sandbox + script-src 'none' 中和脚本。
const SANDBOX_INLINE_TYPES = new Set([
    'image/svg+xml', 'text/xml', 'application/xml', 'text/xsl',
]);

// 判断是否为压缩包文件 — 使用 Set O(1) 查找替代多次 includes()
const ARCHIVE_TYPES = new Set([
    'zip', 'rar', '7z', 'tar', 'gzip',
    'application/x-compressed', 'application/x-zip-compressed',
    'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed'
]);

function isArchiveType(fileType) {
    if (!fileType) return false;
    // 先尝试精确匹配
    if (ARCHIVE_TYPES.has(fileType)) return true;
    // 再检查子串匹配（兼容 "application/zip; charset=..." 等）
    for (const t of ARCHIVE_TYPES) {
        if (fileType.includes(t)) return true;
    }
    return false;
}

// 公共响应头设置函数
// options: { disposition?: 'inline'|'attachment', url?: URL }
//   为兼容历史签名（第 5 个参数曾是 URL 对象），也接受直接传入 URL。
export function setCommonHeaders(headers, encodedFileName, fileType, RefererOrCacheControl = FILE_CACHE_CONTROL.PUBLIC, options = null) {
    const { url, disposition } = normalizeHeaderOptions(options);
    const mime = normalizeMime(fileType);
    // 页面型活跃内容：无论请求怎么要求都必须 attachment，否则可造成存储型 XSS
    const isActiveContent = FORCE_DOWNLOAD_TYPES.has(mime);
    // 压缩包同样默认强制下载；SVG/XML 保留 inline 但下方加沙箱 CSP
    const forceDownload = isActiveContent || isArchiveType(fileType);

    let dispositionType = forceDownload ? 'attachment' : 'inline';
    if (disposition && !isActiveContent) {
        // 显式意图（?preview / ?download / ?disposition=）优先于默认推断
        dispositionType = disposition;
    }
    headers.set('Content-Disposition', `${dispositionType}; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`);
    // 禁止 MIME 嗅探，防止被当作可执行内容
    headers.set('X-Content-Type-Options', 'nosniff');
    // 对可内联的活跃内容加沙箱 CSP，直接导航时中和脚本执行（不影响 <img> 嵌入展示）
    if (SANDBOX_INLINE_TYPES.has(mime) || mime.endsWith('+xml') || mime.endsWith('/xml')) {
        headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag, Last-Modified');
    headers.set('Accept-Ranges', 'bytes');
    const vary = headers.get('Vary');
    if (vary !== '*' && !vary?.split(',').some(value => value.trim().toLowerCase() === 'range')) {
        headers.set('Vary', vary ? `${vary}, Range` : 'Range');
    }

    if (fileType) {
        headers.set('Content-Type', fileType);
    }

    const knownCacheControls = Object.values(FILE_CACHE_CONTROL);
    if (knownCacheControls.includes(RefererOrCacheControl)) {
        headers.set('Cache-Control', RefererOrCacheControl);
        return;
    }

    const Referer = RefererOrCacheControl;
    if (Referer && url?.origin && isSameOrigin(Referer, url.origin) && !isFromPublicBrowse(Referer, url.origin)) {
        headers.set('Cache-Control', FILE_CACHE_CONTROL.PRIVATE);
    } else {
        headers.set('Cache-Control', FILE_CACHE_CONTROL.PUBLIC);
    }
}

function normalizeHeaderOptions(options) {
    if (!options) return { url: null, disposition: null };
    // 历史签名兼容：第 5 个参数是 URL 实例时按 url 处理
    if (typeof options.origin === 'string' && !('disposition' in options)) {
        return { url: options, disposition: null };
    }
    return { url: options.url || null, disposition: options.disposition || null };
}


// 设置Range请求相关头部
export function setRangeHeaders(headers, rangeStart, rangeEnd, totalSize) {
    const contentLength = rangeEnd - rangeStart + 1;
    headers.set('Content-Length', contentLength.toString());
    headers.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
}

// 处理HEAD请求的公共函数
// 优化：直接复用传入的 headers，避免逐 key 创建新 Headers 对象
export function handleHeadRequest(headers, etag = null) {
    if (etag) {
        headers.set('ETag', etag);
    }
    // Do not invent a zero length for legacy records whose size is unknown.
    // A false zero makes download managers treat a non-empty file as empty.
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');

    return new Response(null, {
        status: 200,
        headers,
    });
}

// 转发到第三方上游（Telegram/Telegraph/Discord 等）时，仅保留必要的条件/范围请求头，
// 绝不透传 Cookie、Authorization、authCode 等凭据，防止泄露给第三方。
const FORWARDABLE_UPSTREAM_HEADERS = ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'accept'];

export function buildUpstreamHeaders(request) {
    // Identity encoding keeps Range and Content-Length in original file bytes.
    const headers = new Headers({ 'Accept-Encoding': 'identity' });
    for (const name of FORWARDABLE_UPSTREAM_HEADERS) {
        if (request.method === 'HEAD' && (name === 'range' || name === 'if-range')) continue;
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }
    return headers;
}

// 优化：使用指数退避重试，避免连续立即重试打满上游服务
export async function getFileContent(request, targetUrl, max_retries = 2) {
    let retries = 0;
    const upstreamHeaders = buildUpstreamHeaders(request);
    // 仅对可带 body 的方法转发 body（GET/HEAD 不允许 body）
    const forwardBody = request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined;
    while (retries <= max_retries) {
        try {
            const response = await fetch(targetUrl, {
                method: request.method,
                headers: upstreamHeaders,
                body: forwardBody,
            });
            if (response.ok || response.status === 304 || response.status === 412 || response.status === 416) {
                return response;
            } else if (response.status === 404) {
                return new Response('Error: Image Not Found', { status: 404 });
            } else {
                retries++;
                if (retries <= max_retries) {
                    await new Promise(r => setTimeout(r, 300 * retries)); // 300ms, 600ms 指数退避
                }
            }
        } catch (error) {
            retries++;
            if (retries <= max_retries) {
                await new Promise(r => setTimeout(r, 300 * retries));
            }
        }
    }
    return null;
}

export function isTgChannel(imgRecord) {
    return imgRecord.metadata?.Channel === 'Telegram' || imgRecord.metadata?.Channel === 'TelegramNew';
}

// 图片可访问性检查
export async function returnWithCheck(context, imgRecord) {
    const { url, securityConfig } = context;
    const whiteListMode = securityConfig.access.whiteListMode;
    // ?from=admin 的预览必须通过管理端鉴权；不再信任可伪造的 Referer 头
    const isAdminPreview = context.fileAccess?.isAdminPreview === true;
    const adminAuthorized = context.fileAccess?.adminAuthResult?.authorized === true;
    // 临时链接访问：通过 /temp/{token} 转发而来，绕过 block/white/白名单模式检查
    const isTempLinkAccess = context.fileAccess?.isTempLinkAccess === true;

    const response = new Response('success', { status: 200 });

    // Referer is a caller-controlled header, never an administrator credential.
    // Unauthenticated admin links fall back to ordinary file access rules.
    const adminPreviewEffective = isAdminPreview && adminAuthorized;

    const record = imgRecord;
    if (record.metadata === null) {
        if (context.fileAccess) {
            context.fileAccess.cacheControl = (adminPreviewEffective || isTempLinkAccess)
                ? FILE_CACHE_CONTROL.NO_STORE : FILE_CACHE_CONTROL.PUBLIC;
        }
        return response;
    }

    // Access-controlled responses must be checked again after logout/revocation.
    if (adminPreviewEffective) {
        if (context.fileAccess) {
            context.fileAccess.cacheControl = FILE_CACHE_CONTROL.NO_STORE;
        }
        return response;
    }

    // A temporary token must not outlive its expiry in a browser or edge cache.
    if (isTempLinkAccess) {
        if (context.fileAccess) {
            context.fileAccess.cacheControl = FILE_CACHE_CONTROL.NO_STORE;
        }
        return response;
    }

    if (context.fileAccess) {
        context.fileAccess.cacheControl = FILE_CACHE_CONTROL.PUBLIC;
    }

    if (record.metadata.ListType == "White") {
        return response;
    } else if (record.metadata.ListType == "Block") {
        return await returnBlockImg(url);
    } else if (record.metadata.Label == "adult") {
        return await returnBlockImg(url);
    }

    if (whiteListMode) {
        return await returnWhiteListImg(url);
    }

    return response;
}

// 优化：使用 Cache API 缓存静态图片，避免每次都产生回环请求
// Workers fetch(url.origin + "/static/...") 会产生 Workers -> CDN -> Workers 的回环
// 缓存后只有首次请求产生回环，后续请求直接从 edge cache 读取
async function fetchStaticWithCache(url, staticPath) {
    const staticUrl = url.origin + staticPath;
    const cache = caches.default;

    // 尝试从缓存读取
    const cached = await cache.match(staticUrl);
    if (cached) return cached.clone();

    // 缓存未命中，发起请求
    const response = await fetch(staticUrl);
    if (response.ok) {
        // 克隆后写入缓存（长期缓存，静态图片不会变）
        const cacheResponse = new Response(response.clone().body, {
            headers: {
                ...Object.fromEntries(response.headers),
                'Cache-Control': 'public, max-age=604800', // 7天
            },
        });
        // 不 await，后台写入
        cache.put(staticUrl, cacheResponse).catch(() => {});
    }
    return response;
}

export async function return404(url) {
    const Img404 = await fetchStaticWithCache(url, "/static/404.png");
    if (!Img404.ok) {
        return new Response('Error: Image Not Found',
            {
                status: 404,
                headers: {
                    "Cache-Control": "public, max-age=86400"
                }
            }
        );
    } else {
        return new Response(Img404.body, {
            status: 404,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=86400",
            },
        });
    }
}

export async function returnBlockImg(url) {
    const blockImg = await fetchStaticWithCache(url, "/static/BlockImg.png");
    if (!blockImg.ok) {
        return new Response(null, {
            status: 302,
            headers: {
                "Location": url.origin + "/blockimg",
                "Cache-Control": FILE_CACHE_CONTROL.NO_STORE
            }
        })
    } else {
        return new Response(blockImg.body, {
            status: 403,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": FILE_CACHE_CONTROL.NO_STORE,
            },
        });
    }
}

export async function returnWhiteListImg(url) {
    const WhiteListImg = await fetchStaticWithCache(url, "/static/WhiteListOn.png");
    if (!WhiteListImg.ok) {
        return new Response(null, {
            status: 302,
            headers: {
                "Location": url.origin + "/whiteliston",
                "Cache-Control": FILE_CACHE_CONTROL.NO_STORE
            }
        })
    } else {
        return new Response(WhiteListImg.body, {
            status: 403,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": FILE_CACHE_CONTROL.NO_STORE,
            },
        });
    }
}
