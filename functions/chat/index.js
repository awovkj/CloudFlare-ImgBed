import { fetchOthersConfig } from '../utils/sysConfig.js';
import { userAuthCheck, UnauthorizedResponse } from '../utils/auth/userAuth.js';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (url.pathname !== '/chat' && url.pathname !== '/chat/' && url.pathname !== '/chat.html') {
        return new Response('Not Found', { status: 404 });
    }

    if (url.pathname === '/chat.html') {
        const redirectUrl = new URL('/chat', request.url);
        if (url.search) {
            redirectUrl.search = url.search;
        }
        return Response.redirect(redirectUrl.toString(), 302);
    }

    try {
        const othersConfig = await fetchOthersConfig(env);
        const chatConfig = othersConfig.chatPage || {};

        if (!chatConfig.enabled) {
            return new Response('Chat page is disabled', { status: 403 });
        }

        if (!await userAuthCheck(env, url, request, 'upload')) {
            return UnauthorizedResponse('Unauthorized');
        }

        const chatHtmlUrl = new URL('/chat.html', request.url);
        const assetRequest = new Request(chatHtmlUrl.toString(), {
            method: 'GET',
            headers: request.headers,
        });
        const chatHtml = await env.ASSETS.fetch(assetRequest);

        if (!chatHtml.ok) {
            return new Response('Chat page not found', { status: 404 });
        }

        const html = await chatHtml.text();
        return new Response(html, {
            status: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
            }
        });
    } catch (error) {
        console.error('Error serving chat.html:', error);
        return new Response('Internal server error', { status: 500 });
    }
}
