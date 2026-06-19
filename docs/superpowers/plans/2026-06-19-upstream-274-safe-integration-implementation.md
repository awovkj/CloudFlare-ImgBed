# Upstream 2.7.4 Safe Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely absorb requested 2.7.4 HuggingFace, upload, WebDAV, metadata-security, and session fixes while preserving this fork's music/video/chat, Worker/DO, and Telegram lane customizations.

**Architecture:** Add upstream helper modules first, then wire operation paths to those helpers. Use wrappers and targeted patches for customized files; copy upstream files only where the spec explicitly asks for the 2.7.4 behavior, especially WebDAV.

**Tech Stack:** Cloudflare Pages Functions, Cloudflare Workers, JavaScript ES modules, Mocha, Node.js scripts, Wrangler, compiled Vue/Webpack assets.

---

## File Structure

- `functions/utils/metadata/*.js`: upstream channel matching, credential resolution, metadata stripping, management display enrichment.
- `functions/utils/storage/webdavAPI.js`: upstream WebDAV helper.
- `functions/utils/storage/{telegramAPI,discordAPI,huggingfaceAPI}.js`: compatibility re-exports to preserve this fork's existing helpers.
- `functions/utils/auth/sessionConfig.js` and `functions/utils/auth/*.js`: upstream session normalization and auth helpers.
- `functions/api/auth/*.js`, `functions/api/manage/sysConfig/security.js`: 503-on-config-failure and session max-age fixes.
- `functions/dav/[[path]].js`, `functions/file/[[path]].js`, `functions/api/manage/{delete,move,rename,metadata,list,batch,cusConfig}`: WebDAV and metadata-safe operation paths.
- `functions/upload/huggingface/*.js`, `functions/api/huggingface/*.js`: HuggingFace direct upload compatibility.
- `functions/upload/{uploadShared,index,chunkUpload,chunkMerge}.js`: publicUrl and MIME fallback.
- `src/worker.js`: new Worker routes.
- `js/upstream-274-ui-guards.js`, `index.html`: runtime UI guard for max-age validation and channel-name immutability hints.
- `test/upstream-274-*.test.js`: focused Mocha coverage for each slice.

---

### Task 1: Shared helpers and compatibility wrappers

**Files:**
- Create: `test/upstream-274-shared-helpers.test.js`
- Create/Modify: `functions/utils/metadata/*.js`, `functions/utils/storage/*.js`, `functions/utils/auth/*.js`, root wrappers `functions/utils/{tokenExpiration,tokenValidator,userAuth,dualAuth}.js`

- [ ] **Step 1: Write the failing test**

Create `test/upstream-274-shared-helpers.test.js`:

```js
import assert from 'node:assert/strict';

describe('upstream shared helpers', () => {
  it('strips secrets and config-derived metadata', async () => {
    const { stripSensitiveMetadata, cleanPersistedMetadata } = await import('../functions/utils/metadata/metadataSecurity.js');
    const raw = {
      FileName: 'cat.png', ChannelName: 'dav-a', WebDAVFilePath: 'cat.png',
      S3AccessKeyId: 'ak', S3SecretAccessKey: 'sk', TgBotToken: 'bot', HfToken: 'hf',
      WebDAVUsername: 'u', WebDAVPassword: 'p', WebDAVHeaders: { Authorization: 'x' },
      WebDAVBaseUrl: 'https://u:p@example.com/dav/', WebDAVPublicUrl: 'https://cdn/cat.png',
      S3Location: 'https://old/cat.png', HfFileUrl: 'https://hf/cat.png'
    };
    const view = stripSensitiveMetadata(raw);
    assert.equal(view.WebDAVBaseUrl, 'https://example.com/dav/');
    assert.equal(view.WebDAVPassword, undefined);
    assert.equal(view.WebDAVPublicUrl, 'https://cdn/cat.png');
    const persisted = cleanPersistedMetadata(raw);
    assert.equal(persisted.ChannelName, 'dav-a');
    assert.equal(persisted.WebDAVFilePath, 'cat.png');
    assert.equal(persisted.WebDAVPublicUrl, undefined);
    assert.equal(persisted.S3Location, undefined);
  });

  it('normalizes WebDAV URL and headers', async () => {
    const { normalizeBaseUrl, buildWebDAVUrl, normalizeWebDAVHeaders } = await import('../functions/utils/storage/webdavAPI.js');
    assert.equal(normalizeBaseUrl('https://example.com/dav'), 'https://example.com/dav/');
    assert.equal(buildWebDAVUrl('https://example.com/dav/', '/a b.txt'), 'https://example.com/dav/a%20b.txt');
    assert.deepEqual(normalizeWebDAVHeaders('{"X-Test":"1","Empty":""}'), { 'X-Test': '1' });
  });

  it('matches renamed channels by legacy identity fields', async () => {
    const { findConfiguredChannel } = await import('../functions/utils/metadata/channelConfig.js');
    const cfg = { webdav: { channels: [{ name: 'renamed', baseUrl: 'https://u:p@example.com/dav/', username: 'u' }] } };
    assert.equal(findConfiguredChannel(cfg, 'webdav', { WebDAVBaseUrl: 'https://example.com/dav', WebDAVUsername: 'u' }).name, 'renamed');
  });

  it('normalizes session max age', async () => {
    const { normalizeSessionMaxAgeDays, sessionMaxAgeDaysToTtl } = await import('../functions/utils/auth/sessionConfig.js');
    assert.equal(normalizeSessionMaxAgeDays('3650'), 3650);
    assert.equal(normalizeSessionMaxAgeDays(0), 14);
    assert.equal(normalizeSessionMaxAgeDays(Date.now()), 14);
    assert.equal(sessionMaxAgeDaysToTtl(2), 172800);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- --grep "upstream shared helpers"`

