import { getDatabase } from '../utils/databaseAdapter.js';
import { FILE_CACHE_CONTROL } from '../file/fileTools.js';

const TEMP_LINK_PREFIX = 'temp_link:';

/**
 * 临时链接公开访问端点
 * 路由: GET /temp/{token}
 *
 * 流程:
 *  1. 从 KV/D1 查询 token 对应的文件 ID
 *  2. 若 token 不存在/已过期 → 返回 410 Gone
 *  3. 内部转发到文件处理器，标记为临时链接访问（绕过 block/white/白名单域名检查）
 */
export async function onRequest(context) {
    const { request, env, params } = context;

    // 仅允许 GET/HEAD
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
            status: 405,
            headers: { 'Allow': 'GET, HEAD' },
        });
    }

    // 解析 token
    let token = '';
    try {
        token = decodeURIComponent(params.path || '');
    } catch (e) {
        return new Response('Invalid token', { status: 400 });
    }

    // 去除可能的查询字符串残留
    token = token.split('/')[0].split('?')[0].split('#')[0].trim();

    if (!token || !/^[a-f0-9]+$/i.test(token)) {
        return new Response('Invalid token', { status: 400 });
    }

    const db = getDatabase(env);
    const key = TEMP_LINK_PREFIX + token;
    const raw = await db.get(key);

    if (!raw) {
        return new Response('Temporary link has expired or been destroyed.', {
            status: 410,
            headers: {
                'Content-Type': 'text/plain; charset=UTF-8',
                'Cache-Control': 'no-store',
            },
        });
    }

    let linkData;
    try {
        linkData = JSON.parse(raw);
    } catch (e) {
        return new Response('Corrupted temporary link record.', {
            status: 500,
            headers: { 'Cache-Control': 'no-store' },
        });
    }

    const fileId = linkData.fileId;
    if (!fileId) {
        return new Response('Invalid temporary link.', {
            status: 500,
            headers: { 'Cache-Control': 'no-store' },
        });
    }

    // 二次校验过期时间（D1 适配器可能未及时清理）
    if (linkData.expiresAt && Date.now() > linkData.expiresAt) {
        // 主动清理已过期记录
        try { await db.delete(key); } catch (e) {}
        return new Response('Temporary link has expired.', {
            status: 410,
            headers: {
                'Content-Type': 'text/plain; charset=UTF-8',
                'Cache-Control': 'no-store',
            },
        });
    }

    // 构造内部请求 URL：将 /temp/{token} 改写为 /file/{fileId}
    const originalUrl = new URL(request.url);
    const fileUrl = new URL(originalUrl.origin + '/file/' + fileId.split('/').join(','));
    // 保留必要的查询参数（如下载标识等），但丢弃 admin 预览标识以防绕过
    for (const [k, v] of originalUrl.searchParams) {
        if (k === 'from') continue;
        fileUrl.searchParams.set(k, v);
    }

    // 构造内部请求，添加临时链接标记头
    const internalRequest = new Request(fileUrl.toString(), {
        method: request.method,
        headers: request.headers,
        redirect: 'manual',
    });
    internalRequest.headers.set('X-Temp-Link-Token', token);

    // 构造新的 context，复用文件处理器
    const internalContext = {
        request: internalRequest,
        env,
        params: { path: fileId.split('/').join(',') },
        data: {},
        waitUntil: context.waitUntil,
        passThroughOnException: context.passThroughOnException,
        next: () => new Response('Not Found', { status: 404 }),
        url: fileUrl,
        Referer: request.headers.get('Referer'),
        // 临时链接访问标记：绕过 block/white/白名单域名检查，使用公开缓存
        fileAccess: {
            isTempLinkAccess: true,
            isAdminPreview: false,
            adminAuthResult: { authorized: false, authType: null },
            cacheControl: FILE_CACHE_CONTROL.PUBLIC,
        },
        // 跳过 securityConfig 中的域名白名单检查
        skipDomainCheck: true,
    };

    // 懒加载文件处理器，避免循环依赖
    const { onRequest: onFileRequest } = await import('../file/[[path]].js');
    return await onFileRequest(internalContext);
}
