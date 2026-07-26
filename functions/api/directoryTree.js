import { getDirectoryTree } from '../utils/indexManager';
import { dualAuthCheck } from '../utils/dualAuth';
import { fetchPageConfig } from '../utils/sysConfig';

export async function onRequestGet(context) {
    const { env, request } = context;
    const url = new URL(request.url);

    const authResult = await dualAuthCheck(env, url, request);
    if (!authResult.authorized) {
        return new Response('Unauthorized', { status: 401 });
    }

    // 非管理端登录（含未来新增的认证类型）都需检查目录建议开关
    if (authResult.authType !== 'admin') {
        const pageConfig = await fetchPageConfig(env);
        const showDirSetting = pageConfig.config?.find((item) => item.id === 'showDirectorySuggestions');
        const showDirectorySuggestions = showDirSetting?.value ?? showDirSetting?.default ?? true;

        if (!showDirectorySuggestions) {
            return new Response(JSON.stringify({ error: 'Directory suggestions disabled' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    try {
        const tree = await getDirectoryTree(context);
        const cacheTime = url.searchParams.get('cacheTime') || 60;

        return new Response(JSON.stringify({ tree }), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `private, max-age=${cacheTime}`,
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
