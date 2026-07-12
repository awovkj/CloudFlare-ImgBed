import assert from 'node:assert/strict';

import { onRequest } from '../functions/api/manage/sysConfig/others.js';
import { verifyPassword } from '../functions/utils/auth/passwordHash.js';
import { fetchOthersConfig } from '../functions/utils/sysConfig.js';

const CONFIG_KEY = 'manage@sysConfig@others';
const SESSION_PREFIX = 'manage@session@';

function createEnv(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const kv = {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value) {
      entries.set(key, value);
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

  return { env: { img_url: kv }, entries };
}

async function request(env, method, body) {
  const response = await onRequest({
    env,
    request: new Request('https://example.test/api/manage/sysConfig/others', {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  });
  return { response, json: await response.json() };
}

function assertPasswordSanitized(payload, configured) {
  assert.equal(payload.musicPlayer.passwordConfigured, configured);
  assert.equal('password' in payload.musicPlayer, false);
  assert.equal('passwordHash' in payload.musicPlayer, false);
  assert.equal('clearPassword' in payload.musicPlayer, false);
}

describe('music password configuration', () => {
  it('hashes a new password, sanitizes POST/GET responses, and keeps the hash available internally', async () => {
    const { env, entries } = createEnv({
      [`${SESSION_PREFIX}music-token`]: JSON.stringify({ authType: 'music' }),
      [`${SESSION_PREFIX}admin-token`]: JSON.stringify({ authType: 'admin' }),
    });

    const posted = await request(env, 'POST', {
      musicPlayer: { enabled: true, musicDir: 'albums', password: 'new-secret' },
    });

    assertPasswordSanitized(posted.json, true);
    const stored = JSON.parse(entries.get(CONFIG_KEY));
    assert.equal(await verifyPassword('new-secret', stored.musicPlayer.passwordHash), true);
    assert.equal('password' in stored.musicPlayer, false);
    assert.equal(entries.has(`${SESSION_PREFIX}music-token`), false);
    assert.equal(entries.has(`${SESSION_PREFIX}admin-token`), true);

    const internal = await fetchOthersConfig(env);
    assert.equal(internal.musicPlayer.passwordHash, stored.musicPlayer.passwordHash);

    const fetched = await request(env, 'GET');
    assertPasswordSanitized(fetched.json, true);
  });

  it('preserves the old hash for an empty password without destroying music sessions', async () => {
    const oldHash = '$pbkdf2$00112233445566778899aabbccddeeff$existing';
    const { env, entries } = createEnv({
      [CONFIG_KEY]: JSON.stringify({
        musicPlayer: { enabled: true, musicDir: 'old', passwordHash: oldHash },
      }),
      [`${SESSION_PREFIX}music-token`]: JSON.stringify({ authType: 'music' }),
    });

    const posted = await request(env, 'POST', {
      musicPlayer: { enabled: true, musicDir: 'new', password: '' },
    });

    assertPasswordSanitized(posted.json, true);
    const stored = JSON.parse(entries.get(CONFIG_KEY));
    assert.equal(stored.musicPlayer.passwordHash, oldHash);
    assert.equal(stored.musicPlayer.musicDir, 'new');
    assert.equal(entries.has(`${SESSION_PREFIX}music-token`), true);
  });

  it('removes the hash and destroys music sessions when clearPassword is set', async () => {
    const { env, entries } = createEnv({
      [CONFIG_KEY]: JSON.stringify({
        musicPlayer: { enabled: true, musicDir: 'albums', passwordHash: 'old-hash' },
      }),
      [`${SESSION_PREFIX}music-token`]: JSON.stringify({ authType: 'music' }),
      [`${SESSION_PREFIX}user-token`]: JSON.stringify({ authType: 'user' }),
    });

    const posted = await request(env, 'POST', {
      musicPlayer: { enabled: true, musicDir: 'albums', clearPassword: true },
    });

    assertPasswordSanitized(posted.json, false);
    const stored = JSON.parse(entries.get(CONFIG_KEY));
    assert.equal('passwordHash' in stored.musicPlayer, false);
    assert.equal('clearPassword' in stored.musicPlayer, false);
    assert.equal(entries.has(`${SESSION_PREFIX}music-token`), false);
    assert.equal(entries.has(`${SESSION_PREFIX}user-token`), true);
  });

  it('ignores truthy non-boolean clearPassword values', async () => {
    const oldHash = '$pbkdf2$00112233445566778899aabbccddeeff$existing';
    const { env, entries } = createEnv({
      [CONFIG_KEY]: JSON.stringify({
        musicPlayer: { enabled: true, musicDir: 'albums', passwordHash: oldHash },
      }),
      [`${SESSION_PREFIX}music-token`]: JSON.stringify({ authType: 'music' }),
    });

    const posted = await request(env, 'POST', {
      musicPlayer: { enabled: true, musicDir: 'albums', clearPassword: 'false' },
    });

    assertPasswordSanitized(posted.json, true);
    const stored = JSON.parse(entries.get(CONFIG_KEY));
    assert.equal(stored.musicPlayer.passwordHash, oldHash);
    assert.equal(entries.has(`${SESSION_PREFIX}music-token`), true);
  });

  it('keeps existing music settings when a POST only changes the password', async () => {
    const { env, entries } = createEnv({
      [CONFIG_KEY]: JSON.stringify({
        musicPlayer: { enabled: true, musicDir: 'albums' },
      }),
    });

    await request(env, 'POST', {
      musicPlayer: { password: 'new-secret' },
    });

    const stored = JSON.parse(entries.get(CONFIG_KEY));
    assert.equal(stored.musicPlayer.enabled, true);
    assert.equal(stored.musicPlayer.musicDir, 'albums');
    assert.equal(await verifyPassword('new-secret', stored.musicPlayer.passwordHash), true);
  });
});
