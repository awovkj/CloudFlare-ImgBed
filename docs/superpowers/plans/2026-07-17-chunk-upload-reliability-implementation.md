# Chunk Upload Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chunk upload, resume, merge, and cleanup idempotent and recoverable while preserving all existing URLs, response shapes, storage channels, and legacy sessions.

**Architecture:** Add a pure protocol/state module, keep legacy records behind normalization helpers, route the same upload ID through one Durable Object, initialize R2/S3 multipart sessions during init, and make chunk/merge errors explicit instead of destructive. The minified frontend remains the deployed source of truth but is updated through an idempotent patch script and verified with source-contract tests.

**Tech Stack:** Cloudflare Workers/Pages Functions, Durable Objects, KV/D1, R2, AWS S3 SDK, Mocha, Node 22, Wrangler.

---

### Task 1: Protocol and state rules

**Files:**
- Create: `functions/upload/chunkProtocol.js`
- Create: `test/chunk-protocol.test.js`

- [ ] **Step 1: Write failing behavior tests**

Cover these concrete cases:

```js
import assert from 'node:assert/strict';
import {
  validateChunkInitialization,
  validateChunkRequest,
  normalizeUploadSession,
  canReuseCompletedChunk,
  classifyChunkStatuses,
} from '../functions/upload/chunkProtocol.js';

assert.equal(validateChunkInitialization({ totalChunks: 0 }).code, 'INVALID_TOTAL_CHUNKS');
assert.equal(validateChunkInitialization({ totalChunks: 10001 }).code, 'INVALID_TOTAL_CHUNKS');
assert.equal(validateChunkRequest({ chunkIndex: 3, totalChunks: 3 }).code, 'INVALID_CHUNK_INDEX');
assert.equal(normalizeUploadSession({ uploadId: 'u', totalChunks: 2 }).schemaVersion, 2);
assert.equal(canReuseCompletedChunk({ status: 'completed', size: 10 }, { size: 10 }), true);
assert.equal(canReuseCompletedChunk({ status: 'completed', size: 10, checksum: 'a' }, { size: 10, checksum: 'b' }), false);
assert.deepEqual(classifyChunkStatuses([
  { index: 0, status: 'completed' },
  { index: 1, status: 'uploading' },
  { index: 2, status: 'failed' },
]), { uploadedChunks: [0], inProgressChunks: [1], failedChunks: [2] });
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --grep "chunk protocol"`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `chunkProtocol.js`.

- [ ] **Step 3: Implement the pure module**

Implement constants and pure functions with these constraints:

```js
export const MAX_MULTIPART_CHUNKS = 10000;

export function validateChunkInitialization(input) {
  const totalChunks = Number(input.totalChunks);
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_MULTIPART_CHUNKS) {
    return { ok: false, code: 'INVALID_TOTAL_CHUNKS' };
  }
  return { ok: true, totalChunks };
}

export function validateChunkRequest(input) {
  const chunkIndex = Number(input.chunkIndex);
  const totalChunks = Number(input.totalChunks);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    return { ok: false, code: 'INVALID_CHUNK_INDEX' };
  }
  return { ok: true, chunkIndex, totalChunks };
}

export function normalizeUploadSession(session, now = Date.now()) {
  return { schemaVersion: 2, revision: 0, status: 'initialized', updatedAt: now, ...session };
}

export function canReuseCompletedChunk(existing, incoming) {
  return existing?.status === 'completed'
    && Number(existing.size) === Number(incoming.size)
    && (!existing.checksum || !incoming.checksum || existing.checksum === incoming.checksum);
}

export function classifyChunkStatuses(statuses) {
  const result = { uploadedChunks: [], inProgressChunks: [], failedChunks: [] };
  for (const part of statuses) {
    if (part.status === 'completed') result.uploadedChunks.push(part.index);
    else if (['uploading', 'retrying'].includes(part.status)) result.inProgressChunks.push(part.index);
    else if (['failed', 'timeout', 'retry_failed', 'missing', 'error'].includes(part.status)) result.failedChunks.push(part.index);
  }
  for (const values of Object.values(result)) values.sort((a, b) => a - b);
  return result;
}

export function uploadError(code, message, options = {}) {
  return { success: false, code, message, ...options };
}
```

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run: `npm test -- --grep "chunk protocol"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/upload/chunkProtocol.js test/chunk-protocol.test.js
git commit -m "feat: define chunk upload protocol rules"
```