Expected: FAIL with module-not-found errors for the new helper files.

- [ ] **Step 3: Implement by copying upstream helpers and adding wrappers**

Run this PowerShell block from repo root:

```powershell
$up = Resolve-Path '..\CloudFlare-ImgBed-2.7.4'
$copies = @(
  'functions\utils\metadata\channelConfig.js',
  'functions\utils\metadata\channelCredentials.js',
  'functions\utils\metadata\metadataSecurity.js',
  'functions\utils\metadata\metadataView.js',
  'functions\utils\storage\webdavAPI.js',
  'functions\utils\auth\authCore.js',
  'functions\utils\auth\passwordHash.js',
  'functions\utils\auth\sessionConfig.js',
  'functions\utils\auth\sessionManager.js',
  'functions\utils\auth\tokenExpiration.js',
  'functions\utils\auth\tokenValidator.js',
  'functions\utils\auth\userAuth.js',
  'functions\utils\auth\dualAuth.js'
)
foreach ($rel in $copies) {
  $src = Join-Path $up $rel
  $dst = Join-Path (Get-Location) $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Force
}
New-Item -ItemType Directory -Force -Path 'functions\utils\storage' | Out-Null
Set-Content -LiteralPath 'functions\utils\storage\telegramAPI.js' -Value "export { TelegramAPI } from '../telegramAPI.js';" -Encoding UTF8
Set-Content -LiteralPath 'functions\utils\storage\discordAPI.js' -Value "export { DiscordAPI } from '../discordAPI.js';" -Encoding UTF8
Set-Content -LiteralPath 'functions\utils\storage\huggingfaceAPI.js' -Value "export { HuggingFaceAPI } from '../huggingfaceAPI.js';" -Encoding UTF8
Set-Content -LiteralPath 'functions\utils\tokenExpiration.js' -Value "export { isExpired, filterAutoDeleteTokens } from './auth/tokenExpiration.js';" -Encoding UTF8
Set-Content -LiteralPath 'functions\utils\tokenValidator.js' -Value "export { validateApiToken } from './auth/tokenValidator.js';" -Encoding UTF8
Set-Content -LiteralPath 'functions\utils\userAuth.js' -Value "export { userAuthCheck, UnauthorizedResponse } from './auth/userAuth.js';" -Encoding UTF8
Set-Content -LiteralPath 'functions\utils\dualAuth.js' -Value "export { dualAuthCheck } from './auth/dualAuth.js';" -Encoding UTF8
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- --grep "upstream shared helpers"
npm test
git add functions/utils test/upstream-274-shared-helpers.test.js
git commit -m "feat: add upstream shared metadata and auth helpers"
```

Expected: both test commands pass.

---

### Task 2: Auth endpoints and session max-age fixes

**Files:**
- Create: `test/upstream-274-auth-source.test.js`
- Modify: `functions/api/auth/*.js`, `functions/api/manage/sysConfig/security.js`

- [ ] **Step 1: Write source-level regression tests**

