import { readIndex } from '../../utils/indexManager.js';
import { fetchOthersConfig } from '../../utils/sysConfig.js';
import { userAuthCheck } from '../../utils/userAuth.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

/**
 * 清理视频显示名：去除常见数字前缀
 */
function cleanDisplayName(name) {
    return name
        .replace(/^\d+[\s._\-]+/, '')
        .replace(/^\s*-\s*/, '')
        .trim() || name;
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }

    try {
        // 客户端认证检查
        const url = new URL(request.url);
        if (!await userAuthCheck(env, url, request)) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        const othersConfig = await fetchOthersConfig(env);
        const videoConfig = othersConfig.videoPlayer || {};

        if (!videoConfig.enabled) {
            return new Response(JSON.stringify({ error: 'Video player is disabled', enabled: false }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        let videoDir = videoConfig.videoDir || '';
        if (videoDir.startsWith('/')) {
            videoDir = videoDir.substring(1);
        }
        if (videoDir && !videoDir.endsWith('/')) {
            videoDir += '/';
        }

        // 只读取视频文件（使用 fileType 过滤减少返回数据量）
        const videoResult = await readIndex(context, {
            directory: videoDir,
            start: 0,
            count: -1,
            includeSubdirFiles: true,
            accessStatus: 'normal',
            fileType: 'video',
        });

        if (!videoResult.success) {
            return new Response(JSON.stringify({
                error: 'Failed to load index',
                message: 'Index loading failed, please try again later'
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        const videoFiles = videoResult.files || [];

        // 收集视频文件所在目录和基名，用于查找字幕/封面
        const neededLookups = new Set();
        for (const file of videoFiles) {
            const parts = file.id.split('/');
            const fileName = parts.pop();
            const dir = parts.join('/');
            const baseName = fileName.replace(/\.[^/.]+$/, '');
            // 字幕
            for (const ext of ['.vtt', '.srt', '.ass']) {
                neededLookups.add(`${dir}/${baseName}${ext}`.toLowerCase());
            }
            // 同名封面
            for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
                neededLookups.add(`${dir}/${baseName}${ext}`.toLowerCase());
            }
            // 通用封面
            for (const cname of ['cover', 'poster', 'thumb', 'folder']) {
                for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
                    neededLookups.add(`${dir}/${cname}${ext}`.toLowerCase());
                }
            }
        }

        // 读取非视频文件（字幕、封面等）用于匹配，失败时静默跳过
        let fileMap = new Map();
        try {
            const companionResult = await readIndex(context, {
                directory: videoDir,
                start: 0,
                count: -1,
                includeSubdirFiles: true,
                accessStatus: 'normal',
                fileType: ['image', 'other'],
            });
            if (companionResult.success && companionResult.files) {
                for (const file of companionResult.files) {
                    const key = file.id.toLowerCase();
                    if (neededLookups.has(key)) {
                        fileMap.set(key, file);
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to load companion files for subtitle/poster matching:', e.message);
        }

        // 构建视频文件列表
        const files = videoFiles.map(file => {
            const parts = file.id.split('/');
            const fileName = parts.pop();
            const dir = parts.join('/');
            const baseName = fileName.replace(/\.[^/.]+$/, '');
            const displayName = cleanDisplayName(baseName);

            // 查找同名字幕文件
            let subtitleUrl = null;
            const subExts = ['.vtt', '.srt', '.ass'];
            for (const ext of subExts) {
                const subKey = `${dir}/${baseName}${ext}`.toLowerCase();
                if (fileMap.has(subKey)) {
                    subtitleUrl = `/file/${fileMap.get(subKey).id}`;
                    break;
                }
            }

            // 查找封面/海报图片
            let posterUrl = null;
            const imgExts = ['.jpg', '.jpeg', '.png', '.webp'];
            // 1. 同名图片
            for (const ext of imgExts) {
                const imgKey = `${dir}/${baseName}${ext}`.toLowerCase();
                if (fileMap.has(imgKey)) {
                    posterUrl = `/file/${fileMap.get(imgKey).id}`;
                    break;
                }
            }
            // 2. 目录下的 cover.* / poster.* / thumb.*
            if (!posterUrl) {
                const coverNames = ['cover', 'poster', 'thumb', 'folder'];
                for (const cname of coverNames) {
                    for (const ext of imgExts) {
                        const coverKey = `${dir}/${cname}${ext}`.toLowerCase();
                        if (fileMap.has(coverKey)) {
                            posterUrl = `/file/${fileMap.get(coverKey).id}`;
                            break;
                        }
                    }
                    if (posterUrl) break;
                }
            }

            return {
                id: file.id,
                name: displayName,
                fileName: fileName,
                url: `/file/${file.id}`,
                fileType: file.metadata?.FileType || '',
                fileSize: file.metadata?.FileSize || 0,
                timestamp: file.metadata?.TimeStamp || 0,
                subtitleUrl,
                posterUrl,
            };
        });

        return new Response(JSON.stringify({
            files,
            totalCount: files.length,
            videoDir: videoConfig.videoDir || '/',
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

    } catch (error) {
        console.error('Error in video list API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
