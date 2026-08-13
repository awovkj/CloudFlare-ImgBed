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

/**
 * 常见音频文件扩展名集合（小写，无点）
 * 浏览器对部分格式（flac/ape/wma/wav/aiff 等）不返回 audio/* MIME 类型，
 * 上传时会被存为 application/octet-stream 或空字符串，仅靠 MIME 过滤会漏掉这些文件。
 * 此集合用于在 MIME 检测之外，按扩展名兜底识别音频文件。
 */
const AUDIO_EXTENSIONS = new Set([
    'mp3', 'flac', 'ape', 'wav', 'wma', 'ogg', 'oga', 'opus',
    'm4a', 'm4b', 'm4p', 'm4r', 'aac', 'aiff', 'aif', 'aifc',
    'alac', 'amr', 'au', 'snd', 'mid', 'midi', 'kar', 'rmi',
    'mp2', 'mp1', 'mpa', 'mpc', 'mpp', 'mp+', 'wv', 'dsf', 'dff',
    'ac3', 'ec3', 'eac3', 'truehd', 'tta', 'ofr', 'ofs', 'spx',
    '3gp', '3g2', 'gsm', 'vox', 'weba'
]);

function getFileExtension(fileName) {
    if (!fileName) return '';
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot === -1 || lastDot === fileName.length - 1) return '';
    return fileName.slice(lastDot + 1).toLowerCase();
}

/**
 * 判断文件是否为音频：
 * 1) FileType 以 audio/ 开头（标准识别）
 * 2) 否则按文件扩展名匹配 AUDIO_EXTENSIONS（兜底识别，处理上传时未带 MIME 的音频）
 */
function isAudioFile(file) {
    const mimeType = file?.metadata?.FileType || '';
    if (mimeType.startsWith('audio/')) return true;
    const fileName = file?.metadata?.FileName || file?.id || '';
    const ext = getFileExtension(fileName);
    return ext !== '' && AUDIO_EXTENSIONS.has(ext);
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

        // 单次 readIndex 读取目录下的全部非视频文件（audio + image + other）：
        // - audio/* 直接作为音频返回
        // - other 中扩展名命中 AUDIO_EXTENSIONS 的也视为音频（兜底未带正确 MIME 的上传）
        // - image + 文本类（.lrc/.txt 通常落入 other）用于封面/歌词匹配
        // 用一次扫描同时支撑主列表与配套资源匹配，避免原先的两次全索引扫描。
        const combinedResult = await readIndex(context, {
            directory: musicDir,
            start: 0,
            count: -1,
            includeSubdirFiles: true,
            accessStatus: 'normal',
            fileType: ['audio', 'image', 'other'],
        });

        if (!combinedResult.success) {
            return new Response(JSON.stringify({
                error: 'Failed to load index',
                message: 'Index loading failed, please try again later'
            }), {
                status: 500,
                headers: musicResponseHeaders
            });
        }

        const combinedFiles = combinedResult.files || [];

        // 拆分：音频文件进 allAudioFiles（按 isAudioFile 二次确认），
        // 非音频文件入 companionMap 用于歌词/封面匹配
        const seenAudioIds = new Set();
        const allAudioFiles = [];
        const companionMap = new Map();
        for (const file of combinedFiles) {
            if (!file || !file.id) continue;
            if (isAudioFile(file)) {
                if (!seenAudioIds.has(file.id)) {
                    seenAudioIds.add(file.id);
                    allAudioFiles.push(file);
                }
            } else {
                companionMap.set(file.id.toLowerCase(), file);
            }
        }

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

        // 从 companionMap 中按需挑出歌词/封面文件
        const fileMap = new Map();
        for (const key of neededLookups) {
            if (companionMap.has(key)) {
                fileMap.set(key, companionMap.get(key));
            }
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
