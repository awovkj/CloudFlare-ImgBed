import { fetchOthersConfig } from '../../utils/sysConfig.js';
import { getIndexMeta, readIndex } from '../../utils/indexManager.js';

const ALL_ACCESS_STATUSES = ['normal', 'blocked'];

const STATS_CACHE_TTL_MS = 30000;
let cachedStats = null;
let cachedAt = 0;

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

function getChannelLabel(metadata = {}) {
    return metadata.ChannelName || metadata.Channel || 'Unknown';
}

function sortStatsEntries(entries, key) {
    return entries.sort((a, b) => (b[key] - a[key]) || String(a.ext || a.channel).localeCompare(String(b.ext || b.channel)));
}

function formatStatsResponse(baseStats, fileTypes, channels) {
    return JSON.stringify({
        totalFiles: baseStats.totalFiles,
        totalSize: parseFloat(baseStats.totalSize.toFixed(2)),
        fileTypes,
        channels,
        fileTypesList: sortStatsEntries(fileTypes, 'count'),
        channelsList: sortStatsEntries(channels, 'count')
    });
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
        const meta = await getIndexMeta(context);
        const baseStats = {
            totalFiles: meta.totalCount || 0,
            totalSize: Number(meta.totalSizeMB) || 0
        };

        const detailResult = await readIndex(context, {
            count: -1,
            includeSubdirFiles: true,
            accessStatus: ALL_ACCESS_STATUSES,
            countOnly: false
        });

        if (!detailResult.success) {
            throw new Error('Failed to read index for stats');
        }

        const fileTypesMap = {};
        const channelsMap = {};

        for (const file of detailResult.files || []) {
            const metadata = file.metadata || {};
            const fileSize = parseFloat(metadata.FileSize) || 0;
            const fileName = metadata.FileName || file.id;
            const fileType = metadata.FileType || 'unknown';
            const ext = extractFileExtension(fileName, fileType);
            const channel = getChannelLabel(metadata);

            if (!fileTypesMap[ext]) {
                fileTypesMap[ext] = { count: 0, size: 0 };
            }
            fileTypesMap[ext].count++;
            fileTypesMap[ext].size += fileSize;

            if (!channelsMap[channel]) {
                channelsMap[channel] = { count: 0, size: 0 };
            }
            channelsMap[channel].count++;
            channelsMap[channel].size += fileSize;
        }

        const fileTypes = Object.entries(fileTypesMap).map(([ext, data]) => ({
            ext,
            count: data.count,
            size: parseFloat(data.size.toFixed(2))
        }));

        const channels = Object.entries(channelsMap).map(([channel, data]) => ({
            channel,
            count: data.count,
            size: parseFloat(data.size.toFixed(2))
        }));

        const responseBody = formatStatsResponse(baseStats, fileTypes, channels);
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