### Task 2: Correct database selection and D1 TTL semantics

**Files:**
- Modify: `functions/utils/databaseAdapter.js`
- Modify: `functions/utils/d1Database.js`
- Create: `test/upload-database-adapter.test.js`

- [ ] **Step 1: Write failing tests**

Test that KV wins when both bindings exist, D1 wins only when KV is absent, and D1-compatible records expire:

```js
assert.deepEqual(checkDatabaseConfig({ img_url: fakeKv, img_d1: fakeD1 }), {
  hasD1: true, hasKV: true, usingD1: false, usingKV: true, configured: true,
});

await db.put('upload_session_u', 'value', { expirationTtl: 1 });
clock.advance(1001);
assert.equal(await db.get('upload_session_u'), null);
```

Use a small fake D1 statement adapter and inject a clock into `D1Database` through an optional constructor argument.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --grep "upload database adapter"`

Expected: existing `usingD1` assertion fails and expired record remains readable.

- [ ] **Step 3: Implement**

- Make `checkDatabaseConfig()` mirror `createDatabaseAdapter()` exactly.
- Export `KVAdapter` for behavior tests.
- Store internal `__expiresAt` metadata when `expirationTtl` or `expiration` is provided.
- In `get()` and `getWithMetadata()`, delete expired records before returning `null`.
- Preserve user metadata and do not expose `__expiresAt` to callers.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --grep "upload database adapter"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/utils/databaseAdapter.js functions/utils/d1Database.js test/upload-database-adapter.test.js
git commit -m "fix: align database selection and D1 expiry"
```

### Task 3: Route one upload through one Durable Object

**Files:**
- Create: `src/uploadRequestRouting.js`
- Modify: `src/worker.js`
- Modify: `src/uploadDurableObject.js`
- Create: `test/upload-durable-object-routing.test.js`

- [ ] **Step 1: Write failing tests**

Test request routing with real `Request`/`FormData`:

```js
const init = new Request('https://x/upload?initChunked=true', { method: 'POST', body: initForm });
assert.equal(await extractUploadId(init), null);

const chunk = new Request('https://x/upload?chunked=true', { method: 'POST', body: chunkForm });
assert.equal(await extractUploadId(chunk), 'upload-1');

const cleanup = new Request('https://x/upload?cleanup=true&uploadId=upload-1');
assert.equal(await extractUploadId(cleanup), 'upload-1');
```

Also assert source uses `idFromName(uploadId)` and DO accepts GET.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --grep "upload durable object routing"`

Expected: FAIL because helper does not exist and DO returns 405 for GET.

- [ ] **Step 3: Implement routing helper and integration**

```js
export async function extractUploadId(request) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('uploadId');
  if (fromQuery) return fromQuery;
  if (request.method !== 'POST') return null;
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) return null;
  return String((await request.clone().formData()).get('uploadId') || '') || null;
}
```

- `forwardToUploadDO()` uses `idFromName(uploadId)` when available and `newUniqueId()` only for init.
- If upload ID extraction fails, fall back to direct Worker handling rather than losing the request body.
- `UploadDurableObject.fetch()` accepts GET, POST, and OPTIONS.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --grep "upload durable object routing"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/uploadRequestRouting.js src/worker.js src/uploadDurableObject.js test/upload-durable-object-routing.test.js
git commit -m "fix: serialize requests by upload durable object"
```

### Task 4: Versioned session initialization and eager multipart creation

**Files:**
- Modify: `functions/upload/chunkUpload.js`
- Modify: `functions/upload/chunkProtocol.js`
- Create: `test/upload-chunk-initialization.test.js`

- [ ] **Step 1: Write failing source/behavior tests**

Assert initialization:

