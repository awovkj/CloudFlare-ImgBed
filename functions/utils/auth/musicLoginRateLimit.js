import { getDatabase } from '../databaseAdapter.js';

const FAILURE_LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_TTL_SECONDS = WINDOW_MS / 1000;
const KEY_PREFIX = 'manage@musicLoginFailure@';

function failureKey(ip) {
    return `${KEY_PREFIX}${encodeURIComponent(String(ip || 'unknown'))}`;
}

function parseCounter(value) {
    if (!value) return null;

    try {
        const counter = JSON.parse(value);
        if (!Number.isFinite(counter.windowStartedAt) || !Number.isInteger(counter.count) || counter.count < 0) {
            return null;
        }
        return counter;
    } catch {
        return null;
    }
}

function isExpired(counter, now) {
    return !counter || now - counter.windowStartedAt >= WINDOW_MS;
}

export async function checkMusicLoginRateLimit(env, ip) {
    const db = getDatabase(env);
    const key = failureKey(ip);
    const storedValue = await db.get(key);
    const counter = parseCounter(storedValue);
    const now = Date.now();

    if (isExpired(counter, now)) {
        if (storedValue !== null) {
            await db.delete(key);
        }
        return { allowed: true, remaining: FAILURE_LIMIT, retryAfter: 0 };
    }

    const remaining = Math.max(0, FAILURE_LIMIT - counter.count);
    return {
        allowed: counter.count < FAILURE_LIMIT,
        remaining,
        retryAfter: Math.max(1, Math.ceil((counter.windowStartedAt + WINDOW_MS - now) / 1000)),
    };
}

export async function recordMusicLoginFailure(env, ip) {
    const db = getDatabase(env);
    const key = failureKey(ip);
    const now = Date.now();
    const current = parseCounter(await db.get(key));
    const counter = isExpired(current, now)
        ? { windowStartedAt: now, count: 1 }
        : { windowStartedAt: current.windowStartedAt, count: current.count + 1 };

    await db.put(key, JSON.stringify(counter), { expirationTtl: WINDOW_TTL_SECONDS });
    return counter;
}

export async function clearMusicLoginFailures(env, ip) {
    const db = getDatabase(env);
    await db.delete(failureKey(ip));
}
