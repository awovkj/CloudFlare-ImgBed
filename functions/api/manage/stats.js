import { getDatabase } from '../../utils/databaseAdapter.js';
import { fetchOthersConfig } from '../../utils/sysConfig.js';

const STATS_CACHE_TTL_MS = 30000;
let cachedStats = null;
let cachedAt = 0;

function shouldSkipKey(name) {
    return name.startsWith('manage@') ||
        name.startsWith('chunk_') ||
        name.startsWith('index_') ||
        name.startsWith('operation_');
}

function extractFileExtension(fileName, fileType) {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex !== -1 && dotIndex < fileName.length - 1) {
        return fileName.substring(dotIndex + 1).toLowerCase();
    }

    if (fileType.includes('/')) {
        const mimeExt = fileType.split('/').pop();
        if (mimeExt && mimeExt !== fileType) {
            return mimeExt.toLowerCase();
        }
    }

    return 'unknown';
}

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'GET' && request.method !== 'OPTIONS') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });
    }

    // 处理 OPTIONS 请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: corsHeaders
        });
    }

    // 检查是否允许显示统计图
    const othersConfig = await fetchOthersConfig(env);
    if (othersConfig.showStats && othersConfig.showStats.enabled === false) {
        return new Response(JSON.stringify({ error: 'Stats disabled', showStats: false }), {
            status: 403,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });
    }

    const now = Date.now();
    if (cachedStats && now - cachedAt < STATS_CACHE_TTL_MS) {
        return new Response(cachedStats, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=15, stale-while-revalidate=15',
                ...corsHeaders
            }
        });
    }

    try {
        const db = getDatabase(env);
        
        // 统计数据结构
        const stats = {
            totalFiles: 0,
            totalSize: 0, // MB
            fileTypes: {}, // { ext: { count, size } }
            channels: {} // { channel: { count, size } }
        };

        let cursor = null;
        const limit = 1000;

        // 遍历所有文件
        while (true) {
            const response = await db.list({
                limit: limit,
                cursor: cursor
            });

            if (!response || !response.keys || !Array.isArray(response.keys)) {
                break;
            }

            cursor = response.cursor;

            for (const item of response.keys) {
                // 跳过管理相关的键
                if (shouldSkipKey(item.name)) {
                    continue;
                }

                // 跳过没有元数据的文件
                if (!item.metadata || !item.metadata.TimeStamp) {
                    continue;
                }

                const metadata = item.metadata;
                const fileSize = parseFloat(metadata.FileSize) || 0;
                const fileName = metadata.FileName || item.name;
                const fileType = metadata.FileType || 'unknown';
                const channel = metadata.Channel || 'Unknown';
                const ext = extractFileExtension(fileName, fileType);

                // 统计总数
                stats.totalFiles++;
                stats.totalSize += fileSize;

                // 按文件类型统计
                if (!stats.fileTypes[ext]) {
                    stats.fileTypes[ext] = { count: 0, size: 0 };
                }
                stats.fileTypes[ext].count++;
                stats.fileTypes[ext].size += fileSize;

                // 按上传渠道统计
                if (!stats.channels[channel]) {
                    stats.channels[channel] = { count: 0, size: 0 };
                }
                stats.channels[channel].count++;
                stats.channels[channel].size += fileSize;
            }

            if (!cursor) break;

            // 添加协作点，避免超时
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // 转换为数组并排序
        stats.fileTypesList = Object.entries(stats.fileTypes)
            .map(([ext, data]) => ({
                ext: ext,
                count: data.count,
                size: parseFloat(data.size.toFixed(2))
            }))
            .sort((a, b) => b.count - a.count);

        stats.channelsList = Object.entries(stats.channels)
            .map(([channel, data]) => ({
                channel: channel,
                count: data.count,
                size: parseFloat(data.size.toFixed(2))
            }))
            .sort((a, b) => b.count - a.count);

        // 格式化总大小
        stats.totalSize = parseFloat(stats.totalSize.toFixed(2));

        const responseBody = JSON.stringify(stats);
        cachedStats = responseBody;
        cachedAt = now;

        return new Response(responseBody, {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=15, stale-while-revalidate=15',
                ...corsHeaders
            }
        });

    } catch (error) {
        console.error('Error in stats API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });
    }
}
