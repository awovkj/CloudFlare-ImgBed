import { validateSession } from '../../utils/auth/sessionManager.js';

export async function onRequestGet({ request, env }) {
    const admin = await validateSession(env, request, 'admin');
    const valid = admin.valid || (await validateSession(env, request, 'music')).valid;
    return new Response(JSON.stringify({ valid }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': 'no-store',
        },
    });
}
