import { fetchOthersConfig } from '../../../utils/sysConfig.js';

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
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }

    try {
        const config = await fetchOthersConfig(env);
        const enabled = config.showStats?.enabled ?? true;
        const configSource = config.__configSource || 'configured';
        return new Response(JSON.stringify({ enabled, configSource }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
                ...corsHeaders,
            },
        });
    } catch (e) {
        // 出错时默认启用，不影响正常显示
        return new Response(JSON.stringify({ enabled: true, configSource: 'fallback' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    }
}
