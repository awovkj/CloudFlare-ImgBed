import { fetchOthersConfig } from '../utils/sysConfig.js';
import { userAuthCheck, UnauthorizedResponse } from '../utils/userAuth.js';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (url.pathname !== '/music' && url.pathname !== '/music/' && url.pathname !== '/music.html') {
        return new Response('Not Found', { status: 404 });
    }

    // /music.html 重定向到 /music，避免绕过 enabled/auth 检查直接命中静态资源
    if (url.pathname === '/music.html') {
        const redirectUrl = new URL('/music', request.url);
        if (url.search) {
            redirectUrl.search = url.search;
        }
        return Response.redirect(redirectUrl.toString(), 302);
    }

    try {
        const othersConfig = await fetchOthersConfig(env);
        const musicConfig = othersConfig.musicPlayer || {};

        if (!musicConfig.enabled) {
            return new Response('Music player is disabled', { status: 403 });
        }

        // 客户端认证检查
        if (!await userAuthCheck(env, url, request)) {
            return UnauthorizedResponse('Unauthorized');
        }

        const musicHtmlUrl = new URL('/music.html', request.url);
        const musicHtml = await env.ASSETS.fetch(new Request(musicHtmlUrl.toString(), request));

        if (musicHtml.ok) {
            const html = await musicHtml.text();
            return new Response(html, {
                status: 200,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                }
            });
        } else {
            return new Response('Music page not found', { status: 404 });
        }
    } catch (error) {
        console.error('Error serving music.html:', error);
        return new Response('Internal server error', { status: 500 });
    }
}
