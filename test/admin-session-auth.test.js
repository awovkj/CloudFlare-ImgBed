import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { onRequest as checkAdmin } from '../functions/api/manage/check.js';
import { onRequest as saveOthers } from '../functions/api/manage/sysConfig/others.js';
import { onRequest as saveSecurity } from '../functions/api/manage/sysConfig/security.js';
import { onRequest as manageMiddleware } from '../functions/api/manage/_middleware.js';

const SECURITY_KEY = 'manage@sysConfig@security';
const SESSION_PREFIX = 'manage@session@';
const logoutPatch = 'scripts/patch-admin-session.mjs';

function createEnv(security = {}) {
  const entries = new Map([[SECURITY_KEY, JSON.stringify(security)]]);
  const kv = {
    async get(key) { return entries.get(key) ?? null; },
    async put(key, value) { entries.set(key, value); },
    async delete(key) { entries.delete(key); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...entries.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true,
      };
    },
  };
  return { env: { img_url: kv }, entries };
}

function cookieToken(cookie) {
  return cookie?.match(/^admin_session=([^;]+)/)?.[1] || null;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function runManage(env, request, handler) {
  const chain = [...(Array.isArray(manageMiddleware) ? manageMiddleware : [manageMiddleware]), handler];
  const context = {
    env,
    request,
    data: {},
    params: {},
    waitUntil() {},
  };
  let index = 0;
  context.next = async () => {
    const current = chain[index++];
    return current ? current(context) : new Response('Not Found', { status: 404 });
  };
  return context.next();
}

describe('admin session authentication', () => {
  it('upgrades a successful Basic check to an HttpOnly admin session', async () => {
    const { env, entries } = createEnv({
      auth: {
        user: { authCode: '' },
        admin: { adminUsername: 'admin', adminPassword: 'secret' },
      },
      access: { adminSessionMaxAge: 14 },
    });
    const credentials = Buffer.from('admin:secret').toString('base64');
    const response = await runManage(
      env,
      new Request('https://example.test/api/manage/check', {
        headers: { Authorization: `Basic ${credentials}` },
      }),
      checkAdmin,
    );

    const cookie = response.headers.get('Set-Cookie');
    const token = cookieToken(cookie);
    assert.equal(response.status, 200);
    assert.ok(token);
    assert.match(cookie, /HttpOnly/);
    assert.equal(JSON.parse(entries.get(`${SESSION_PREFIX}${token}`)).authType, 'admin');

    const saveResponse = await runManage(
      env,
      new Request('https://example.test/api/manage/sysConfig/others', {
        method: 'POST',
        headers: {
          Cookie: `admin_session=${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ showStats: { enabled: false } }),
      }),
      saveOthers,
    );
    assert.equal(saveResponse.status, 200);
    assert.equal(JSON.parse(entries.get('manage@sysConfig@others')).showStats.enabled, false);
  });

  it('returns a normal API 401 without a browser Basic challenge', async () => {
    const { env } = createEnv({
      auth: { admin: { adminUsername: 'admin', adminPassword: 'secret' } },
    });
    const response = await runManage(
      env,
      new Request('https://example.test/api/manage/sysConfig/others'),
      async () => new Response('ok'),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.has('WWW-Authenticate'), false);
    assert.deepEqual(await response.json(), { error: 'Authentication required' });
  });

  it('fails closed when authentication settings cannot be loaded', async () => {
    const brokenEnv = {
      img_url: {
        async get() { throw new Error('database unavailable'); },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true }; },
      },
    };
    const response = await runManage(
      brokenEnv,
      new Request('https://example.test/api/manage/sysConfig/others'),
      async () => new Response('must not run'),
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.has('WWW-Authenticate'), false);
    assert.deepEqual(await response.json(), { error: 'Security config unavailable' });
  });

  it('rotates the current admin session after administrator credentials change', async () => {
    const { env, entries } = createEnv({
      auth: {
        user: { authCode: '' },
        admin: { adminUsername: 'old-admin', adminPassword: 'old-password' },
      },
      access: { adminSessionMaxAge: 14 },
    });
    entries.set(`${SESSION_PREFIX}old-token`, JSON.stringify({ authType: 'admin', expiresAt: Date.now() + 60000 }));

    const response = await saveSecurity({
      env,
      request: new Request('https://example.test/api/manage/sysConfig/security', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth: {
            user: { authCode: '' },
            admin: { adminUsername: 'new-admin', adminPassword: '' },
          },
          upload: {},
          access: { adminSessionMaxAge: 14, userSessionMaxAge: 14 },
        }),
      }),
      data: { auth: { method: 'session' } },
    });

    const payload = await response.json();
    const token = cookieToken(response.headers.get('Set-Cookie'));
    assert.equal(payload.adminCredentialsChanged, true);
    assert.equal(entries.has(`${SESSION_PREFIX}old-token`), false);
    assert.ok(token);
    assert.equal(JSON.parse(entries.get(`${SESSION_PREFIX}${token}`)).authType, 'admin');
  });

  it('keeps the logout bundle patch idempotent and wired into asset copying', () => {
    const targets = ['js/128.a59bdcad.js', 'js/443.08e0d7c5.js', 'js/601.e77ce138.js'];
    const first = spawnSync(process.execPath, [logoutPatch], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstHashes = targets.map(hash);
    const second = spawnSync(process.execPath, [logoutPatch], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(targets.map(hash), firstHashes);

    for (const target of targets) {
      const source = fs.readFileSync(target, 'utf8');
      assert.match(source, /fetch\("\/api\/auth\/logout",\{method:"POST",credentials:"same-origin"/);
    }
    assert.match(fs.readFileSync('scripts/copy-assets.mjs', 'utf8'), /patch-admin-session\.mjs/);
  });
});
