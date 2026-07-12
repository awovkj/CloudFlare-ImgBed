# Music Password Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently configurable Music password, seven-day HttpOnly Music sessions, protected Music APIs, login throttling, and password-free URLs.

**Architecture:** Extend the existing session manager with a `music` auth type and centralize Music access checks in a focused helper. Store only a PBKDF2 password hash in the existing Others configuration, expose only `passwordConfigured` to the admin UI, and protect both the page and list API. Keep the prebuilt frontend reproducible with an idempotent patch script for the admin bundle while editing the standalone `music.html` directly.

**Tech Stack:** Cloudflare Workers, KV/D1 database adapter, Web Fetch API, PBKDF2 helpers, vanilla HTML/JavaScript, prebuilt Vue bundle patching, Mocha and `node:assert`.

---

## File Structure

- Modify `functions/utils/auth/sessionManager.js`: add `music_session`, fixed seven-day TTL, Music cookie policy.
- Create `functions/utils/auth/musicAuth.js`: load Music secret configuration and authorize Music/admin sessions.
- Create `functions/utils/auth/musicLoginRateLimit.js`: five-failure/ten-minute IP throttle.
- Modify `functions/api/manage/sysConfig/others.js`: hash, retain, clear and mask Music password configuration.
- Create `functions/api/music/login.js`, `logout.js`, `session.js`: Music authentication endpoints.
- Modify `functions/music/index.js` and `functions/api/music/list.js`: fail-closed Music authorization.
- Modify `src/worker.js`: register the three Music authentication endpoints.
- Modify `music.html`: Cookie-based login UI, logout, no URL password, noindex metadata.
- Create `scripts/patch-music-admin-password.mjs`: idempotently add the password controls to the compiled admin settings bundle.
- Modify `package.json`: run the admin bundle patch before copying frontend assets.
- Add focused Mocha tests under `test/` and unignore them in `.gitignore`.

### Task 1: Music Session Type

