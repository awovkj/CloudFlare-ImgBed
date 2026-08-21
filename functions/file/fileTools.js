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

/**
 * 扩展名 → 规范 MIME 映射。
 *
 * 为什么以扩展名而不是 metadata.FileType 为准：
 *   FileType 存的是上传时浏览器给出的 file.type，可靠性很差 ——
 *   分片上传缺省写入 'application/octet-stream'（chunkUpload.js / chunkMerge.js），
 *   HuggingFace/WebDAV 等通道可能写入空串，部分 Windows 浏览器把 .docx 报成
 *   'application/x-zip-compressed'。而响应始终带 X-Content-Type-Options: nosniff，
 *   Content-Type 一旦是 octet-stream，浏览器就只会下载，PDF/文本无法在线预览
 *   ——即"文档预览点开后仍然是下载"的根因。
 *
 * 安全取向：扩展名比上传时的 MIME 更可信（后者是 multipart 里的用户可控字段），
 *   且这里对脚本/样式类源码统一映射为 text/plain，配合 nosniff 后浏览器
 *   拒绝把它们当 script/stylesheet 加载，比映射成 text/javascript 更安全，
 *   同时又能直接在浏览器里以纯文本预览。
 */
const TEXT_PLAIN = 'text/plain; charset=utf-8';
const EXT_MIME_MAP = {
    // ── 文档 ──
    pdf: 'application/pdf',
    doc: 'application/msword',
    dot: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlt: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pps: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    rtf: 'application/rtf',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    // epub 的规范 MIME 含 "zip" 子串，会被 isArchiveType 判为压缩包而强制下载；
    // 浏览器本身也无法内联渲染 epub，attachment 正是期望结果。
    epub: 'application/epub+zip',

    // ── 纯文本 / 结构化文本 ──
    // md 故意映射为 text/plain 而非 text/markdown：浏览器不渲染 text/markdown
    // 会直接下载，text/plain 才能直接看（与 GitHub raw 的做法一致）。
    txt: TEXT_PLAIN, text: TEXT_PLAIN, log: TEXT_PLAIN, md: TEXT_PLAIN,
    markdown: TEXT_PLAIN, mdown: TEXT_PLAIN, rst: TEXT_PLAIN, srt: TEXT_PLAIN,
    vtt: 'text/vtt; charset=utf-8',
    json: 'application/json; charset=utf-8',
    jsonl: TEXT_PLAIN, ndjson: TEXT_PLAIN, json5: TEXT_PLAIN,
    // xml/svg 走 SANDBOX_INLINE_TYPES：保留 inline，但加沙箱 CSP 中和脚本
    xml: 'application/xml; charset=utf-8',
    yml: TEXT_PLAIN, yaml: TEXT_PLAIN, toml: TEXT_PLAIN, ini: TEXT_PLAIN,
    conf: TEXT_PLAIN, cfg: TEXT_PLAIN, env: TEXT_PLAIN, properties: TEXT_PLAIN,
    csv: 'text/csv; charset=utf-8',
    tsv: 'text/tab-separated-values; charset=utf-8',

    // ── 源码：统一 text/plain（配合 nosniff 既可预览又不可被当作脚本加载）──
    js: TEXT_PLAIN, mjs: TEXT_PLAIN, cjs: TEXT_PLAIN, jsx: TEXT_PLAIN,
    tsx: TEXT_PLAIN, vue: TEXT_PLAIN, css: TEXT_PLAIN, scss: TEXT_PLAIN,
    less: TEXT_PLAIN, sass: TEXT_PLAIN, py: TEXT_PLAIN, java: TEXT_PLAIN,
    kt: TEXT_PLAIN, c: TEXT_PLAIN, h: TEXT_PLAIN, cpp: TEXT_PLAIN,
    hpp: TEXT_PLAIN, cc: TEXT_PLAIN, cs: TEXT_PLAIN, go: TEXT_PLAIN,
    rs: TEXT_PLAIN, rb: TEXT_PLAIN, php: TEXT_PLAIN, pl: TEXT_PLAIN,
    lua: TEXT_PLAIN, swift: TEXT_PLAIN, sh: TEXT_PLAIN, bash: TEXT_PLAIN,
    zsh: TEXT_PLAIN, bat: TEXT_PLAIN, cmd: TEXT_PLAIN, ps1: TEXT_PLAIN,
    sql: TEXT_PLAIN, dockerfile: TEXT_PLAIN, gradle: TEXT_PLAIN,
    patch: TEXT_PLAIN, diff: TEXT_PLAIN,

    // ── 页面型活跃内容：命中 FORCE_DOWNLOAD_TYPES → attachment ──
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    xhtml: 'application/xhtml+xml; charset=utf-8',

    // ── 图片 ──
    png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    jpe: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', ico: 'image/x-icon', cur: 'image/x-icon',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
    tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',

    // ── 音频 ──
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
    m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    wma: 'audio/x-ms-wma', mid: 'audio/midi', midi: 'audio/midi',
    amr: 'audio/amr', ape: 'audio/x-ape',

    // ── 视频（.ts 有歧义：既可能是 TypeScript 也可能是 MPEG-TS，故不收录）──
    mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg',
    mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    flv: 'video/x-flv', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg',
    mpeg: 'video/mpeg', '3gp': 'video/3gpp', mts: 'video/mp2t', m2ts: 'video/mp2t',

    // ── 压缩包：命中 isArchiveType → attachment ──
    zip: 'application/zip', rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
    gz: 'application/gzip', tgz: 'application/gzip',
    bz2: 'application/x-bzip2', xz: 'application/x-xz',
    zst: 'application/zstd',

    // ── 二进制安装包/镜像：明确 octet-stream，交给浏览器下载 ──
    exe: 'application/octet-stream', msi: 'application/octet-stream',
    apk: 'application/vnd.android.package-archive',
    dmg: 'application/octet-stream', iso: 'application/octet-stream',
    deb: 'application/octet-stream', rpm: 'application/octet-stream',
    jar: 'application/java-archive', bin: 'application/octet-stream',

    // ── 字体 ──
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
};

