import { readIndex } from '../../utils/indexManager.js';
import { fetchOthersConfig } from '../../utils/sysConfig.js';

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

        // 读取所有文件（包括视频、字幕、图片）以便匹配
        const allResult = await readIndex(context, {
            directory: videoDir,
            start: 0,
            count: -1,
            includeSubdirFiles: true,
            accessStatus: 'normal',
        });

        const allFiles = allResult.success ? allResult.files : [];

        // 按目录和文件名构建查找映射
        const fileMap = new Map();
        for (const file of allFiles) {
            const parts = file.id.split('/');
            const name = parts.pop();
            const dir = parts.join('/');
            const key = `${dir}/${name}`.toLowerCase();
            fileMap.set(key, file);
        }

        // 过滤出视频文件
        const videoFiles = allFiles.filter(file => {
            const mimeType = file.metadata?.FileType || '';
            return mimeType.startsWith('video/');
        });

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

            // 查找封面/海报图片：优先同名图片，其次目录下的 cover/poster/thumb 图片
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