Create `test/upstream-274-auth-source.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');

describe('upstream auth/session integration', () => {
  it('login and session check return 503 when security config is unavailable', () => {
    for (const file of ['functions/api/auth/adminLogin.js', 'functions/api/auth/login.js', 'functions/api/auth/sessionCheck.js']) {
      const src = read(file);
      assert.match(src, /fetchSecurityConfig\(env, \{ throwOnError: true \}\)/);
      assert.match(src, /Security config unavailable/);
      assert.match(src, /503/);
    }
  });
  it('security settings normalize session max-age and rehash passwords', () => {
    const src = read('functions/api/manage/sysConfig/security.js');
    assert.match(src, /normalizeSessionMaxAgeDays/);
    assert.match(src, /hashPassword/);
    assert.match(src, /destroySessionsByAuthType/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- --grep "upstream auth/session integration"`

Expected: FAIL before upstream auth endpoint files are copied.

- [ ] **Step 3: Copy upstream auth/security files**

Run:

```powershell
$up = Resolve-Path '..\CloudFlare-ImgBed-2.7.4'
$copies = @(
  'functions\api\auth\adminLogin.js',
  'functions\api\auth\login.js',
  'functions\api\auth\logout.js',
  'functions\api\auth\resetAuth.js',
  'functions\api\auth\sessionCheck.js',
  'functions\api\manage\sysConfig\security.js'
)
foreach ($rel in $copies) { Copy-Item -LiteralPath (Join-Path $up $rel) -Destination $rel -Force }
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- --grep "upstream auth/session integration"
npm test
git add functions/api/auth functions/api/manage/sysConfig/security.js test/upstream-274-auth-source.test.js
git commit -m "fix: normalize auth sessions and config failures"
```

Expected: both test commands pass.

---

### Task 3: WebDAV and metadata-safe management operations

**Files:**
- Create: `test/upstream-274-webdav-management-source.test.js`
- Modify: `functions/dav/[[path]].js`, `functions/file/[[path]].js`
- Modify: `functions/api/manage/delete/[[path]].js`, `move/[[path]].js`, `rename/[[path]].js`, `metadata/[[path]].js`
- Modify: `functions/api/manage/list.js`, `functions/api/manage/batch/list.js`, `functions/api/manage/sysConfig/upload.js`
- Create: `functions/api/manage/cusConfig/files.js`
- Modify: `functions/utils/indexManager.js`

- [ ] **Step 1: Write failing integration source tests**

Create `test/upstream-274-webdav-management-source.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');

describe('upstream WebDAV and metadata management integration', () => {
  it('file operations resolve credentials from current channel config', () => {
    const expectations = new Map([
      ['functions/file/[[path]].js', ['resolveTelegramCredentials', 'resolveS3Credentials', 'resolveDiscordCredentials', 'resolveHuggingFaceCredentials', 'resolveWebDAVCredentials', 'FileSizeBytes']],
      ['functions/api/manage/delete/[[path]].js', ['resolveS3Credentials', 'resolveDiscordCredentials', 'resolveHuggingFaceCredentials', 'resolveWebDAVCredentials']],
      ['functions/api/manage/move/[[path]].js', ['resolveS3Credentials', 'resolveWebDAVCredentials', 'cleanPersistedMetadata']],
      ['functions/api/manage/rename/[[path]].js', ['resolveS3Credentials', 'resolveWebDAVCredentials', 'cleanPersistedMetadataInPlace']]
    ]);
    for (const [file, tokens] of expectations) {
      const src = read(file);
      for (const token of tokens) assert.ok(src.includes(token), `${file} should include ${token}`);
    }
  });
  it('management APIs sanitize and enrich metadata', () => {
    assert.match(read('functions/api/manage/list.js'), /serializeFileRecordForManagement/);
    assert.match(read('functions/api/manage/list.js'), /createMetadataViewContext/);
    assert.match(read('functions/api/manage/batch/list.js'), /stripSensitiveMetadata/);
    assert.match(read('functions/api/manage/metadata/[[path]].js'), /buildFileMetadataForManagement/);
    assert.match(read('functions/api/manage/metadata/[[path]].js'), /cleanPersistedMetadata/);
    assert.match(read('functions/api/manage/cusConfig/files.js'), /buildFileMetadataForManagement/);
  });
  it('upload config and index manager normalize WebDAV and clean persisted metadata', () => {
    assert.match(read('functions/api/manage/sysConfig/upload.js'), /normalizeWebDAVHeaders/);
    assert.match(read('functions/utils/indexManager.js'), /cleanPersistedMetadata/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- --grep "upstream WebDAV and metadata management integration"`

