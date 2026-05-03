import { destroySession } from '../../utils/auth/sessionManager.js';

export async function onRequestPost(context) {
    const { request, env } = context;

    let authType = null;
    try {
        const body = await request.json();
        authType = body.authType || null;
    } catch {
        authType = null;
    }

    const result = await destroySession(env, request, authType);
    const headers = new Headers();

    if (Array.isArray(result)) {
        result.forEach((cookie) => headers.append('Set-Cookie', cookie));
    } else {
        headers.set('Set-Cookie', result);
    }

    return new Response('Logged out', {
        status: 200,
        headers,
    });
}
