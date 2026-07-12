import { fetchOthersConfig } from '../../utils/sysConfig.js';
import { verifyPassword } from '../../utils/auth/passwordHash.js';
import { createSession } from '../../utils/auth/sessionManager.js';
import {
    checkMusicLoginRateLimit,
    clearMusicLoginFailures,
    recordMusicLoginFailure,
} from '../../utils/auth/musicLoginRateLimit.js';

function json(body, status, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Cache-Control': 'no-store',
            ...headers,
        },
    });
}

function clientIp(request) {
    const cloudflareIp = request.headers.get('cf-connecting-ip')?.trim();
    if (cloudflareIp) return cloudflareIp;

    const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    return forwardedIp || 'unknown';
}

export async function onRequestPost({ request, env }) {
    let musicConfig;
    try {
        const othersConfig = await fetchOthersConfig(env);
        if (othersConfig?.__configSource === 'fallback') {
            return json({ error: 'Music configuration unavailable' }, 503);
        }
        musicConfig = othersConfig?.musicPlayer || {};
    } catch (error) {
        console.error('Failed to load Music configuration:', error);
        return json({ error: 'Music configuration unavailable' }, 503);
    }

    if (!musicConfig.enabled) {
        return json({ error: 'Music is disabled' }, 403);
    }
    if (!musicConfig.passwordHash) {
        return json({ error: 'Music password is not configured' }, 503);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Invalid request body' }, 400);
    }
    if (!body || typeof body.password !== 'string' || body.password.length === 0) {
        return json({ error: 'Invalid request body' }, 400);
    }

    const ip = clientIp(request);
    const rateLimit = await checkMusicLoginRateLimit(env, ip);
    if (!rateLimit.allowed) {
        return json(
            { error: 'Too many login attempts' },
            429,
            { 'Retry-After': String(rateLimit.retryAfter) },
        );
    }

    if (!await verifyPassword(body.password, musicConfig.passwordHash)) {
        await recordMusicLoginFailure(env, ip);
        return json({ error: 'Invalid password' }, 401);
    }

    const { cookie } = await createSession(env, 'music');
    await clearMusicLoginFailures(env, ip);
    return json({ success: true }, 200, { 'Set-Cookie': cookie });
}
