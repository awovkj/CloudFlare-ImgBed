import assert from 'node:assert/strict';

import {
  createSession,
  destroySession,
  destroySessionsByAuthType,
  validateSession,
} from '../functions/utils/auth/sessionManager.js';

const MUSIC_TTL = 7 * 24 * 60 * 60;

function createEnv(access = {}) {
  const entries = new Map();
  const putOptions = new Map();

  entries.set('manage@sysConfig@security', JSON.stringify({ access }));

  const kv = {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value, options = {}) {
      entries.set(key, value);
      putOptions.set(key, options);
    },
    async delete(key) {
      entries.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...entries.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      };
    },
  };

  return { env: { img_url: kv }, entries, putOptions };
}

function sessionKey(token) {
  return `manage@session@${token}`;
}

describe('music session type', () => {
  it('creates a fixed seven-day Secure SameSite=Lax music_session', async () => {
    const { env, entries, putOptions } = createEnv({
      sessionSecure: false,
      userSessionMaxAge: 3,
      adminSessionMaxAge: 5,
    });

    const { token, cookie } = await createSession(env, 'music');
    const stored = JSON.parse(entries.get(sessionKey(token)));

    assert.equal(stored.authType, 'music');
    assert.equal(putOptions.get(sessionKey(token)).expirationTtl, MUSIC_TTL);
    assert.match(cookie, /^music_session=/);
    assert.match(cookie, /; Path=\/(?:;|$)/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Lax;/);
    assert.match(cookie, /; Max-Age=604800(?:;|$)/);
    assert.match(cookie, /; Secure(?:;|$)/);
  });

  it('keeps configured admin and user cookie behavior unchanged', async () => {
    const { env, putOptions } = createEnv({
      sessionSecure: false,
      userSessionMaxAge: 3,
      adminSessionMaxAge: 5,
    });

    const admin = await createSession(env, 'admin');
    const user = await createSession(env, 'user');

    assert.equal(putOptions.get(sessionKey(admin.token)).expirationTtl, 5 * 86400);
    assert.match(admin.cookie, /^admin_session=/);
    assert.match(admin.cookie, /; SameSite=Strict;/);
    assert.doesNotMatch(admin.cookie, /; Secure(?:;|$)/);

    assert.equal(putOptions.get(sessionKey(user.token)).expirationTtl, 3 * 86400);
    assert.match(user.cookie, /^user_session=/);
    assert.match(user.cookie, /; SameSite=Strict;/);
    assert.doesNotMatch(user.cookie, /; Secure(?:;|$)/);
  });

  it('validates music_session independently from other session cookies', async () => {
    const { env } = createEnv();
    const { token } = await createSession(env, 'music');
    const request = new Request('https://example.test/music', {
      headers: { Cookie: `admin_session=wrong; music_session=${token}` },
    });

    const result = await validateSession(env, request, 'music');

    assert.equal(result.valid, true);
    assert.equal(result.session.authType, 'music');
    assert.equal((await validateSession(env, request, 'admin')).valid, false);
  });

  it('destroys a music session and clears it with the music cookie policy', async () => {
    const { env, entries } = createEnv({ sessionSecure: false });
    const { token } = await createSession(env, 'music');
    const request = new Request('https://example.test/music', {
      headers: { Cookie: `music_session=${token}` },
    });

    const cookie = await destroySession(env, request, 'music');

    assert.equal(entries.has(sessionKey(token)), false);
    assert.match(cookie, /^music_session=;/);
    assert.match(cookie, /; SameSite=Lax;/);
    assert.match(cookie, /; Max-Age=0(?:;|$)/);
    assert.match(cookie, /; Secure(?:;|$)/);
  });

  it('bulk-destroys only music sessions when requested', async () => {
    const { env, entries } = createEnv();
    const music = await createSession(env, 'music');
    const admin = await createSession(env, 'admin');
    const user = await createSession(env, 'user');

    const destroyed = await destroySessionsByAuthType(env, 'music');

    assert.equal(destroyed, 1);
    assert.equal(entries.has(sessionKey(music.token)), false);
    assert.equal(entries.has(sessionKey(admin.token)), true);
    assert.equal(entries.has(sessionKey(user.token)), true);
  });
});