// 视为"没有有效类型"的 MIME：出现这些值时优先用扩展名推断
const GENERIC_MIME_TYPES = new Set([
    '', 'application/octet-stream', 'binary/octet-stream', 'application/binary',
    'application/download', 'application/force-download', 'application/x-download',
    'application/unknown', '*/*', 'unknown', 'null', 'undefined',
]);

function extractExtension(name) {
    if (!name) return '';
    const base = String(name).split('/').pop().split('\\').pop();
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
}

/**
 * 解析响应用的 Content-Type。
 * 优先级：已知扩展名 → 上传时记录的具体 MIME → application/octet-stream
 *
 * @param {string} fileName - metadata.FileName
 * @param {string|null} storedType - metadata.FileType
 * @param {string} [fallbackName] - 文件 ID，FileName 无扩展名时兜底
 * @returns {string} 可直接写入 Content-Type 的值
 */
export function resolveContentType(fileName, storedType, fallbackName = '') {
    const ext = extractExtension(fileName) || extractExtension(fallbackName);
    const mapped = ext ? EXT_MIME_MAP[ext] : undefined;
    if (mapped) return mapped;

    const stored = typeof storedType === 'string' ? storedType.trim() : '';
    if (stored && !GENERIC_MIME_TYPES.has(normalizeMime(stored))) return stored;

    return 'application/octet-stream';
}

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
    const { url, securityConfig, request } = context;
    const whiteListMode = securityConfig.access.whiteListMode;
    // ?from=admin 的预览必须通过管理端鉴权；不再信任可伪造的 Referer 头
    const isAdminPreview = context.fileAccess?.isAdminPreview === true;
    const adminAuthorized = context.fileAccess?.adminAuthResult?.authorized === true;
    // 临时链接访问：通过 /temp/{token} 转发而来，绕过 block/white/白名单模式检查
    const isTempLinkAccess = context.fileAccess?.isTempLinkAccess === true;

    const response = new Response('success', { status: 200 });

    // 判断管理端预览权限是否有效（需通过会话鉴权或同源 Referer 兜底）。
    // 鉴权失败时降级为普通访问，而非返回 401 —— 避免 IDM 等下载工具拦截带
    // ?from=admin 的链接时，因不携带 Cookie/Referer 触发账号密码弹窗。
    // from=admin 是可伪造的 URL 参数，真正的鉴权始终依赖会话 Cookie，
    // 降级后普通文件正常下载，受限文件返回拦截图片（管理员可通过浏览器直接下载）。
    let adminPreviewEffective = false;
    if (isAdminPreview) {
        if (adminAuthorized) {
            adminPreviewEffective = true;
        } else {
            // 兜底：会话鉴权未通过时（如 cookie 未随 <img> 请求发送、会话过期、
            // 或 authenticate 内部 fetchSecurityConfig 抛错被吞掉），
            // 回退到同源 Referer 校验，保证后台预览可用，同时排除公开图库页面。
            const referer = request?.headers.get('Referer');
            if (referer && isSameOrigin(referer, url.origin) && !isFromPublicBrowse(referer, url.origin)) {
                adminPreviewEffective = true;
            }
            // 鉴权失败且 Referer 不通过：降级为普通访问，继续走后续 block/white 检查
        }
    }

    const record = imgRecord;
    if (record.metadata === null) {
        if (context.fileAccess) {
            context.fileAccess.cacheControl = (adminPreviewEffective || isTempLinkAccess) ? FILE_CACHE_CONTROL.PUBLIC : FILE_CACHE_CONTROL.PUBLIC;
        }
        return response;
    }

    // 已鉴权的管理端预览：可查看 Block/adult/白名单外文件，但响应仅私有缓存
    if (adminPreviewEffective) {
        if (context.fileAccess) {
            context.fileAccess.cacheControl = FILE_CACHE_CONTROL.PRIVATE;
        }
        return response;
    }

    // 临时链接访问：绕过 block/white/白名单模式检查，使用公开缓存
    if (isTempLinkAccess) {
        if (context.fileAccess) {
            context.fileAccess.cacheControl = FILE_CACHE_CONTROL.PUBLIC;
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
