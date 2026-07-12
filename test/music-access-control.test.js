import assert from 'node:assert/strict';

import { onRequest as musicPage } from '../functions/music/index.js';
import { onRequest as musicList } from '../functions/api/music/list.js';

const CONFIG_KEY = 'manage@sysConfig@others';
const SESSION_PREFIX = 'manage@session@';

function createContext(handler, {
  path = '/music',
  method = 'GET',
  musicPlayer,
  cookie,
  sessionType,
  configError = null,
} = {}) {
  const entries = new Map();
  if (musicPlayer !== undefined) {
    entries.set(CONFIG_KEY, JSON.stringify({ musicPlayer }));
  }
  if (sessionType) {
    const token = `${sessionType}-token`;
    entries.set(`${SESSION_PREFIX}${token}`, JSON.stringify({
      authType: sessionType,
      expiresAt: Date.now() + 60_000,
    }));
    cookie = `${sessionType}_session=${token}`;
  }

  let assetFetches = 0;
  let indexReads = 0;
  const env = {
    img_url: {
      async get(key) {
        if (configError && key === CONFIG_KEY) throw configError;
        return entries.get(key) ?? null;
      },
      async put(key, value) { entries.set(key, value); },
      async delete(key) { entries.delete(key); },
    },
    ASSETS: {
      async fetch(request) {
        assetFetches++;
        assert.equal(request.method, 'GET');
        return new Response('<html><input id="music-password"></html>', {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    },
  };
  const request = new Request(`https://example.test${path}`, {
    method,
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  const context = {
    request,
    env,
    data: {},
    waitUntil() {},
    async next() {
      indexReads++;
      return new Response('unexpected');
    },
  };

  return {
    response: () => handler(context),
    assetFetches: () => assetFetches,
    indexReads: () => indexReads,
  };
}

async function assertNoStore(response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

describe('Music page access control', () => {
  it('redirects /music.html to /music', async () => {
    const ctx = createContext(musicPage, { path: '/music.html?from=bookmark' });
    const response = await ctx.response();

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://example.test/music?from=bookmark');
    await assertNoStore(response);
  });

  for (const [name, options, status] of [
    ['disabled', { musicPlayer: { enabled: false } }, 403],
    ['password missing', { musicPlayer: { enabled: true } }, 503],
    ['configuration unavailable', { configError: new Error('offline') }, 503],
  ]) {
    it(`returns ${status} when Music is ${name}`, async () => {
      const ctx = createContext(musicPage, options);
      const originalError = console.error;
      console.error = () => {};
      try {
        const response = await ctx.response();
        assert.equal(response.status, status);
        await assertNoStore(response);
        assert.equal(ctx.assetFetches(), 0);
      } finally {
        console.error = originalError;
      }
    });
  }

  it('serves the HTML shell with HTTP 401 so anonymous browsers can log in', async () => {
    const ctx = createContext(musicPage, {
      musicPlayer: { enabled: true, passwordHash: 'hash' },
    });
    const response = await ctx.response();

    assert.equal(response.status, 401);
    assert.match(response.headers.get('Content-Type'), /^text\/html/);
    assert.match(await response.text(), /music-password/);
    await assertNoStore(response);
    assert.equal(ctx.assetFetches(), 1);
  });

  it('rejects a normal user session but allows admin and Music sessions', async () => {
    const config = { enabled: true, passwordHash: 'hash' };
    const user = createContext(musicPage, { musicPlayer: config, sessionType: 'user' });
    const admin = createContext(musicPage, { musicPlayer: config, sessionType: 'admin' });
    const music = createContext(musicPage, { musicPlayer: config, sessionType: 'music' });

    const userResponse = await user.response();
    const adminResponse = await admin.response();
    const musicResponse = await music.response();

    assert.equal(userResponse.status, 401);
    assert.equal(adminResponse.status, 200);
    assert.equal(musicResponse.status, 200);
    await assertNoStore(userResponse);
    await assertNoStore(adminResponse);
    await assertNoStore(musicResponse);
  });
});

describe('Music list access control', () => {
  for (const [name, options, status] of [
    ['disabled', { musicPlayer: { enabled: false } }, 403],
    ['password missing', { musicPlayer: { enabled: true } }, 503],
    ['configuration unavailable', { configError: new Error('offline') }, 503],
    ['anonymous', { musicPlayer: { enabled: true, passwordHash: 'hash' } }, 401],
    ['normal user', { musicPlayer: { enabled: true, passwordHash: 'hash' }, sessionType: 'user' }, 401],
  ]) {
    it(`denies ${name} requests with ${status} before reading list data`, async () => {
      const ctx = createContext(musicList, { path: '/api/music/list', ...options });
      const originalError = console.error;
      console.error = () => {};
      try {
        const response = await ctx.response();
        assert.equal(response.status, status);
        await assertNoStore(response);
        assert.equal(ctx.indexReads(), 0);
        const body = await response.json();
        assert.equal('files' in body, false);
      } finally {
        console.error = originalError;
      }
    });
  }
});