- uses `crypto.randomUUID()`;
- validates `totalChunks <= 10000`;
- accepts optional `fileSize`, `chunkSize`, `fileFingerprint`;
- writes `schemaVersion: 2` and `revision`;
- calls an exported `initializeBackendMultipart()` before returning for R2/S3;
- no longer creates multipart inside `chunkIndex === 0` branches.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --grep "chunk initialization"`

Expected: FAIL on missing v2 fields and eager multipart helper.

- [ ] **Step 3: Implement initialization**

- Add `.js` extensions to imports modified in `chunkUpload.js` and `chunkMerge.js`.
- Parse optional v2 fields without requiring them from legacy callers.
- Generate the final file ID once at init for R2/S3.
- Select the S3 channel deterministically and persist its name in multipart info.
- Create R2/S3 multipart exactly once and save `multipart_${uploadId}` before session response.
- If multipart initialization fails, delete partial session/manifest data and return non-2xx.
- Refactor part upload functions to require existing multipart info and remove polling for chunk 0.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --grep "chunk initialization"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/upload/chunkUpload.js functions/upload/chunkProtocol.js test/upload-chunk-initialization.test.js
git commit -m "feat: initialize multipart uploads with sessions"
```

### Task 5: Idempotent chunk upload and explicit retry errors

**Files:**
- Modify: `functions/upload/chunkUpload.js`
- Modify: `functions/upload/uploadShared.js`
- Create: `test/upload-chunk-idempotency.test.js`

- [ ] **Step 1: Write failing tests**

Cover source and pure behavior for:

- negative/out-of-range chunk index returns `400 INVALID_CHUNK_REQUEST`;
- mismatched total chunk count returns 400;
- wrong known chunk size returns `422 CHUNK_SIZE_MISMATCH`;
- completed same-size/checksum chunk returns `duplicate: true` without storage upload;
- storage failure returns `503 CHUNK_UPLOAD_RETRYABLE`, not HTTP 200;
- URL channel cannot override the channel fixed in session;
- D1 mode does not claim it retained retryable binary data.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --grep "chunk upload idempotency"`

Expected: FAIL because current code returns deferred success and lacks range checks.

- [ ] **Step 3: Implement**

- Validate session and request with `chunkProtocol.js` before writing state.
- Read manifest before upload and short-circuit safe duplicates.
- Mark active duplicate requests `409 CHUNK_IN_PROGRESS`.
- Track `attempt` and optional `chunkChecksum`.
- On storage failure, write failed status then return a JSON 503 with `retryable: true`.
- Do not invoke merge-time binary retry when data is unavailable.
- Ensure Telegram/Discord result records exclude bot tokens and credentials.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --grep "chunk upload idempotency"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/upload/chunkUpload.js functions/upload/uploadShared.js test/upload-chunk-idempotency.test.js
git commit -m "fix: make chunk uploads idempotent and retryable"
```

### Task 6: Rich status and resumable client behavior

**Files:**
- Modify: `functions/upload/chunkStatus.js`
- Create: `scripts/apply-chunk-upload-v2-patch.mjs`
- Modify: `package.json`
- Modify: `js/274.9b7364f3.js`
- Modify: `js/274.9b7364f3.js.gz`
- Modify: `js/274.9b7364f3.js.map`
- Modify: `js/274.9b7364f3.js.map.gz`
- Create: `test/upload-chunk-resume-client.test.js`

- [ ] **Step 1: Write failing tests**

Assert status JSON includes `uploadedChunks`, `failedChunks`, `inProgressChunks`, `expiresAt`, merge status/result, and per-part summaries. Assert bundle contains stable markers:

```text
chunkUploadSessionsV2
fileFingerprint
/upload/chunkStatus
uploadedChunks
method:"post"  // cleanup
```

