import { getDatabase } from '../../../utils/databaseAdapter.js';
import { createJsonResponse } from '../../../utils/response.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

// 临时链接 KV 键前缀
const TEMP_LINK_PREFIX = 'temp_link:';

// 允许的时长选项（秒）
const DURATION_OPTIONS = {
    '3h': 3 * 60 * 60,
    '1d': 24 * 60 * 60,
    '7d': 7 * 24 * 60 * 60,
};

// KV expirationTtl 最小值为 60 秒
const MIN_TTL = 60;

/**
 * 生成随机 token（使用 crypto.randomUUID，回退到 crypto.getRandomValues）
 */
function generateToken() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID().replace(/-/g, '');
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 列出某文件的所有临时链接
 * KV/D1 通用：使用 db.list({ prefix }) 后在 JS 中按 fileId 过滤
 */
async function listTempLinksByFileId(db, fileId) {
    const result = await db.list({ prefix: TEMP_LINK_PREFIX, limit: 1000 });
    const keys = result?.keys || [];
    const links = [];

    for (const entry of keys) {
        const token = entry.name.slice(TEMP_LINK_PREFIX.length);
        if (!token) continue;
        // 读取完整数据
        const raw = await db.get(entry.name);
        if (!raw) continue;
        try {
            const data = JSON.parse(raw);
            if (data && data.fileId === fileId) {
                links.push({
                    token,
                    fileId: data.fileId,
                    fileName: data.fileName || '',
                    createdAt: data.createdAt,
                    expiresAt: data.expiresAt,
                    duration: data.duration,
                });
            }
        } catch (e) {
            // 跳过损坏记录
        }
    }

    // 按创建时间倒序
    links.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return links;
}

export async function onRequest(context) {
    const { request, env, params } = context;

    // OPTIONS 预检
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 解析 fileId
    let fileId = '';
    try {
        fileId = decodeURIComponent(params.path).split(',').join('/');
    } catch (e) {
        return createJsonResponse({ success: false, message: 'Invalid file ID.' }, {
            status: 400, headers: corsHeaders,
        });
    }

    if (!fileId) {
        return createJsonResponse({ success: false, message: 'File ID is required.' }, {
            status: 400, headers: corsHeaders,
        });
    }

    const db = getDatabase(env);

    try {
        if (request.method === 'POST') {
            return await handleCreateTempLink(db, env, request, fileId, corsHeaders);
        } else if (request.method === 'GET') {
            return await handleListTempLinks(db, fileId, corsHeaders);
        } else if (request.method === 'DELETE') {
            return await handleDeleteTempLink(db, request, fileId, corsHeaders);
        }

        return createJsonResponse({ success: false, message: 'Method not allowed.' }, {
            status: 405, headers: corsHeaders,
        });
    } catch (error) {
        console.error('Temp link API error:', error);
        return createJsonResponse({
            success: false,
            message: error.message || 'Internal server error.',
        }, { status: 500, headers: corsHeaders });
    }
}

/**
 * 创建临时链接
 */
async function handleCreateTempLink(db, env, request, fileId, corsHeaders) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return createJsonResponse({ success: false, message: 'Invalid request body.' }, {
            status: 400, headers: corsHeaders,
        });
    }

    const duration = body?.duration;
    const ttlSeconds = DURATION_OPTIONS[duration];
    if (!ttlSeconds) {
        return createJsonResponse({
            success: false,
            message: 'Invalid duration. Allowed: 3h, 1d, 7d.',
        }, { status: 400, headers: corsHeaders });
    }

    // 验证文件存在
    const fileRecord = await db.getWithMetadata(fileId);
    if (!fileRecord) {
        return createJsonResponse({ success: false, message: 'File not found.' }, {
            status: 404, headers: corsHeaders,
        });
    }

    const fileName = fileRecord.metadata?.FileName || fileId;
    const token = generateToken();
    const key = TEMP_LINK_PREFIX + token;
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const linkData = {
        fileId,
        fileName,
        createdAt: now,
        expiresAt,
        duration,
    };

    // KV 直接使用 expirationTtl；D1 适配器会自动转换为 __imgbedInternal envelope
    await db.put(key, JSON.stringify(linkData), {
        expirationTtl: Math.max(ttlSeconds, MIN_TTL),
    });

    const url = new URL(request.url);
    const tempLinkUrl = `${url.origin}/temp/${token}`;

    return createJsonResponse({
        success: true,
        link: {
            token,
            url: tempLinkUrl,
            fileId,
            fileName,
            createdAt: now,
            expiresAt,
            duration,
        },
    }, { status: 200, headers: corsHeaders });
}

/**
 * 列出文件的所有临时链接
 */
async function handleListTempLinks(db, fileId, corsHeaders) {
    const links = await listTempLinksByFileId(db, fileId);
    return createJsonResponse({ success: true, links }, {
        status: 200, headers: corsHeaders,
    });
}

/**
 * 删除临时链接（手动销毁）
 * 支持: ?token=xxx 删除单个；不带 token 删除该文件的全部临时链接
 */
async function handleDeleteTempLink(db, request, fileId, corsHeaders) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (token) {
        const key = TEMP_LINK_PREFIX + token;
        // 验证 token 属于该文件，防止越权删除
        const raw = await db.get(key);
        if (!raw) {
            return createJsonResponse({
                success: false,
                message: 'Temporary link not found or already expired.',
            }, { status: 404, headers: corsHeaders });
        }
        try {
            const data = JSON.parse(raw);
            if (data.fileId !== fileId) {
                return createJsonResponse({
                    success: false,
                    message: 'Token does not belong to this file.',
                }, { status: 403, headers: corsHeaders });
            }
        } catch (e) {
            return createJsonResponse({
                success: false,
                message: 'Corrupted temporary link record.',
            }, { status: 500, headers: corsHeaders });
        }
        await db.delete(key);
        return createJsonResponse({ success: true, deleted: token }, {
            status: 200, headers: corsHeaders,
        });
    }

    // 删除该文件的全部临时链接
    const links = await listTempLinksByFileId(db, fileId);
    let deleted = 0;
    for (const link of links) {
        await db.delete(TEMP_LINK_PREFIX + link.token);
        deleted++;
    }
    return createJsonResponse({ success: true, deletedCount: deleted }, {
        status: 200, headers: corsHeaders,
    });
}
