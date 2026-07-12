import assert from 'node:assert/strict';
import fs from 'node:fs';

import { onRequestPost as login } from '../functions/api/music/login.js';
import { onRequestPost as logout } from '../functions/api/music/logout.js';
import { onRequestGet as session } from '../functions/api/music/session.js';
import { createSession } from '../functions/utils/auth/sessionManager.js';

const CONFIG_KEY = 'manage@sysConfig@others';
const FAILURE_PREFIX = 'manage@musicLoginFailure@';
const SESSION_PREFIX = 'manage@session@';

function createEnv(musicPlayer = {}, initial = {}) {
  const entries = new Map(Object.entries(initial));
  const putOptions = new Map();
  entries.set(CONFIG_KEY, JSON.stringify({ musicPlayer }));

  const kv = {
    async get(key) { return entries.get(key) ?? null; },
    async put(key, value, options = {}) {
      entries.set(key, value);
      putOptions.set(key, options);
    },
    async delete(key) { entries.delete(key); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...entries.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };

  return { env: { img_url: kv }, entries, putOptions };
}

function context(handler, env, path, { method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  let requestBody;
  if (body !== undefined) {
    requestHeaders.set('Content-Type', 'application/json');
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return handler({
    env,
    request: new Request(`https://example.test${path}`, {
      method,
      headers: requestHeaders,
      body: requestBody,
    }),
  });
}

function assertNoStore(response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

describe('music auth API', () => {
  it('returns 403 when Music is disabled and 503 when its password is missing', async () => {
    const disabled = createEnv({ enabled: false });
    const disabledResponse = await context(login, disabled.env, '/api/music/login', {
      method: 'POST', body: { password: 'secret' },
    });
    assert.equal(disabledResponse.status, 403);
    assertNoStore(disabledResponse);

    const missing = createEnv({ enabled: true });
    const missingResponse = await context(login, missing.env, '/api/music/login', {
      method: 'POST', body: { password: 'secret' },
    });
    assert.equal(missingResponse.status, 503);
    assertNoStore(missingResponse);
  });

  it('returns 400 for malformed JSON', async () => {
    const { env } = createEnv({ enabled: true, passwordHash: 'secret' });
    const response = await context(login, env, '/api/music/login', {
      method: 'POST', body: '{not-json',
    });
    assert.equal(response.status, 400);
    assertNoStore(response);
  });

  it('records wrong passwords by preferred client IP and sets no cookie', async () => {
    const { env, entries } = createEnv({ enabled: true, passwordHash: 'secret' });
    const response = await context(login, env, '/api/music/login', {
      method: 'POST',
      body: { password: 'wrong' },
      headers: { 'cf-connecting-ip': '203.0.113.4', 'x-forwarded-for': '198.51.100.1' },
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers.has('Set-Cookie'), false);
    assert.deepEqual(await response.json(), { error: 'Invalid password' });
    assert.equal(JSON.parse(entries.get(`${FAILURE_PREFIX}203.0.113.4`)).count, 1);
    assert.equal(entries.has(`${FAILURE_PREFIX}198.51.100.1`), false);
    assertNoStore(response);
  });

  it('falls back to the first forwarded IP and then unknown', async () => {
    const { env, entries } = createEnv({ enabled: true, passwordHash: 'secret' });
    await context(login, env, '/api/music/login', {
      method: 'POST', body: { password: 'wrong' }, headers: { 'x-forwarded-for': '198.51.100.8, 10.0.0.1' },
    });
    await context(login, env, '/api/music/login', {
      method: 'POST', body: { password: 'wrong' },
    });
    assert.equal(JSON.parse(entries.get(`${FAILURE_PREFIX}198.51.100.8`)).count, 1);
    assert.equal(JSON.parse(entries.get(`${FAILURE_PREFIX}unknown`)).count, 1);
  });

  it('blocks the sixth attempt before password verification and includes Retry-After', async () => {
    const { env } = createEnv({ enabled: true, passwordHash: 'secret' });
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await context(login, env, '/api/music/login', {
        method: 'POST', body: { password: 'wrong' }, headers,
      });
      assert.equal(response.status, 401);
    }

    const blocked = await context(login, env, '/api/music/login', {
      method: 'POST', body: { password: 'secret' }, headers,
    });
    assert.equal(blocked.status, 429);
    assert.match(blocked.headers.get('Retry-After'), /^\d+$/);
    assertNoStore(blocked);
  });

  it('creates a seven-day Music session and clears failures after a correct password', async () => {
    const ip = '198.51.100.77';
    const { env, entries, putOptions } = createEnv({ enabled: true, passwordHash: 'secret' });
    await context(login, env, '/api/music/login', {
      method: 'POST', body: { password: 'wrong' }, headers: { 'cf-connecting-ip': ip },
    });

    const response = await context(login, env, '/api/music/login', {
      method: 'POST', body: { password: 'secret' }, headers: { 'cf-connecting-ip': ip },
    });
    const cookie = response.headers.get('Set-Cookie');
    const token = cookie.match(/^music_session=([^;]+)/)[1];

    assert.equal(response.status, 200);
    assert.match(cookie, /Max-Age=604800/);
    assert.equal(JSON.parse(entries.get(`${SESSION_PREFIX}${token}`)).authType, 'music');
    assert.equal(putOptions.get(`${SESSION_PREFIX}${token}`).expirationTtl, 604800);
    assert.equal(entries.has(`${FAILURE_PREFIX}${ip}`), false);
    assertNoStore(response);
  });

  it('reports only valid for Music/admin sessions and false for user/invalid sessions', async () => {
    const { env } = createEnv({ enabled: true, passwordHash: 'secret' });
    const musicSession = await createSession(env, 'music');
    const adminSession = await createSession(env, 'admin');
    const userSession = await createSession(env, 'user');

    for (const cookie of [musicSession.cookie, adminSession.cookie]) {
      const response = await context(session, env, '/api/music/session', { headers: { Cookie: cookie } });
      assert.deepEqual(await response.json(), { valid: true });
      assertNoStore(response);
    }
    for (const cookie of [userSession.cookie, 'music_session=invalid']) {
      const response = await context(session, env, '/api/music/session', { headers: { Cookie: cookie } });
      assert.deepEqual(await response.json(), { valid: false });
      assertNoStore(response);
    }
  });

  it('logs out only the Music session and expires its cookie', async () => {
    const { env, entries } = createEnv({ enabled: true, passwordHash: 'secret' });
    const musicSession = await createSession(env, 'music');
    const adminSession = await createSession(env, 'admin');
    const response = await context(logout, env, '/api/music/logout', {
      method: 'POST', headers: { Cookie: `${musicSession.cookie}; ${adminSession.cookie}` },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /^music_session=;/);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal(entries.has(`${SESSION_PREFIX}${musicSession.token}`), false);
    assert.equal(entries.has(`${SESSION_PREFIX}${adminSession.token}`), true);
    assertNoStore(response);
  });

  it('registers the three Worker routes with method guards', () => {
    const source = fs.readFileSync('src/worker.js', 'utf8');
    assert.match(source, /import \{ onRequestPost as onMusicLoginPost \}[^;]+music\/login\.js/);
    assert.match(source, /import \{ onRequestPost as onMusicLogoutPost \}[^;]+music\/logout\.js/);
    assert.match(source, /import \{ onRequestGet as onMusicSessionGet \}[^;]+music\/session\.js/);
    assert.match(source, /'\/api\/music\/login'\s*,\s*\[checkDatabaseConfig, postOnly\(onMusicLoginPost\)\]/);
    assert.match(source, /'\/api\/music\/logout'\s*,\s*\[checkDatabaseConfig, postOnly\(onMusicLogoutPost\)\]/);
    assert.match(source, /'\/api\/music\/session'\s*,\s*\[checkDatabaseConfig, getOnly\(onMusicSessionGet\)\]/);
  });
});
