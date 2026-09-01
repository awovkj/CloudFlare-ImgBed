import { getDirectoryTree } from '../utils/indexManager';
import { dualAuthCheck } from '../utils/auth/dualAuth.js';
import { fetchPageConfig, fetchOthersConfig } from '../utils/sysConfig';
import { verifyPassword } from '../utils/auth/passwordHash.js';

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
        const showDirectorySuggestions = showDirSetting?.value ?? showDirSetting?.default ?? false;

        if (!showDirectorySuggestions) {
            return new Response(JSON.stringify({ error: 'Directory suggestions disabled' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 目录列表密码门控：启用后非管理员需提供 X-Directory-Password 才能获取目录树
        // （管理员 / API Token 豁免；无状态校验，前端在内存中持有密码）
        const othersConfig = await fetchOthersConfig(env);
        const dirListConfig = othersConfig.directoryList || {};
        if (dirListConfig.enabled && dirListConfig.passwordHash) {
            const dirPassword = request.headers.get('X-Directory-Password') || '';
            const passwordOk = dirPassword
                ? await verifyPassword(dirPassword, dirListConfig.passwordHash)
                : false;
            if (!passwordOk) {
                return new Response(JSON.stringify({ error: 'directory_password_required' }), {
                    status: 401,
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-store'
                    }
                });
            }
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
