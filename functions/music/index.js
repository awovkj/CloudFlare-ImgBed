import { fetchOthersConfig } from '../utils/sysConfig.js';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    
    if (url.pathname === '/music' || url.pathname === '/music/') {
        try {
            const othersConfig = await fetchOthersConfig(env);
            const musicConfig = othersConfig.musicPlayer || {};

            if (!musicConfig.enabled) {
                return new Response('Music player is disabled', { status: 403 });
            }

            const musicHtmlUrl = new URL('/music.html', request.url);
            const musicHtml = await env.ASSETS.fetch(musicHtmlUrl);
            
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
    
    return new Response('Not Found', { status: 404 });
}