**Files:**
- Modify: `functions/utils/auth/sessionManager.js`
- Create: `test/music-session-manager.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing session test**

Create an in-memory KV environment and assert that `createSession(env, 'music')` writes an `authType: 'music'` record and returns a cookie containing:

```js
assert.match(cookie, /^music_session=/);
assert.match(cookie, /Max-Age=604800/);
assert.match(cookie, /HttpOnly/);
assert.match(cookie, /Secure/);
assert.match(cookie, /SameSite=Lax/);
assert.match(cookie, /Path=\//);
```

Also assert `validateSession`, `destroySession`, and `destroySessionsByAuthType` work for Music without affecting admin/user sessions.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx mocha test/music-session-manager.test.js`

Expected: FAIL because `music` currently falls back to the generic cookie and session duration.

- [ ] **Step 3: Implement Music session policy**

Add:

```js
const MUSIC_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const COOKIE_NAMES = {
  admin: 'admin_session',
  user: 'user_session',
  music: 'music_session',
};
```

For `authType === 'music'`, use the fixed TTL, force `Secure`, and build `SameSite=Lax`. Preserve current behavior for admin/user sessions.

- [ ] **Step 4: Run the session test and verify GREEN**

Run: `npx mocha test/music-session-manager.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore functions/utils/auth/sessionManager.js test/music-session-manager.test.js
git commit -m "feat: add music session type"
```

### Task 2: Secure Music Password Configuration

**Files:**
- Modify: `functions/api/manage/sysConfig/others.js`
- Create: `test/music-config-password.test.js`

- [ ] **Step 1: Write failing configuration tests**

Call `onRequest()` with an in-memory database and verify:

```js
assert.equal(getPayload.musicPlayer.passwordConfigured, true);
assert.equal('passwordHash' in getPayload.musicPlayer, false);
assert.equal('password' in getPayload.musicPlayer, false);
assert.equal(await verifyPassword('secret', persisted.musicPlayer.passwordHash), true);
```

Add cases proving an empty password preserves the existing hash, `clearPassword: true` deletes it, and changing/clearing the password deletes existing `authType: 'music'` sessions.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx mocha test/music-config-password.test.js`

Expected: FAIL because POST currently stores the request body directly and GET has no password state.

- [ ] **Step 3: Implement secret-safe configuration handling**

Import `hashPassword` and `destroySessionsByAuthType`. On POST, read the existing raw JSON, remove transient `password`, `clearPassword`, and `passwordConfigured` fields, then:

```js
if (clearPassword === true) delete settings.musicPlayer.passwordHash;
else if (typeof password === 'string' && password.length > 0) {
  settings.musicPlayer.passwordHash = await hashPassword(password);
} else if (existingHash) {
  settings.musicPlayer.passwordHash = existingHash;
}
```

Invalidate Music sessions only when the password changes or is cleared. Keep `getOthersConfig()` suitable for internal server use with `passwordHash`, but sanitize the management GET/POST response to expose only `passwordConfigured`.

- [ ] **Step 4: Run the configuration test and verify GREEN**

Run: `npx mocha test/music-config-password.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add functions/api/manage/sysConfig/others.js test/music-config-password.test.js
git commit -m "feat: configure music password securely"
```

### Task 3: Music Authorization and Login Throttling

**Files:**
- Create: `functions/utils/auth/musicAuth.js`
- Create: `functions/utils/auth/musicLoginRateLimit.js`
- Create: `test/music-auth-helpers.test.js`

- [ ] **Step 1: Write failing helper tests**

Test that the authorization helper returns distinct states for disabled, missing password, unauthorized, Music-session authorized and admin-session authorized configurations. Confirm a normal `user_session` is rejected.

Test the limiter contract:

```js
for (let i = 0; i < 5; i++) await recordMusicLoginFailure(env, ip);
assert.equal((await checkMusicLoginRateLimit(env, ip)).allowed, false);
await clearMusicLoginFailures(env, ip);
assert.equal((await checkMusicLoginRateLimit(env, ip)).allowed, true);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx mocha test/music-auth-helpers.test.js`

Expected: FAIL because the helper modules do not exist.

- [ ] **Step 3: Implement centralized authorization**

`musicAuth.js` must export `getMusicAccessState(env, request)` and check in this order:

1. Configuration loaded successfully; otherwise `config_unavailable`.
2. `musicPlayer.enabled`; otherwise `disabled`.
3. `musicPlayer.passwordHash`; otherwise `password_missing`.
4. Valid admin session; authorize.
5. Valid Music session; authorize.
6. Otherwise `unauthorized`.

`musicLoginRateLimit.js` must store a TTL-bound JSON counter under a key derived from the request IP, allow five failures per ten-minute window, never store the submitted password, and delete the counter after successful login.

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run: `npx mocha test/music-auth-helpers.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add functions/utils/auth/musicAuth.js functions/utils/auth/musicLoginRateLimit.js test/music-auth-helpers.test.js
git commit -m "feat: add music authorization helpers"
```

### Task 4: Music Login, Logout and Session APIs

**Files:**
- Create: `functions/api/music/login.js`
- Create: `functions/api/music/logout.js`
- Create: `functions/api/music/session.js`
- Modify: `src/worker.js`
- Create: `test/music-auth-api.test.js`

- [ ] **Step 1: Write failing endpoint tests**

Using real `Request` objects and in-memory KV, verify:

- disabled Music returns 403;
- enabled without a password returns 503;
- malformed JSON returns 400;
- wrong password returns 401 without `Set-Cookie`;
- the sixth blocked attempt returns 429;
- the correct password returns 200 and a seven-day `music_session`;
- session endpoint reports valid/invalid without leaking session tokens;
- logout deletes the session and returns an expired Music cookie;
- `src/worker.js` registers all three routes with `postOnly`/`getOnly`.

- [ ] **Step 2: Run the endpoint test and verify RED**

Run: `npx mocha test/music-auth-api.test.js`

Expected: FAIL because handlers and routes do not exist.

- [ ] **Step 3: Implement the endpoints**

`login.js` parses `{ password }`, checks configuration and rate limit, calls `verifyPassword`, records failures, clears failures on success, and calls `createSession(env, 'music')`.

`logout.js` calls `destroySession(env, request, 'music')`.

`session.js` accepts a valid Music or admin session and returns only:

```json
{ "valid": true }
```

or:

```json
{ "valid": false }
```

All responses use `Cache-Control: no-store`.

- [ ] **Step 4: Register Worker routes**

Add imports and static routes:

```js
['/api/music/login', [checkDatabaseConfig, postOnly(onMusicLoginPost)]],
['/api/music/logout', [checkDatabaseConfig, postOnly(onMusicLogoutPost)]],
['/api/music/session', [checkDatabaseConfig, getOnly(onMusicSessionGet)]],
```

- [ ] **Step 5: Run the endpoint test and verify GREEN**

Run: `npx mocha test/music-auth-api.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add functions/api/music/login.js functions/api/music/logout.js functions/api/music/session.js src/worker.js test/music-auth-api.test.js
git commit -m "feat: add music authentication APIs"
```

### Task 5: Protect the Music Page and List API

**Files:**
- Modify: `functions/music/index.js`
- Modify: `functions/api/music/list.js`
- Create: `test/music-access-control.test.js`

- [ ] **Step 1: Write failing access-control tests**

Assert both handlers return:

- 403 when disabled;
- 503 when enabled without a configured password;
- 401 for no session and for `user_session`;
- success for Music and admin sessions;
- `Cache-Control: no-store` on protected responses;
- `/music.html` remains a 302 redirect to `/music`.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx mocha test/music-access-control.test.js`

Expected: FAIL because both handlers currently use the global user authentication path.

- [ ] **Step 3: Replace global auth with Music access state**

Use `getMusicAccessState()` in both handlers. Map states consistently:

```text
disabled -> 403
password_missing/config_unavailable -> 503
unauthorized -> 401
authorized -> continue
```

Do not accept the `authCode` query parameter or normal user sessions.

- [ ] **Step 4: Run the access-control test and verify GREEN**

Run: `npx mocha test/music-access-control.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add functions/music/index.js functions/api/music/list.js test/music-access-control.test.js
git commit -m "feat: protect music resources"
```

### Task 6: Music Page Cookie Login UI

**Files:**
- Modify: `music.html`
- Modify: `test/music-page-route.test.js`

- [ ] **Step 1: Extend the page regression test**

Assert that `music.html`:

```js
assert.doesNotMatch(html, /authCode/);
assert.match(html, /\/api\/music\/login/);
assert.match(html, /\/api\/music\/session/);
assert.match(html, /\/api\/music\/logout/);
assert.match(html, /noindex,nofollow/);
```

Also assert login uses JSON POST and same-origin cookies, and errors 401/429/503 produce user-visible states.

- [ ] **Step 2: Run the page test and verify RED**

Run: `npx mocha test/music-page-route.test.js`

Expected: FAIL because the page still places `authCode` in the URL.

- [ ] **Step 3: Implement the Cookie-based UI**

Remove `getAuthParam()`. Submit the password with:

```js
fetch('/api/music/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'same-origin',
  body: JSON.stringify({ password }),
})
```

On success, reload the list without query credentials. Add an initialization check against `/api/music/session`, a logout button calling `/api/music/logout`, handling for 401/429/503, and `<meta name="robots" content="noindex,nofollow">`.

- [ ] **Step 4: Run the page test and verify GREEN**

Run: `npx mocha test/music-page-route.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add music.html test/music-page-route.test.js
git commit -m "feat: add music password login UI"
```

### Task 7: Admin Music Password Controls

**Files:**
- Create: `scripts/patch-music-admin-password.mjs`
- Modify: `package.json`
- Modify: `js/128.a59bdcad.js`
- Create: `test/music-admin-password-ui.test.js`

- [ ] **Step 1: Write the failing bundle-patch test**

Assert the compiled settings bundle contains a password input bound to `settings.musicPlayer.password`, a `passwordConfigured` status, and a clear-password action. Assert the patch script is idempotent by running it twice and comparing the output hash after the first and second runs.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx mocha test/music-admin-password-ui.test.js`

Expected: FAIL because the bundle exposes only enabled/musicDir.

- [ ] **Step 3: Implement an idempotent patch script**

Follow `scripts/apply-tg-upload-lanes-patch.mjs`: require exact occurrence counts, add stable marker strings, fail loudly when upstream bundle text changes, and never silently duplicate UI. The UI must:

- display whether a password is configured;
- accept a new password using `type="password"`;
- leave password blank to retain the existing hash;
- set `clearPassword=true` only after explicit confirmation;
- clear transient password fields after a successful save.

- [ ] **Step 4: Make frontend build apply the patch**

Add a package script and invoke it before `scripts/build-frontend-dist.mjs`, while keeping repeated builds idempotent.

- [ ] **Step 5: Run the patch test and verify GREEN**

Run: `npx mocha test/music-admin-password-ui.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add scripts/patch-music-admin-password.mjs package.json js/128.a59bdcad.js test/music-admin-password-ui.test.js
git commit -m "feat: configure music password in admin UI"
```

### Task 8: Full Verification

**Files:**
- Modify only if verification reveals a defect.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run Worker dry-run build**

Run: `npm run build:worker`

Expected: exit code 0; generated bundle contains the three Music auth routes and deployable `music.html`.

- [ ] **Step 3: Inspect secrets and URL usage**

Run:

```powershell
rg -n "passwordHash|authCode" music.html frontend-dist/music.html .wrangler-assets/music.html
```

Expected: no `authCode`; no password hash embedded in static assets.

- [ ] **Step 4: Review final diff against the design**

Confirm every requirement in `docs/superpowers/specs/2026-07-12-music-password-design.md` is represented by code and tests, with no unrelated refactoring.

- [ ] **Step 5: Commit any verification-only corrections**

If corrections were required, commit them as a focused fix. Otherwise do not create an empty commit.