Expected: FAIL because the target files do not yet contain the upstream resolver and metadata view calls.

- [ ] **Step 3: Copy upstream WebDAV/management files**

Run:

```powershell
$up = Resolve-Path '..\CloudFlare-ImgBed-2.7.4'
$copies = @(
  'functions\dav\[[path]].js',
  'functions\file\[[path]].js',
  'functions\api\manage\delete\[[path]].js',
  'functions\api\manage\move\[[path]].js',
  'functions\api\manage\rename\[[path]].js',
  'functions\api\manage\metadata\[[path]].js',
  'functions\api\manage\list.js',
  'functions\api\manage\batch\list.js',
  'functions\api\manage\cusConfig\files.js',
  'functions\api\manage\sysConfig\upload.js'
)
foreach ($rel in $copies) {
  $dst = Join-Path (Get-Location) $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath (Join-Path $up $rel) -Destination $dst -Force
}
```

- [ ] **Step 4: Patch `indexManager.js` to clean persisted metadata**

Create `scripts/patch-index-metadata-clean.mjs`:

```js
import fs from 'node:fs';
const file = 'functions/utils/indexManager.js';
let s = fs.readFileSync(file, 'utf8');
if (!s.includes("metadata/metadataSecurity.js")) {
  s = s.replace("import { getDatabase, checkDatabaseConfig } from './databaseAdapter.js';", "import { getDatabase, checkDatabaseConfig } from './databaseAdapter.js';\nimport { cleanPersistedMetadata } from './metadata/metadataSecurity.js';");
}
s = s.replace(/fileId,\s*metadata\s*\}\);/g, "fileId,\n            metadata: cleanPersistedMetadata(metadata)\n        });");
s = s.replace(/metadata: finalMetadata/g, "metadata: cleanPersistedMetadata(finalMetadata)");
s = s.replace(/metadata: metadata/g, "metadata: cleanPersistedMetadata(metadata)");
fs.writeFileSync(file, s, 'utf8');
```

Run: `node scripts/patch-index-metadata-clean.mjs`

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- --grep "upstream WebDAV and metadata management integration"
npm test
git add functions/dav functions/file functions/api/manage/delete functions/api/manage/move functions/api/manage/rename functions/api/manage/metadata functions/api/manage/list.js functions/api/manage/batch/list.js functions/api/manage/cusConfig/files.js functions/api/manage/sysConfig/upload.js functions/utils/indexManager.js test/upstream-274-webdav-management-source.test.js scripts/patch-index-metadata-clean.mjs
git commit -m "feat: resolve webdav and management metadata via channels"
```

Expected: both test commands pass.

---

### Task 4: HuggingFace direct upload and multipart completion proxy

**Files:**
- Create: `test/upstream-274-huggingface.test.js`
- Create: `functions/upload/huggingface/getUploadUrl.js`, `commitUpload.js`, `completeMultipart.js`
- Modify: `functions/api/huggingface/getUploadUrl.js`, `functions/api/huggingface/commitUpload.js`

- [ ] **Step 1: Write failing HuggingFace tests**

Create `test/upstream-274-huggingface.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');

