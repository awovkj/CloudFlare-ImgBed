# Post-a7cef09 Modular Optimization Design

## Goal

Optimize the changes introduced after commit `a7cef09c94718f040d4a7df7088e15987be04c6d` without rewriting the whole project. The work may change APIs, KV/D1 data structures, and frontend behavior. It focuses on temporary links, chunk uploads, Telegram throughput, index merging, Worker build reliability, and their required integration points.

The selected approach is modular refactoring. Telegram upload concurrency stays fixed at `5`; no dynamic concurrency controller will be introduced.

## Scope

### Included

- Temporary-link creation, listing, access, revocation, expiry, deletion integration, and UI.
- File access checks touched by temporary-link and admin-preview behavior.
- Chunk session resume, per-chunk state, storage-upload ordering, timeout cleanup, and merge status reads.
- Telegram fixed-concurrency retry behavior.
- Index-operation enumeration and continuation scheduling.
- Worker route generation, clean-checkout builds, test discovery, and CI verification.
- KV and D1 compatibility for all changed state.

### Excluded

- A full event-driven rewrite using Queues or a new Durable Object per subsystem.
- Dynamic Telegram concurrency adjustment.
- Unrelated music, chat, video, Docker, or general UI refactors.
- Changing R2 business semantics merely because local tests run without an R2 binding. R2-specific tests must use an explicit mock/binding or skip with a clear prerequisite.

## Architecture

### 1. Temporary Link Store

Create `functions/utils/tempLinkStore.js` as the only module allowed to persist or enumerate temporary links.

The logical record is:

```js
{
  schemaVersion: 2,
  token,
  fileId,
  fileVersion,
  fileName,
  createdAt,
  expiresAt,
  duration
}
```

`fileVersion` is an immutable value derived from stable file metadata at link creation. Prefer an existing upload timestamp or immutable storage identifier; if the record lacks one, compute a SHA-256 digest from canonical stable fields. A token is valid only while the current file record produces the same version. Deleting and recreating the same `fileId` therefore cannot reactivate an old token.

KV uses two records:

```text
temp_link:v2:token:<token> -> JSON link record, with expirationTtl
temp_link:v2:file:<encodedFileId>:<createdAt>:<token> -> token, with expirationTtl
```

The file component is encoded with base64url so a prefix query is unambiguous. Listing a file's links scans only its own prefix, supports cursors, and fetches records in bounded parallel batches. A configurable hard limit of 50 active links per file prevents unbounded records.

D1 gets a dedicated `temp_links` table rather than storing credentials in `files`:

```sql
CREATE TABLE IF NOT EXISTS temp_links (
  token TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  file_version TEXT NOT NULL,
  file_name TEXT,
  duration TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_temp_links_file_created
  ON temp_links(file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_temp_links_expires
  ON temp_links(expires_at);
```

`databaseAdapter` exposes dedicated temporary-link methods implemented by KV and D1 adapters. Generic `put/get/list` no longer receives new temporary-link records.

Legacy `temp_link:<token>` records remain readable. Successful reads are converted to the v2 shape and lazily migrated when enough metadata is available. Management listing may include legacy records during the transition, but all new writes use v2 storage.

### 2. Temporary Link API and File Lifecycle

Replace the path-encoded management contract with stable endpoints while keeping the old route as a compatibility adapter:

```text
POST   /api/manage/temp-links
GET    /api/manage/temp-links?fileId=...&cursor=...&limit=...
DELETE /api/manage/temp-links/<token>
DELETE /api/manage/temp-links?fileId=...
GET|HEAD /temp/<token>
```

Creation verifies the file exists, computes its version, enforces duration and per-file quota, and returns the created record. Listing is paginated. Deletion by token verifies ownership only when `fileId` is supplied; authenticated management callers may delete directly by token.

File deletion revokes all links for that file before or alongside storage deletion. Rename and move revoke existing links rather than silently retargeting credentials. This is intentionally conservative and prevents a credential created for one path from gaining access to another resource.

Temporary-link access:

