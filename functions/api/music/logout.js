import { destroySession } from '../../utils/auth/sessionManager.js';

export async function onRequestPost({ request, env }) {
    const cookie = await destroySession(env, request, 'music');
    return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': 'no-store',
            'Set-Cookie': cookie,
        },
    });
}
