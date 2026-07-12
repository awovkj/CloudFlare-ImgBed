import assert from 'node:assert/strict';

import { getMusicAccessState } from '../functions/utils/auth/musicAuth.js';
import {
  checkMusicLoginRateLimit,
  clearMusicLoginFailures,
  recordMusicLoginFailure,
} from '../functions/utils/auth/musicLoginRateLimit.js';

const CONFIG_KEY = 'manage@sysConfig@others';
const SESSION_PREFIX = 'manage@session@';

function createEnv({ musicPlayer, entries: initialEntries = {}, getError = null } = {}) {
  const entries = new Map(Object.entries(initialEntries));
  const putOptions = new Map();

  if (musicPlayer !== undefined) {
    entries.set(CONFIG_KEY, JSON.stringify({ musicPlayer }));
  }

  const kv = {
    async get(key) {
      if (getError) throw getError;
      return entries.get(key) ?? null;
    },
    async put(key, value, options = {}) {
      entries.set(key, value);
      putOptions.set(key, options);
    },
    async delete(key) {
      entries.delete(key);
    },
  };

  return { env: { img_url: kv }, entries, putOptions };
}

function session(authType) {
  return JSON.stringify({ authType, expiresAt: Date.now() + 60_000 });
}

function requestWithCookie(cookie) {
  return new Request('https://example.test/music', {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
}

describe('music authorization helper', () => {
  it('fails closed when the Music configuration cannot be loaded', async () => {
    const { env } = createEnv({ getError: new Error('database unavailable') });
    const originalConsoleError = console.error;
    console.error = () => {};
    let result;
    try {
      result = await getMusicAccessState(env, requestWithCookie());
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(result, {
      state: 'config_unavailable',
      authorized: false,
      authType: null,
    });
  });

  it('reports disabled before checking password or sessions', async () => {
    const { env } = createEnv({ musicPlayer: { enabled: false } });

    const result = await getMusicAccessState(env, requestWithCookie('admin_session=ignored'));

    assert.deepEqual(result, { state: 'disabled', authorized: false, authType: null });
  });

  it('reports a missing password before checking sessions', async () => {
    const { env } = createEnv({ musicPlayer: { enabled: true } });

    const result = await getMusicAccessState(env, requestWithCookie('admin_session=ignored'));

    assert.deepEqual(result, { state: 'password_missing', authorized: false, authType: null });
  });

  it('authorizes an admin session', async () => {
    const { env } = createEnv({
      musicPlayer: { enabled: true, passwordHash: 'configured-hash' },
      entries: { [`${SESSION_PREFIX}admin-token`]: session('admin') },
    });

    const result = await getMusicAccessState(
      env,
      requestWithCookie('user_session=wrong; admin_session=admin-token'),
    );

    assert.deepEqual(result, { state: 'authorized', authorized: true, authType: 'admin' });
  });

  it('authorizes a Music session', async () => {
    const { env } = createEnv({
      musicPlayer: { enabled: true, passwordHash: 'configured-hash' },
      entries: { [`${SESSION_PREFIX}music-token`]: session('music') },
    });

    const result = await getMusicAccessState(env, requestWithCookie('music_session=music-token'));

    assert.deepEqual(result, { state: 'authorized', authorized: true, authType: 'music' });
  });

  it('rejects a normal user session and unauthenticated requests', async () => {
    const { env } = createEnv({
      musicPlayer: { enabled: true, passwordHash: 'configured-hash' },
      entries: { [`${SESSION_PREFIX}user-token`]: session('user') },
    });

    const userResult = await getMusicAccessState(env, requestWithCookie('user_session=user-token'));
    const anonymousResult = await getMusicAccessState(env, requestWithCookie());

    assert.deepEqual(userResult, { state: 'unauthorized', authorized: false, authType: null });
    assert.deepEqual(anonymousResult, { state: 'unauthorized', authorized: false, authType: null });
  });
});

describe('music login rate limiter', () => {
  it('blocks an IP after five failures in ten minutes and stores only counter metadata', async () => {
    const { env, entries, putOptions } = createEnv();
    const ip = '203.0.113.42';

    for (let i = 0; i < 5; i++) {
      await recordMusicLoginFailure(env, ip);
    }

    const result = await checkMusicLoginRateLimit(env, ip);
    const [key] = [...entries.keys()];
    const stored = JSON.parse(entries.get(key));

    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
    assert.equal(stored.count, 5);
    assert.equal(typeof stored.windowStartedAt, 'number');
    assert.deepEqual(Object.keys(stored).sort(), ['count', 'windowStartedAt']);
    assert.equal(putOptions.get(key).expirationTtl, 10 * 60);
  });

  it('manually expires stale counters even when the database ignores TTL options', async () => {
    const { env, entries } = createEnv();
    const ip = '2001:db8::1';

    await recordMusicLoginFailure(env, ip);
    const [key] = [...entries.keys()];
    entries.set(key, JSON.stringify({
      windowStartedAt: Date.now() - (10 * 60 * 1000) - 1,
      count: 5,
    }));

    const expired = await checkMusicLoginRateLimit(env, ip);
    assert.equal(expired.allowed, true);
    assert.equal(expired.remaining, 5);
    assert.equal(entries.has(key), false);

    await recordMusicLoginFailure(env, ip);
    assert.equal(JSON.parse(entries.get(key)).count, 1);
  });

  it('clears failure counters after a successful login', async () => {
    const { env } = createEnv();
    const ip = '198.51.100.7';

    for (let i = 0; i < 5; i++) {
      await recordMusicLoginFailure(env, ip);
    }
    assert.equal((await checkMusicLoginRateLimit(env, ip)).allowed, false);

    await clearMusicLoginFailures(env, ip);

    assert.equal((await checkMusicLoginRateLimit(env, ip)).allowed, true);
  });
});
