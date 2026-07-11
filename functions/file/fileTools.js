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
    const { readable, writable } = new FixedLengthStream(contentLength);
    body.pipeTo(writable).catch(() => {});
    return readable;
}

export function decodeFilePathParam(path) {
    return decodeURIComponent(path).split(',').join('/');
}

// 域名正则表达式缓存（模块生命周期内有效）
let _domainRegexCache = null;
let _domainRegexCacheKey = null;

export const FILE_CACHE_CONTROL = {
    PUBLIC: 'public, max-age=2592000',
    PRIVATE: 'private, max-age=86400',
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
]);

// 可内联但需沙箱化的活跃内容：SVG/XML 直接导航时可能执行脚本，
// 保留 inline 展示（图标/图片场景），用 CSP sandbox + script-src 'none' 中和脚本。
const SANDBOX_INLINE_TYPES = new Set([
    'image/svg+xml', 'text/xml', 'application/xml',
]);

function normalizeMime(fileType) {
    if (!fileType) return '';
    return fileType.split(';')[0].trim().toLowerCase();
}

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
export function setCommonHeaders(headers, encodedFileName, fileType, RefererOrCacheControl = FILE_CACHE_CONTROL.PUBLIC, url = null) {
    const mime = normalizeMime(fileType);
    // 页面型活跃内容或压缩包强制下载；SVG/XML 保留 inline 但下方加沙箱 CSP
    const forceDownload = isArchiveType(fileType) || FORCE_DOWNLOAD_TYPES.has(mime);
    const dispositionType = forceDownload ? 'attachment' : 'inline';
    headers.set('Content-Disposition', `${dispositionType}; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`);
    // 禁止 MIME 嗅探，防止被当作可执行内容
    headers.set('X-Content-Type-Options', 'nosniff');
    // 对可内联的活跃内容加沙箱 CSP，直接导航时中和脚本执行（不影响 <img> 嵌入展示）
    if (SANDBOX_INLINE_TYPES.has(mime)) {
        headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Vary', 'Range');

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
    // 确保关键头部存在
    if (!headers.has('Content-Length')) headers.set('Content-Length', '0');
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');

    return new Response(null, {
        status: 200,
        headers,
    });
}

// 转发到第三方上游（Telegram/Telegraph/Discord 等）时，仅保留必要的条件/范围请求头，
// 绝不透传 Cookie、Authorization、authCode 等凭据，防止泄露给第三方。
const FORWARDABLE_UPSTREAM_HEADERS = ['range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding'];

function buildUpstreamHeaders(request) {
    const headers = new Headers();
    for (const name of FORWARDABLE_UPSTREAM_HEADERS) {
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
            if (response.ok || response.status === 304) {
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
    const { request, env, url, securityConfig } = context;
    const whiteListMode = securityConfig.access.whiteListMode;

    const response = new Response('success', { status: 200 });

    // Referer header equal to the dashboard page or upload page (排除公开图库页面的请求)
    const referer = request.headers.get('Referer');
    if (referer && isSameOrigin(referer, url.origin) && !isFromPublicBrowse(referer, url.origin)) {
        //show the image
        return response;
    }

    //check the record from kv
    const record = imgRecord;
    if (record.metadata === null) {
    } else {
        //if the record is not null, redirect to the image
        if (record.metadata.ListType == "White") {
            return response;
        } else if (record.metadata.ListType == "Block") {
            return await returnBlockImg(url);
        } else if (record.metadata.Label == "adult") {
            return await returnBlockImg(url);
        }
        //check if the env variables WhiteList_Mode are set
        if (whiteListMode) {
            //if the env variables WhiteList_Mode are set, redirect to the image
            return await returnWhiteListImg(url);
        } else {
            //if the env variables WhiteList_Mode are not set, redirect to the image
            return response;
        }
    }

    // other cases
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
                "Cache-Control": "public, max-age=86400"
            }
        })
    } else {
        return new Response(blockImg.body, {
            status: 403,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=86400",
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
                "Cache-Control": "public, max-age=86400"
            }
        })
    } else {
        return new Response(WhiteListImg.body, {
            status: 403,
            headers: {
                "Content-Type": "image/png",
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=86400",
            },
        });
    }
}
