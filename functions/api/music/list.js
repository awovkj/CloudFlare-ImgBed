import { readIndex } from '../../utils/indexManager.js';
import { fetchOthersConfig } from '../../utils/sysConfig.js';
import { getMusicAccessState } from '../../utils/auth/musicAuth.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

const musicResponseHeaders = {
    'Content-Type': 'application/json',
    ...corsHeaders,
    'Cache-Control': 'no-store',
};

function accessErrorResponse(state) {
    const status = state === 'disabled' ? 403 : state === 'unauthorized' ? 401 : 503;
    const error = state === 'disabled'
        ? 'Music player is disabled'
        : state === 'unauthorized'
            ? 'Unauthorized'
            : 'Music player configuration unavailable';
    return new Response(JSON.stringify({ error }), { status, headers: musicResponseHeaders });
}

/**
 * 清理歌曲显示名：去除常见数字前缀
 * 例如: "01 - Song Name" -> "Song Name"
 *       "01. Song Name" -> "Song Name"
 *       "01_Song Name"  -> "Song Name"
 *       "1 Song Name"   -> "Song Name"
 */
function cleanDisplayName(name) {
    return name
        .replace(/^\d+[\s._\-]+/, '')   // 去除开头数字+分隔符
        .replace(/^\s*-\s*/, '')         // 去除残留的 " - "
        .trim() || name;                 // 如果清理后为空则保留原名
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: musicResponseHeaders
        });
    }

    try {
        // 客户端认证检查
        const url = new URL(request.url);
        const access = await getMusicAccessState(env, request);
        if (!access.authorized) {
            return accessErrorResponse(access.state);
        }

        const othersConfig = await fetchOthersConfig(env);
        const musicConfig = othersConfig.musicPlayer || {};

        if (!musicConfig.enabled) {
            return new Response(JSON.stringify({ error: 'Music player is disabled', enabled: false }), {
                status: 403,
                headers: musicResponseHeaders
            });
        }

        let musicDir = musicConfig.musicDir || '';
        if (musicDir.startsWith('/')) {
            musicDir = musicDir.substring(1);
        }
        if (musicDir && !musicDir.endsWith('/')) {
            musicDir += '/';
        }

        // 分页参数
        const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize')) || 50));

        // 只读取音频文件（使用 fileType 过滤减少返回数据量）
        const audioResult = await readIndex(context, {
            directory: musicDir,
            start: 0,
            count: -1,
            includeSubdirFiles: true,
            accessStatus: 'normal',
            fileType: 'audio',
        });

        if (!audioResult.success) {
            return new Response(JSON.stringify({
                error: 'Failed to load index',
                message: 'Index loading failed, please try again later'
            }), {
                status: 500,
                headers: musicResponseHeaders
            });
        }

        const allAudioFiles = audioResult.files || [];
        const totalCount = allAudioFiles.length;
        const totalPages = Math.ceil(totalCount / pageSize) || 1;
        const startIdx = (page - 1) * pageSize;
        const audioFiles = allAudioFiles.slice(startIdx, startIdx + pageSize);

        // 收集音频文件所在目录和基名，用于查找歌词/封面
        const neededLookups = new Set();
        for (const file of audioFiles) {
            const parts = file.id.split('/');
            const fileName = parts.pop();
            const dir = parts.join('/');
            const baseName = fileName.replace(/\.[^/.]+$/, '');
            const displayBaseName = cleanDisplayName(baseName);
            for (const name of new Set([baseName, displayBaseName])) {
                for (const ext of ['.lrc', '.txt']) {
                    neededLookups.add(`${dir}/${name}${ext}`.toLowerCase());
                }
            }
            // 同名封面
            for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
                neededLookups.add(`${dir}/${baseName}${ext}`.toLowerCase());
            }
            // 通用封面
            for (const cname of ['cover', 'folder', 'album', 'front']) {
                for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
                    neededLookups.add(`${dir}/${cname}${ext}`.toLowerCase());
                }
            }
        }

        // 读取非音频文件（歌词、封面等）用于匹配，失败时静默跳过
        let fileMap = new Map();
        try {
            const companionResult = await readIndex(context, {
                directory: musicDir,
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
            // 封面/歌词匹配失败不影响主列表
            console.warn('Failed to load companion files for cover/lyrics matching:', e.message);
        }

        // 构建音乐文件列表
        const files = audioFiles.map(file => {
            const parts = file.id.split('/');
            const fileName = parts.pop();
            const dir = parts.join('/');
            const baseName = fileName.replace(/\.[^/.]+$/, '');
            const displayName = cleanDisplayName(baseName);

            let lrcUrl = null;
            for (const name of new Set([baseName, displayName])) {
                for (const ext of ['.lrc', '.txt']) {
                    const lrcKey = `${dir}/${name}${ext}`.toLowerCase();
                    if (fileMap.has(lrcKey)) {
                        lrcUrl = `/file/${fileMap.get(lrcKey).id}`;
                        break;
                    }
                }
                if (lrcUrl) break;
            }

            // 查找封面图片：优先同名图片，其次目录下的 cover/folder 图片
            let coverUrl = null;
            const imgExts = ['.jpg', '.jpeg', '.png', '.webp'];
            // 1. 同名图片
            for (const ext of imgExts) {
                const imgKey = `${dir}/${baseName}${ext}`.toLowerCase();
                if (fileMap.has(imgKey)) {
                    coverUrl = `/file/${fileMap.get(imgKey).id}`;
                    break;
                }
            }
            // 2. 目录下的 cover.* / folder.* / album.*
            if (!coverUrl) {
                const coverNames = ['cover', 'folder', 'album', 'front'];
                for (const cname of coverNames) {
                    for (const ext of imgExts) {
                        const coverKey = `${dir}/${cname}${ext}`.toLowerCase();
                        if (fileMap.has(coverKey)) {
                            coverUrl = `/file/${fileMap.get(coverKey).id}`;
                            break;
                        }
                    }
                    if (coverUrl) break;
                }
            }

            return {
                id: file.id,
                name: displayName,
                fileName: fileName,
                url: `/file/${file.id}`,
                fileType: file.metadata?.FileType || '',
                fileSize: file.metadata?.FileSize || 0,
                fileSizeBytes: file.metadata?.FileSizeBytes || 0,
                timestamp: file.metadata?.TimeStamp || 0,
                lrcUrl,
                coverUrl,
            };
        });

        return new Response(JSON.stringify({
            files,
            totalCount,
            page,
            pageSize,
            totalPages,
            hasMore: page < totalPages,
            musicDir: musicConfig.musicDir || '/',
        }), {
            headers: musicResponseHeaders
        });

    } catch (error) {
        console.error('Error in music list API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: musicResponseHeaders
        });
    }
}