1. Load token record.
2. Reject missing or expired records with `410` and `Cache-Control: no-store`.
3. Load the current file record and compare `fileVersion`.
4. Reject a mismatch with `410` and revoke the stale record.
5. Call the shared file-serving path through explicit trusted context, not a client-controlled header.
6. Force every response, including `200`, `206`, `304`, redirects, errors, and `HEAD`, to `Cache-Control: private, no-store, max-age=0`.

The public endpoint never trusts `X-Temp-Link-Token` supplied by the client. Only the in-process route adapter may set the trusted `fileAccess` context.

### 3. Admin Preview Authorization

Remove the same-origin `Referer` fallback for `?from=admin`. Referer is not an authentication mechanism.

An admin preview succeeds only when `authenticate(... manage/admin ...)` succeeds. Failure or configuration errors return `401`/`503` with `no-store`. If a cookie-less preview is later required, it must be a separately designed signed preview token; it is not part of this optimization.

### 4. Frontend Temporary-Link Integration

Retain the enhancer entry point but split it into focused functions: API client, modal lifecycle, upload-result integration, rendering, and clipboard helpers. The module uses the new API and cursor fields.

Every modal instance owns an `AbortController`. Closing by button, backdrop, or Escape aborts all event listeners and in-flight list requests. Reopening cannot accumulate global `keydown` handlers. Rendering continues to escape all user-derived values and never inserts raw API error HTML.

The frontend displays quota errors, paginated results, expired state, and explicit revocation. Upload-result integration continues to offer link creation after a successful upload.

### 5. Chunk State and Resume Identity

Keep `upload_session_<uploadId>` for immutable session data and summary state. Stop using a single manifest object as the authoritative per-chunk state.

Each chunk uses:

```text
upload_chunk_state_<uploadId>_<zero-padded-index>
```

with:

```js
{
  schemaVersion: 3,
  uploadId,
  index,
  status,
  attempt,
  size,
  checksum,
  uploadResult,
  error,
  updatedAt
}
```

Independent keys eliminate lost updates across five concurrent uploads. State transitions are monotonic: `completed` cannot be overwritten by a late `uploading` or retry state. The legacy manifest remains a read fallback for existing sessions and may hold summary fields, but new merge/status logic enumerates per-chunk keys first.

The request's in-memory `chunkData` is passed directly to storage upload. Persisting a KV copy may run concurrently, but storage upload never immediately rereads data whose `put` has not completed. Before returning a response that promises recoverability through merge, the required persisted copy must be confirmed.

The fingerprint key is a SHA-256 digest, never raw user input:

```text
upload_fp_v2_<sha256(canonical resume identity)>
```

The canonical resume identity includes file fingerprint, size, chunk size, total chunks, MIME type, original name, upload channel, channel name, chat/non-chat route class, and authenticated principal or anonymous upload scope. Resume lookup happens only after channel and authorization validation. Cross-user and cross-channel sessions cannot be reused.

### 6. Chunk Timeouts and Merge Reads

Upload timeout helpers retain the timer handle and clear it on every resolve/reject path. No successful test or request leaves a 60-second timer keeping the process alive.

R2/S3 multipart readiness uses a single absolute deadline shared by readiness polling and part upload. Error text reports the actual elapsed/deadline condition. This work does not require R2 multipart creation to move to initialization unless the configured R2 runtime contract and tests explicitly require it.

Chunk status and merge read per-chunk records in bounded batches. Legacy manifest/chunk metadata is normalized only when no v3 state exists. Cleanup removes session, fingerprint index, per-chunk states, persisted chunk bodies, legacy manifest, and multipart metadata.

### 7. Telegram Fixed Concurrency and Retry

Frontend lane concurrency and backend large-file concurrency remain fixed at `5`.

Retry behavior:

- Keep the configured maximum attempts fixed; default is three total attempts.
- If Telegram returns `retry_after`, wait at least the full server-requested duration plus small jitter. Never cap it downward.
- Network and timeout failures use bounded exponential backoff with jitter.
- Do not introduce automatic concurrency reduction or increase.
- Error responses retain status, description, attempt, and retryability for diagnostics.

