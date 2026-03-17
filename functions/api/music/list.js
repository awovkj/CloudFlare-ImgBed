import { readIndex } from '../../utils/indexManager.js';
import { getDatabase } from '../../utils/databaseAdapter.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

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
        const db = getDatabase(env);

        // 读取音乐配置
        const configStr = await db.get('manage@sysConfig@music');
        const config = configStr ? JSON.parse(configStr) : {};

        if (!config.enabled) {
            return new Response(JSON.stringify({ error: 'Music player is disabled' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // 获取配置的音乐目录
        let musicDir = config.musicDir || '';
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
            // 去掉扩展名作为显示名
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
            musicDir: config.musicDir || '/',
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
