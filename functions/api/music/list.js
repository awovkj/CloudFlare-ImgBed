import { readIndex } from '../../utils/indexManager.js';
import { fetchOthersConfig } from '../../utils/sysConfig.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

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
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }

    try {
        const othersConfig = await fetchOthersConfig(env);
        const musicConfig = othersConfig.musicPlayer || {};

        if (!musicConfig.enabled) {
            return new Response(JSON.stringify({ error: 'Music player is disabled', enabled: false }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        let musicDir = musicConfig.musicDir || '';
        if (musicDir.startsWith('/')) {
            musicDir = musicDir.substring(1);
        }
        if (musicDir && !musicDir.endsWith('/')) {
            musicDir += '/';
        }

        // 读取所有文件（包括音频、歌词、图片）以便匹配
        const allResult = await readIndex(context, {
            directory: musicDir,
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

        // 过滤出音频文件
        const audioFiles = allFiles.filter(file => {
            const mimeType = file.metadata?.FileType || '';
            return mimeType.startsWith('audio/');
        });

        // 构建音乐文件列表
        const files = audioFiles.map(file => {
            const parts = file.id.split('/');
            const fileName = parts.pop();
            const dir = parts.join('/');
            const baseName = fileName.replace(/\.[^/.]+$/, '');
            const displayName = cleanDisplayName(baseName);

            // 查找同名 .lrc 歌词文件
            let lrcUrl = null;
            const lrcExts = ['.lrc'];
            for (const ext of lrcExts) {
                const lrcKey = `${dir}/${baseName}${ext}`.toLowerCase();
                if (fileMap.has(lrcKey)) {
                    lrcUrl = `/file/${fileMap.get(lrcKey).id}`;
                    break;
                }
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
                timestamp: file.metadata?.TimeStamp || 0,
                lrcUrl,
                coverUrl,
            };
        });

        return new Response(JSON.stringify({
            files,
            totalCount: files.length,
            musicDir: musicConfig.musicDir || '/',
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

    } catch (error) {
        console.error('Error in music list API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