### 8. Index Operation Merge

Remove the incorrect one-record probe. Pending operations are enumerated strictly after `lastOperationId` using cursor/start-after semantics where supported, or by scanning until the first greater key without concluding early from an old first key.

At most 200 operations are applied per merge. Processed operations are removed only after the chunked index is durably saved. If work remains, `waitUntil` schedules a continuation and checks the response. Scheduling failure is logged and returned as `continuationScheduled: false`; later reads can still trigger merging.

Operation records retain a seven-day expiry safety net. D1 ordering must use the operation ID consistently rather than timestamp in one path and ID in another.

### 9. Worker Build and Test Reliability

Route generation becomes part of the Wrangler custom build path, not only npm wrapper scripts. A clean checkout invoking Wrangler directly must generate `src/generatedAuthRoutes.js` before bundling.

`verify:worker-routes` gains a check mode that generates to a temporary file and fails when committed/generated inputs disagree. The generated module may remain ignored only if every supported build entry point creates it.

Stop ignoring the whole `test/` directory. All regression tests become tracked. CI runs:

```text
npm test
npm run build:frontend-dist
npm run build:worker
git status --short (must show no generated drift)
```

R2 tests use a complete R2 mock. Tests explicitly intended for a live binding skip with a named prerequisite instead of failing as ordinary unit tests.

## API Error Semantics

New and changed JSON APIs return:

```js
{
  success: false,
  code: 'STABLE_MACHINE_CODE',
  message: 'Human-readable message',
  details: {}
}
```

Important temporary-link codes include `TEMP_LINK_NOT_FOUND`, `TEMP_LINK_EXPIRED`, `TEMP_LINK_STALE`, `TEMP_LINK_LIMIT_REACHED`, and `INVALID_DURATION`. Upload codes retain the existing chunk protocol vocabulary and add `RESUME_IDENTITY_MISMATCH` where needed.

## Migration

1. Deploy D1 schema additions with `CREATE TABLE IF NOT EXISTS` and indexes.
2. Deploy dual-read temporary-link code and v2-only writes.
3. Deploy frontend against the new API while retaining the old management route adapter.
4. New upload sessions write v3 per-chunk state; old sessions remain readable through normalization.
5. After one maximum temporary-link lifetime plus a safety window, legacy temporary-link compatibility can be removed in a later change.

No destructive bulk migration is required.

## Testing

### Temporary links

- KV and D1 create/list/page/delete/expiry behavior.
- More than 1,000 global links do not affect listing for one file.
- Per-file quota is enforced.
- Deletion and same-ID recreation invalidate old tokens.
- Rename/move/delete revoke credentials.
- GET, HEAD, Range, 304, redirects, and errors all use `no-store`.
- Forged same-origin Referer cannot authorize admin preview.
- Repeated modal open/close does not accumulate listeners.

### Uploads

- Storage upload cannot race ahead of an unfinished KV write when it needs persisted data.
- Five concurrent chunks retain all completed states and cannot regress to uploading.
- Resume identity rejects another channel, route class, file shape, or principal.
- Raw/oversized fingerprints never become storage keys.
- Timeout timers are cleared.
- Telegram waits the full `retry_after` and concurrency remains exactly five.
- Legacy manifest sessions remain readable.

### Index and build

- Old and new operation keys can coexist without hiding new work.
- Continuation processing preserves operations until the index save succeeds.
- Clean checkout Worker build succeeds without a pre-existing generated route file.
- Test discovery is identical in local and CI checkouts.

## Completion Criteria

- All security and correctness issues identified in the post-commit review have regression tests.
- Temporary-link listing is proportional to links for one file, not all active links.
- Concurrent chunk state has no whole-manifest lost-update path.
- Telegram uses fixed concurrency five and honors complete server retry delays.
- Direct and npm-driven Worker builds work from a clean checkout.
- `npm test` and `npm run build:worker` pass with no untracked generated drift.
