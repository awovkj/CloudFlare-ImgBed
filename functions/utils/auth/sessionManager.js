import { generateSessionToken } from './passwordHash.js';
import { getDatabase } from '../databaseAdapter.js';
import { fetchSecurityConfig } from '../sysConfig.js';

const SESSION_PREFIX = 'manage@session@';

const COOKIE_NAMES = {
    admin: 'admin_session',
    user: 'user_session',
};

export async function createSession(env, authType, username = '') {
    const securityConfig = await fetchSecurityConfig(env);
    const accessConfig = securityConfig.access || {};
    const secure = accessConfig.sessionSecure ?? false;
    const maxAgeDays = authType === 'admin'
        ? (accessConfig.adminSessionMaxAge ?? 14)
        : (accessConfig.userSessionMaxAge ?? 14);
    const maxAge = maxAgeDays * 86400;

    const db = getDatabase(env);
    const token = generateSessionToken();
    const sessionData = {
        authType,
        username,
        createdAt: Date.now(),
        expiresAt: Date.now() + maxAge * 1000,
    };

    await db.put(`${SESSION_PREFIX}${token}`, JSON.stringify(sessionData), {
        expirationTtl: maxAge,
    });

    return {
        token,
        cookie: buildSessionCookie(COOKIE_NAMES[authType] || 'session', token, maxAge, secure),
    };
}

export async function validateSession(env, request, authType) {
    const token = getCookieValue(request, COOKIE_NAMES[authType] || 'session');
    if (!token) {
        return { valid: false };
    }

    const db = getDatabase(env);
    const sessionStr = await db.get(`${SESSION_PREFIX}${token}`);
    if (!sessionStr) {
        return { valid: false };
    }

    try {
        const session = JSON.parse(sessionStr);
        if (session.authType !== authType) {
            return { valid: false };
        }

        if (Date.now() > session.expiresAt) {
            await db.delete(`${SESSION_PREFIX}${token}`);
            return { valid: false };
        }

        return { valid: true, session };
    } catch {
        return { valid: false };
    }
}

export async function validateAnySession(env, request) {
    const adminResult = await validateSession(env, request, 'admin');
    if (adminResult.valid) {
        return adminResult;
    }

    const userResult = await validateSession(env, request, 'user');
    if (userResult.valid) {
        return userResult;
    }

    return { valid: false };
}

export async function destroySession(env, request, authType) {
    const securityConfig = await fetchSecurityConfig(env);
    const secure = securityConfig.access?.sessionSecure ?? false;
    const db = getDatabase(env);

    if (authType) {
        const cookieName = COOKIE_NAMES[authType] || 'session';
        const token = getCookieValue(request, cookieName);
        if (token) {
            await db.delete(`${SESSION_PREFIX}${token}`);
        }
        return buildSessionCookie(cookieName, '', 0, secure);
    }

    const cookies = [];
    for (const cookieName of Object.values(COOKIE_NAMES)) {
        const token = getCookieValue(request, cookieName);
        if (token) {
            await db.delete(`${SESSION_PREFIX}${token}`);
        }
        cookies.push(buildSessionCookie(cookieName, '', 0, secure));
    }

    return cookies;
}

export async function destroySessionsByAuthType(env, authType) {
    const db = getDatabase(env);
    let destroyed = 0;
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
        const listOptions = { prefix: SESSION_PREFIX };
        if (cursor) {
            listOptions.cursor = cursor;
        }

        const result = await db.list(listOptions);
        const keys = result.keys || [];

        for (const key of keys) {
            try {
                const sessionStr = await db.get(key.name);
                if (sessionStr) {
                    const session = JSON.parse(sessionStr);
                    if (session.authType === authType) {
                        await db.delete(key.name);
                        destroyed++;
                    }
                }
            } catch {
                await db.delete(key.name);
                destroyed++;
            }
        }

        cursor = result.cursor;
        hasMore = !result.list_complete && cursor;
    }

    return destroyed;
}

function getCookieValue(request, name) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) {
        return null;
    }

    const match = cookieHeader.match(new RegExp(`(^|;\\s*)${name}=([^;]+)`));
    return match ? match[2] : null;
}

function buildSessionCookie(name, token, maxAge, secure = false) {
    const parts = [
        `${name}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAge}`,
    ];

    if (secure) {
        parts.push('Secure');
    }

    return parts.join('; ');
}