describe('upstream HuggingFace direct upload integration', () => {
  it('validates multipart completion targets and bodies', async () => {
    const mod = await import('../functions/upload/huggingface/completeMultipart.js');
    assert.equal(mod.isValidCompletionTarget(new URL('https://huggingface.co/api/complete_multipart')), true);
    assert.equal(mod.isValidCompletionTarget(new URL('http://huggingface.co/api/complete_multipart')), false);
    assert.doesNotThrow(() => mod.validateMultipartBody(JSON.stringify({ oid: 'abc', parts: [{ partNumber: 1, etag: 'e' }] })));
    assert.throws(() => mod.validateMultipartBody('x'), /Invalid multipart completion body/);
    assert.throws(() => mod.validateMultipartBody(JSON.stringify({ oid: 'abc', parts: [{ partNumber: 0, etag: 'e' }] })), /Invalid multipart parts/);
  });
  it('rewrites completion URL and accepts empty MIME type', () => {
    const src = read('functions/upload/huggingface/getUploadUrl.js');
    assert.match(src, /rewriteMultipartCompletionUrl/);
    assert.match(src, /\/upload\/huggingface\/completeMultipart\?target=/);
    assert.match(src, /application\/octet-stream/);
  });
  it('keeps legacy API paths as re-exports', () => {
    assert.match(read('functions/api/huggingface/getUploadUrl.js'), /upload\/huggingface\/getUploadUrl\.js/);
    assert.match(read('functions/api/huggingface/commitUpload.js'), /upload\/huggingface\/commitUpload\.js/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- --grep "upstream HuggingFace direct upload integration"`

Expected: FAIL because `/upload/huggingface/completeMultipart.js` is missing.

- [ ] **Step 3: Copy upstream HuggingFace files and export validation helpers**

Run:

```powershell
$up = Resolve-Path '..\CloudFlare-ImgBed-2.7.4'
New-Item -ItemType Directory -Force -Path 'functions\upload\huggingface' | Out-Null
Copy-Item -LiteralPath (Join-Path $up 'functions\upload\huggingface\getUploadUrl.js') -Destination 'functions\upload\huggingface\getUploadUrl.js' -Force
Copy-Item -LiteralPath (Join-Path $up 'functions\upload\huggingface\commitUpload.js') -Destination 'functions\upload\huggingface\commitUpload.js' -Force
$complete = Get-Content -LiteralPath (Join-Path $up 'functions\upload\huggingface\completeMultipart.js') -Raw
$complete = $complete.Replace('function isValidCompletionTarget(targetUrl)', 'export function isValidCompletionTarget(targetUrl)')
$complete = $complete.Replace('function validateMultipartBody(body)', 'export function validateMultipartBody(body)')
Set-Content -LiteralPath 'functions\upload\huggingface\completeMultipart.js' -Value $complete -Encoding UTF8
Set-Content -LiteralPath 'functions\api\huggingface\getUploadUrl.js' -Value "export { onRequestPost } from '../../upload/huggingface/getUploadUrl.js';" -Encoding UTF8
Set-Content -LiteralPath 'functions\api\huggingface\commitUpload.js' -Value "export { onRequestPost } from '../../upload/huggingface/commitUpload.js';" -Encoding UTF8
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- --grep "upstream HuggingFace direct upload integration"
npm test
git add functions/upload/huggingface functions/api/huggingface test/upstream-274-huggingface.test.js
git commit -m "feat: proxy huggingface multipart completion"
```

Expected: both test commands pass.

---

### Task 5: Upload publicUrl responses and empty MIME fallback

**Files:**
- Create: `test/upstream-274-upload-response.test.js`
- Modify: `functions/upload/uploadShared.js`, `functions/upload/index.js`, `functions/upload/chunkUpload.js`, `functions/upload/chunkMerge.js`

- [ ] **Step 1: Write failing upload response tests**

Create `test/upstream-274-upload-response.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');

describe('upstream upload response integration', () => {
  it('builds upload payload with publicUrl', async () => {
    const { buildUploadResult, createUploadJsonResponse } = await import('../functions/upload/uploadShared.js');
    const result = buildUploadResult({ publicUrl: 'https://cdn.example/a.png' }, '/file/a.png');
    assert.deepEqual(result, { src: '/file/a.png', publicUrl: 'https://cdn.example/a.png' });
    const response = createUploadJsonResponse([result]);
    assert.deepEqual(await response.json(), [result]);
  });
  it('upload and merge paths include publicUrl and MIME fallback logic', () => {
    assert.match(read('functions/upload/index.js'), /context\.publicUrl/);
    assert.match(read('functions/upload/index.js'), /buildUploadResult|buildUploadResults/);
    assert.match(read('functions/upload/chunkUpload.js'), /application\/octet-stream/);
    assert.match(read('functions/upload/chunkMerge.js'), /application\/octet-stream/);
    assert.match(read('functions/upload/chunkMerge.js'), /publicUrl|buildUploadResult/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- --grep "upstream upload response integration"`

Expected: FAIL because `buildUploadResult` is not exported and upload paths do not yet use publicUrl consistently.

- [ ] **Step 3: Patch upload shared helper**

Append this code to `functions/upload/uploadShared.js`:

```js
export function buildUploadResult(context, returnLink) {
    const result = { src: returnLink };
    if (context?.publicUrl) {
        result.publicUrl = context.publicUrl;
    }
    return result;
}

export function buildUploadResults(context, returnLink) {
    return [buildUploadResult(context, returnLink)];
}
```

- [ ] **Step 4: Patch upload entry and chunk paths**

Use targeted edits:

1. In `functions/upload/index.js`, import `fetchPageConfig` from `../utils/sysConfig`.
2. In `functions/upload/index.js`, import `buildUploadResults` from `./uploadShared.js`.
3. Immediately after `const returnLink = buildReturnLink(url, fullId);`, add:

```js
    const pageConfig = await fetchPageConfig(env);
    const urlPrefixConfig = pageConfig.config?.find((configItem) => configItem.id === 'urlPrefix');
    const urlPrefix = urlPrefixConfig?.value || '';
    context.publicUrl = urlPrefix ? `${urlPrefix.replace(/\/+$/, '')}/${fullId}` : '';
```

4. Replace successful upload payloads shaped as `createUploadJsonResponse([{ src: returnLink }])` or `createUploadJsonResponse([{ src: `${returnLink}` }])` with:

```js
createUploadJsonResponse(buildUploadResults(context, returnLink))
```

5. In `functions/upload/chunkUpload.js`, ensure any empty uploaded MIME value uses:

```js
const normalizedFileType = fileType || originalFileType || 'application/octet-stream';
```

6. In `functions/upload/chunkMerge.js`, normalize merge MIME input with:

```js
originalFileType = formdata.get('originalFileType') || 'application/octet-stream';
```

7. In `functions/upload/chunkMerge.js`, build successful result objects with:

```js
result: [buildUploadResult(context, updatedReturnLink)]
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- --grep "upstream upload response integration"
npm test
git add functions/upload/uploadShared.js functions/upload/index.js functions/upload/chunkUpload.js functions/upload/chunkMerge.js test/upstream-274-upload-response.test.js
git commit -m "feat: include public upload urls and mime fallback"
```

Expected: both test commands pass.

---

### Task 6: Worker routes for new APIs

**Files:**
- Create: `test/upstream-274-worker-routes.test.js`
- Modify: `src/worker.js`, `src/generatedAuthRoutes.js`

- [ ] **Step 1: Write failing Worker route tests**

Create `test/upstream-274-worker-routes.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('src/worker.js', 'utf8');

describe('upstream Worker route integration', () => {
  it('routes upload HuggingFace direct upload endpoints', () => {
    assert.match(source, /onUploadHfGetUploadUrlPost/);
    assert.match(source, /onUploadHfCommitPost/);
    assert.match(source, /onUploadHfCompleteMultipartPost/);
    assert.match(source, /\/upload\/huggingface\/getUploadUrl/);
    assert.match(source, /\/upload\/huggingface\/commitUpload/);
    assert.match(source, /\/upload\/huggingface\/completeMultipart/);
  });
  it('routes management custom files endpoint', () => {
    assert.match(source, /onManageCusConfigFiles/);
    assert.match(source, /\/api\/manage\/cusConfig\/files/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- --grep "upstream Worker route integration"`

Expected: FAIL until `src/worker.js` imports and routes the new handlers.

- [ ] **Step 3: Patch `src/worker.js`**

Add imports near the existing HuggingFace imports:

```js
import { onRequestPost as onUploadHfGetUploadUrlPost } from '../functions/upload/huggingface/getUploadUrl.js';
import { onRequestPost as onUploadHfCommitPost } from '../functions/upload/huggingface/commitUpload.js';
import { onRequestPost as onUploadHfCompleteMultipartPost } from '../functions/upload/huggingface/completeMultipart.js';
```

Add import near existing `cusConfig` imports:

```js
import { onRequest as onManageCusConfigFiles } from '../functions/api/manage/cusConfig/files.js';
```

Add exact static routes in `STATIC_ROUTES`:

```js
    ['/upload/huggingface/getUploadUrl',   [checkDatabaseConfig, postOnly(onUploadHfGetUploadUrlPost)]],
    ['/upload/huggingface/commitUpload',    [checkDatabaseConfig, postOnly(onUploadHfCommitPost)]],
    ['/upload/huggingface/completeMultipart', [checkDatabaseConfig, postOnly(onUploadHfCompleteMultipartPost)]],
    ['/api/manage/cusConfig/files',        apiManageChain(onManageCusConfigFiles)],
```

- [ ] **Step 4: Verify routes and commit**

Run:

```bash
npm test -- --grep "upstream Worker route integration"
npm run generate:worker-routes
npm test
git add src/worker.js src/generatedAuthRoutes.js test/upstream-274-worker-routes.test.js
git commit -m "feat: route upstream huggingface worker endpoints"
```

Expected: all commands exit 0.

---

### Task 7: Runtime UI guards

**Files:**
- Create: `test/upstream-274-ui-guards.test.js`
- Create: `js/upstream-274-ui-guards.js`, `js/upstream-274-ui-guards.js.gz`
- Modify: `index.html`, `index.html.gz`

- [ ] **Step 1: Write failing UI guard tests**

Create `test/upstream-274-ui-guards.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import vm from 'node:vm';

describe('upstream UI guards', () => {
  it('exports session max-age normalization helper', () => {
    const code = fs.readFileSync('js/upstream-274-ui-guards.js', 'utf8');
    const context = { window: {}, document: { addEventListener(){}, querySelectorAll(){ return []; }, documentElement: {} }, MutationObserver: class { observe() {} }, XMLHttpRequest: function(){}, console, setTimeout };
    context.window = context;
    context.XMLHttpRequest.prototype.open = function(){};
    context.XMLHttpRequest.prototype.send = function(){};
    vm.createContext(context);
    vm.runInContext(code, context);
    assert.equal(context.Upstream274UiGuards.normalizeSessionMaxAgeDays('3650'), 3650);
    assert.equal(context.Upstream274UiGuards.normalizeSessionMaxAgeDays(0), 14);
  });
  it('is loaded before app chunks and gzip matches', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /js\/upstream-274-ui-guards\.js/);
    assert.ok(html.indexOf('js/upstream-274-ui-guards.js') < html.indexOf('js/chunk-vendors'));
    assert.equal(zlib.gunzipSync(fs.readFileSync('js/upstream-274-ui-guards.js.gz')).toString('utf8'), fs.readFileSync('js/upstream-274-ui-guards.js', 'utf8'));
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- --grep "upstream UI guards"`

Expected: FAIL because the UI guard script is missing.

- [ ] **Step 3: Create UI guard script**

Create `js/upstream-274-ui-guards.js`:

```js
(function attachUpstream274UiGuards(global) {
  'use strict';
  var DEFAULT_SESSION_DAYS = 14;
  function normalizeSessionMaxAgeDays(value) {
    var days = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isFinite(days)) return DEFAULT_SESSION_DAYS;
    days = Math.trunc(days);
    if (days < 1 || days > 3650) return DEFAULT_SESSION_DAYS;
    return days;
  }
  function normalizeSecurityPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    var access = payload.access || {};
    if ('adminSessionMaxAge' in access) access.adminSessionMaxAge = normalizeSessionMaxAgeDays(access.adminSessionMaxAge);
    if ('userSessionMaxAge' in access) access.userSessionMaxAge = normalizeSessionMaxAgeDays(access.userSessionMaxAge);
    payload.access = access;
    return payload;
  }
  function markChannelNameInputs(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('input').forEach(function(input) {
      var text = (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '');
      if (/渠道名称|channel name/i.test(text)) {
        input.setAttribute('data-upstream-274-channel-name-immutable', 'true');
        input.title = input.title || '渠道名称用于关联历史文件，保存后不建议修改。';
      }
    });
  }
  function patchXhr() {
    if (!global.XMLHttpRequest || global.XMLHttpRequest.__upstream274Patched) return;
    var proto = global.XMLHttpRequest.prototype;
    var open = proto.open;
    var send = proto.send;
    proto.open = function(method, url) { this.__u274Method = method; this.__u274Url = String(url || ''); return open.apply(this, arguments); };
    proto.send = function(body) {
      if (this.__u274Method === 'POST' && this.__u274Url.indexOf('/api/manage/sysConfig/security') !== -1 && typeof body === 'string') {
        try { body = JSON.stringify(normalizeSecurityPayload(JSON.parse(body))); } catch (error) { console.warn('[upstream-274-ui-guards]', error.message); }
      }
      return send.call(this, body);
    };
    global.XMLHttpRequest.__upstream274Patched = true;
  }
  patchXhr();
  if (global.document) {
    var apply = function() { markChannelNameInputs(global.document); };
    global.document.addEventListener && global.document.addEventListener('DOMContentLoaded', apply);
    setTimeout(apply, 0);
    if (global.MutationObserver && global.document.documentElement) new global.MutationObserver(apply).observe(global.document.documentElement, { childList: true, subtree: true });
  }
  global.Upstream274UiGuards = { normalizeSessionMaxAgeDays: normalizeSessionMaxAgeDays, normalizeSecurityPayload: normalizeSecurityPayload, markChannelNameInputs: markChannelNameInputs };
})(typeof globalThis !== 'undefined' ? globalThis : window);
```

- [ ] **Step 4: Generate gzip and inject script tag**

Run:

```powershell
$js = Get-Content -LiteralPath 'js\upstream-274-ui-guards.js' -Raw
[IO.File]::WriteAllBytes('js\upstream-274-ui-guards.js.gz', [IO.Compression.GzipStream]::new([IO.MemoryStream]::new(), [IO.Compression.CompressionMode]::Compress).BaseStream.ToArray())
```

If the PowerShell gzip command above does not create a valid gzip file, use this Node command:

```bash
node -e "const fs=require('fs'),z=require('zlib');fs.writeFileSync('js/upstream-274-ui-guards.js.gz',z.gzipSync(fs.readFileSync('js/upstream-274-ui-guards.js')));let h=fs.readFileSync('index.html','utf8');if(!h.includes('/js/upstream-274-ui-guards.js'))h=h.replace('<script defer=\"defer\" src=\"/js/chunk-vendors.','<script defer=\"defer\" src=\"/js/upstream-274-ui-guards.js\"></script><script defer=\"defer\" src=\"/js/chunk-vendors.');fs.writeFileSync('index.html',h);fs.writeFileSync('index.html.gz',z.gzipSync(Buffer.from(h)));"
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- --grep "upstream UI guards"
npm test
git add js/upstream-274-ui-guards.js js/upstream-274-ui-guards.js.gz index.html index.html.gz test/upstream-274-ui-guards.test.js
git commit -m "feat: add upstream ui validation guards"
```

Expected: both test commands pass.

---

### Task 8: Final verification and docs

**Files:**
- Create: `docs/upstream-274-safe-integration.md`

- [ ] **Step 1: Add integration note**

Create `docs/upstream-274-safe-integration.md`:

```markdown
# Upstream 2.7.4 Safe Integration Notes

This fork selectively integrates requested CloudFlare-ImgBed 2.7.4 improvements while preserving music, video, chat, Worker Durable Object, and Telegram lane customizations.

Integrated areas:

- HuggingFace multipart completion proxy at `/upload/huggingface/completeMultipart`.
- HuggingFace direct upload URL rewriting for Cloudflare Worker deployments.
- Upload success `publicUrl` when `urlPrefix` is configured.
- Empty MIME fallback to `application/octet-stream`.
- WebDAV credential resolution and read/delete/move/rename behavior aligned with 2.7.4.
- Current channel config credential resolution for S3/R2, Telegram, Discord, HuggingFace, and WebDAV.
- Sensitive metadata stripping and dynamic management display enrichment.
- Auth/session 503 failure handling and 1-3650 day session max-age normalization.

Verification commands:

```bash
npm test
npm run generate:worker-routes
npm run build:frontend-dist
npm run build:worker
```
```

- [ ] **Step 2: Run final verification**

Run:

```bash
npm test
npm run generate:worker-routes
npm run build:frontend-dist
npm run build:worker
git status --short
git diff --stat HEAD
```

Expected: test and build commands pass. `git diff --stat HEAD` shows only the planned integration files if the final docs commit has not yet been made.

- [ ] **Step 3: Commit final docs and generated outputs**

Run:

```bash
git add docs/upstream-274-safe-integration.md src/generatedAuthRoutes.js frontend-dist index.html index.html.gz js/upstream-274-ui-guards.js js/upstream-274-ui-guards.js.gz
git commit -m "docs: record upstream integration verification"
```

Expected: commit succeeds. If only docs changed, narrow the `git add` command to `docs/upstream-274-safe-integration.md` and commit with the same message.

- [ ] **Step 4: Final status check**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: working tree is clean or contains only ignored local runtime files.

---

## Plan Self-Review

- Spec coverage: HuggingFace direct upload and multipart proxy are covered by Task 4; upload `publicUrl` and empty MIME fallback by Task 5; WebDAV and metadata safety by Tasks 1 and 3; auth/session fixes by Task 2; Worker route compatibility by Task 6; frontend max-age and channel-name guard by Task 7; final verification by Task 8.
- Red-flag scan: no incomplete markers or open-ended implementation steps remain. Every task has exact files, commands, tests, and expected outcomes.
- Type consistency: names are consistent across tasks: `cleanPersistedMetadata`, `stripSensitiveMetadata`, `findConfiguredChannel`, `normalizeSessionMaxAgeDays`, `sessionMaxAgeDaysToTtl`, `buildUploadResult`, `isValidCompletionTarget`, and `validateMultipartBody`.

