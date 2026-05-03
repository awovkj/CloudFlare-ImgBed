import { getDatabase } from '../../utils/databaseAdapter.js';
import { destroySessionsByAuthType } from '../../utils/auth/sessionManager.js';

export async function onRequestGet(context) {
    const { request, env } = context;
    const resetKey = env.RESET_KEY;

    if (!resetKey || resetKey.trim() === '') {
        return new Response(JSON.stringify({
            error: 'RESET_KEY not configured. Set the RESET_KEY environment variable first.'
        }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!key || key !== resetKey) {
        return new Response(JSON.stringify({ error: 'Invalid reset key' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    try {
        const db = getDatabase(env);
        const settingsStr = await db.get('manage@sysConfig@security');

        if (settingsStr) {
            const settings = JSON.parse(settingsStr);
            delete settings.auth;
            await db.put('manage@sysConfig@security', JSON.stringify(settings));
        }

        const adminDestroyed = await destroySessionsByAuthType(env, 'admin');
        const userDestroyed = await destroySessionsByAuthType(env, 'user');

        return new Response(JSON.stringify({
            success: true,
            message: 'Auth credentials reset. Other security settings preserved. All sessions cleared.',
            sessionsCleared: { admin: adminDestroyed, user: userDestroyed }
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        return new Response(JSON.stringify({
            error: 'Reset failed: ' + error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