Assert the patch script is idempotent by running it twice and comparing hashes.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --grep "chunk resume client"`

Expected: FAIL because status and bundle lack resume markers.

- [ ] **Step 3: Implement status and patch script**

- Return normalized session and classified part lists from `chunkStatus.js`.
- Patch init form to send `fileSize`, `chunkSize`, and fingerprint `${name}:${size}:${lastModified}:${chunkSize}`.
- Store fingerprint-to-upload mapping in `localStorage.chunkUploadSessionsV2`.
- Before scheduling workers, query `/upload/chunkStatus` and pre-mark completed indexes at 100%.
- Skip completed indexes in the worker loop.
- Remove local session on success or explicit cleanup.
- Change cleanup request to POST while retaining backend GET compatibility.
- Update source-map `sourcesContent` or add a runtime-patch source entry explaining the exact injected behavior.
- Add `patch:chunk-upload-v2` and run it before `build:frontend-dist`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run patch:chunk-upload-v2
npm run patch:chunk-upload-v2
npm test -- --grep "chunk resume client"
```

Expected: both patch runs succeed; test passes.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/apply-chunk-upload-v2-patch.mjs js/274.9b7364f3.js js/274.9b7364f3.js.gz js/274.9b7364f3.js.map js/274.9b7364f3.js.map.gz functions/upload/chunkStatus.js test/upload-chunk-resume-client.test.js
git commit -m "feat: resume interrupted chunk uploads"
```

### Task 7: Idempotent merge, leases, and non-destructive cleanup

**Files:**
- Modify: `functions/upload/chunkMerge.js`
- Modify: `functions/upload/chunkUpload.js`
- Modify: `test/upload-chunk-merge-409.test.js`
- Create: `test/upload-chunk-merge-idempotency.test.js`

- [ ] **Step 1: Write failing tests**

Cover:

- `merge_success` always returns the saved result;
- synchronous and background success retain the same terminal session shape;
- missing/failed parts return `409 CHUNKS_INCOMPLETE` with exact indexes and do not cleanup;
- active lease returns `409 MERGE_IN_PROGRESS`;
- expired lease can be reacquired;
- complete failure records `merge_failed` without immediate multipart abort;
- explicit cleanup aborts multipart and deletes session, manifest, chunk records;
- successful cleanup occurs only after final metadata and merge result are persisted.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --grep "chunk merge idempotency"`

Expected: FAIL because synchronous success currently deletes its session and failure cleanup is destructive.

- [ ] **Step 3: Implement merge coordinator changes**

- Normalize legacy sessions on read.
- Use `mergeLeaseUntil` and a per-request lease token; DO serialization is primary, lease is fallback.
- Remove merge-time retries that require unavailable D1 binary bodies.
- Verify all part numbers and ETags before R2/S3 complete.
- Persist final file metadata, then terminal session result, then schedule temporary cleanup.
- Keep the terminal session until TTL so repeated merge/status calls are idempotent.
- Make `forceCleanupUpload()` the only path that aborts recoverable multipart state.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- --grep "chunked upload merge 409|chunk merge idempotency"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/upload/chunkMerge.js functions/upload/chunkUpload.js test/upload-chunk-merge-409.test.js test/upload-chunk-merge-idempotency.test.js
git commit -m "fix: make chunk merge recoverable and idempotent"
```

### Task 8: Full verification and documentation

**Files:**
- Modify: `README.md`
- Create: `docs/chunk-upload-protocol.md`
- Modify: `.github/workflows/*` only if an existing Node test workflow is present and can be safely extended.

- [ ] **Step 1: Document compatibility and recovery**

Document legacy/v2 optional fields, status codes, resume behavior, channel differences, cleanup semantics, and operational rollback through `DISABLE_UPLOAD_DO=true`.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run build:frontend-dist
npm run verify:worker-routes
npm run build:worker
git diff --check
git status --short
```

Expected:

- all Mocha tests pass;
- frontend patch/build is idempotent;
- worker dry-run succeeds;
- no whitespace errors;
- only intended tracked files remain modified.

- [ ] **Step 3: Review against design**

Verify every requirement in `docs/superpowers/specs/2026-07-17-chunk-upload-reliability-design.md` is either implemented or explicitly documented as non-goal.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/chunk-upload-protocol.md .github/workflows
git commit -m "docs: describe reliable chunk upload protocol"
```
