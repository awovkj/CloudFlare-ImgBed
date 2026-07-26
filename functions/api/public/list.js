import { fetchOthersConfig } from "../../utils/sysConfig";
import { readIndex } from '../../utils/indexManager.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

/**
 * 检查目录是否在允许列表中
 * @param {string} dir - 请求的目录
 * @param {string[]} allowedDirs - 允许的目录列表
 * @returns {boolean}
 */
function isAllowedDirectory(dir, allowedDirs) {
    // 如果允许目录列表为空，视为允许所有目录（包括根目录）
    if (!allowedDirs || allowedDirs.length === 0) {
        return true;
    }

    // 标准化目录格式
    const normalizedDir = dir.replace(/^\/+/, '').replace(/\/+$/, '');

    for (const allowed of allowedDirs) {
        const normalizedAllowed = allowed.trim().replace(/^\/+/, '').replace(/\/+$/, '');

        // "*" 或空字符串表示允许所有目录（包括根目录）
        if (normalizedAllowed === '*' || normalizedAllowed === '') {
            return true;
        }

        // 根目录访问：如果请求的是空目录，需要精确匹配
        if (normalizedDir === '' && normalizedAllowed !== '') {
            continue; // 根目录不匹配具体目录名
        }

        // 精确匹配或子目录匹配
        if (normalizedDir === normalizedAllowed ||
            normalizedDir.startsWith(normalizedAllowed + '/')) {
            return true;
        }
    }

    return false;
}

/**
 * 获取公开浏览文件列表（带缓存）
 * @param {Object} context - 上下文对象
 * @param {URL} url - 请求URL
 * @param {string} dir - 目录
 * @param {boolean} recursive - 是否递归
 * @returns {Promise<Object>} 文件列表和目录列表，包含 fromCache 字段
 */
async function getPublicFileList(context, url, dir, recursive, options = {}) {
    const { start = 0, count = 50, search = '', fileType = '' } = options;
    const safeStart = Math.max(0, start);
    const safeCount = Math.min(Math.max(1, count), 200);
    const hasAdvancedFilter = Boolean(search || fileType);

    if (hasAdvancedFilter) {
        const typeFilters = fileType ? [fileType] : [];
        const result = await readIndex(context, {
            directory: dir,
            search,
            start: safeStart,
            count: safeCount,
            includeSubdirFiles: recursive,
            accessStatus: 'normal',
            fileType: typeFilters
        });

        if (!result.success) {
            return { files: [], directories: [], totalCount: 0, returnedCount: 0, fromCache: false };
        }

        const files = (result.files || []).map(file => ({
            id: file.id,
            metadata: {
                FileType: file.metadata?.FileType,
                TimeStamp: file.metadata?.TimeStamp,
                FileSize: file.metadata?.FileSize,
            }
        }));

        return {
            files,
            directories: result.directories || [],
            totalCount: result.totalCount || 0,
            returnedCount: result.returnedCount || files.length,
            fromCache: false,
        };
    }

    // 构建缓存键（目录格式去掉末尾的/，与清除缓存时的格式一致）
    const cacheDir = dir.replace(/\/$/, '');
    const cacheKey = `${url.origin}/api/publicFileList?dir=${cacheDir}&recursive=${recursive}&start=${safeStart}&count=${safeCount}`;

    // 检查缓存中是否有记录
    const cache = caches.default;
    const cacheRes = await cache.match(cacheKey);
    if (cacheRes) {
        const data = JSON.parse(await cacheRes.text());
        data.fromCache = true;
        return data;
    }

    // 读取当前页文件列表
    const result = await readIndex(context, {
        directory: dir,
        start: safeStart,
        count: safeCount,
        includeSubdirFiles: recursive,
        accessStatus: 'normal', // 只返回正常可访问的内容
    });

    if (!result.success) {
        return { files: [], directories: [], totalCount: 0, returnedCount: 0, fromCache: false };
    }

    // 转换文件格式（只保留必要信息）
    const files = result.files.map(file => ({
        id: file.id,
        metadata: {
            FileType: file.metadata?.FileType,
            TimeStamp: file.metadata?.TimeStamp,
            FileSize: file.metadata?.FileSize,
        }
    }));

    const cacheData = {
        files,
        directories: result.directories,
        totalCount: result.totalCount,
        returnedCount: result.returnedCount || files.length,
    };

    // 缓存结果，缓存时间为24小时
    await cache.put(cacheKey, new Response(JSON.stringify(cacheData), {
        headers: {
            "Content-Type": "application/json",
        }
    }), {
        expirationTtl: 24 * 60 * 60
    });

    cacheData.fromCache = false;
    return cacheData;
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders
        });
    }

    // 只允许 GET 请求
    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }

    try {
        // 读取配置
        const othersConfig = await fetchOthersConfig(env);
        const publicBrowse = othersConfig.publicBrowse || {};

        // 检查是否启用公开浏览
        if (!publicBrowse.enabled) {
            return new Response(JSON.stringify({ error: 'Public browse is disabled' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 解析允许的目录
        const allowedDirStr = publicBrowse.allowedDir || '';
        let allowedDirs = allowedDirStr.split(',').map(d => d.trim()).filter(d => d);

        // 获取请求的目录和搜索参数（清洗路径穿越/反斜杠）
        let dir = (url.searchParams.get('dir') || '').replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        let search = url.searchParams.get('search') || '';
        if (search) {
            search = decodeURIComponent(search).trim().toLowerCase();
        }

        // 获取高级搜索参数
        const recursive = url.searchParams.get('recursive') === 'true';
        const fileType = url.searchParams.get('type') || ''; // image, video, audio, other

        // 检查目录权限
        if (!isAllowedDirectory(dir, allowedDirs)) {
            return new Response(JSON.stringify({ error: 'Directory not allowed' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 处理目录格式
        if (dir.startsWith('/')) {
            dir = dir.substring(1);
        }
        if (dir && !dir.endsWith('/')) {
            dir += '/';
        }

        // 解析分页参数
        const start = parseInt(url.searchParams.get('start'), 10) || 0;
        const count = parseInt(url.searchParams.get('count'), 10) || 50;

        // 获取文件列表（带缓存）
        const cachedData = await getPublicFileList(context, url, dir, recursive, {
            start,
            count,
            search,
            fileType
        });

        // 过滤子目录，只返回允许的目录
        const filteredDirectories = cachedData.directories.filter(subDir => {
            return isAllowedDirectory(subDir, allowedDirs);
        });

        const filteredFiles = cachedData.files;
        const filteredTotalCount = cachedData.totalCount;

        // 转换文件格式
        const safeFiles = filteredFiles.map(file => ({
            name: file.id,
            metadata: file.metadata
        }));

        return new Response(JSON.stringify({
            files: safeFiles,
            directories: filteredDirectories,
            totalCount: filteredTotalCount,
            returnedCount: cachedData.returnedCount || safeFiles.length,
            allowedDirs: allowedDirs, // 返回允许的目录列表供前端使用
            fromCache: cachedData.fromCache,
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

    } catch (error) {
        console.error('Error in public list API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
