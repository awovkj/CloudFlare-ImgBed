import { fetchOthersConfig } from '../utils/sysConfig.js';
import { userAuthCheck, UnauthorizedResponse } from '../utils/userAuth.js';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (url.pathname !== '/chat' && url.pathname !== '/chat/') {
        return new Response('Not Found', { status: 404 });
    }

    try {
        const othersConfig = await fetchOthersConfig(env);
        const chatConfig = othersConfig.chatPage || {};

        if (!chatConfig.enabled) {
            return new Response('Chat page is disabled', { status: 403 });
        }

        if (!await userAuthCheck(env, url, request)) {
            return UnauthorizedResponse('Unauthorized');
        }

        const chatHtmlUrl = new URL('/chat.html', request.url);
        const chatHtml = await env.ASSETS.fetch(new Request(chatHtmlUrl.toString(), request));

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
