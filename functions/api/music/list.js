import { readIndex } from '../../utils/indexManager.js';
import { fetchOthersConfig } from '../../utils/sysConfig.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

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
        // 从 others 配置中读取音乐播放器设置
        const othersConfig = await fetchOthersConfig(env);
        const musicConfig = othersConfig.musicPlayer || {};

        if (!musicConfig.enabled) {
            return new Response(JSON.stringify({ error: 'Music player is disabled', enabled: false }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 获取配置的音乐目录
        let musicDir = musicConfig.musicDir || '';
        if (musicDir.startsWith('/')) {
            musicDir = musicDir.substring(1);
        }
        if (musicDir && !musicDir.endsWith('/')) {
            musicDir += '/';
        }

        // 读取音频文件列表
        const result = await readIndex(context, {
            directory: musicDir,
            start: 0,
            count: -1,
            fileType: ['audio'],
            includeSubdirFiles: true,
            accessStatus: 'normal',
        });

        if (!result.success) {
            return new Response(JSON.stringify({ files: [], totalCount: 0 }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 构建音乐文件列表
        const files = result.files.map(file => {
            const fileName = file.id.split('/').pop();
            const displayName = fileName.replace(/\.[^/.]+$/, '');
            return {
                id: file.id,
                name: displayName,
                fileName: fileName,
                url: `/file/${file.id}`,
                fileType: file.metadata?.FileType || '',
                fileSize: file.metadata?.FileSize || 0,
                timestamp: file.metadata?.TimeStamp || 0,
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
