# Worker-Based Chunk Merge Design

## Goal

Run only the large-file merge phase in the ordinary Worker instead of the
Upload Durable Object (DO). Keep the existing DO path for initialization,
chunk requests that carry a routable ID, cleanup, and ordinary uploads.

The existing merge protocol remains unchanged: a merge may return
`409 MERGE_IN_PROGRESS` or `409 CHUNKS_INCOMPLETE`, schedule background work
with `waitUntil`, and let the client poll until a terminal result is available.

## Scope and Non-Goals

In scope:

- Route `chunked=true&merge=true` requests directly to the Worker.
- Preserve the existing `handleChunkMerge` state machine and channel-specific
  merge implementations for R2, S3, Telegram, and Discord.
- Add regression coverage proving merge requests do not resolve an Upload DO,
  even when an upload ID is present in the URL, header, or compatibility form.

Out of scope:

- Removing the `UPLOAD_DO` binding, DO class, or DO migration. Other upload
  operations still use that path.
- Changing the client request format, response schema, retry intervals, or
  polling limits.
- Introducing a new Worker/service binding or replacing the existing session
  storage.
- Solving cross-request merge locking. The current status checks remain the
  coordination mechanism for this change; stronger atomic claiming can be a
  separate follow-up.

## Current Flow

`src/worker.js` runs `forwardToUploadDO` for `/upload` requests. That middleware
extracts a route upload ID and calls `resolveUploadDurableObject`. The current
route helper gives any request with an upload ID to the DO, so a small merge
form whose body contains `uploadId` is forwarded there. Requests that cannot
be safely inspected (for example, a legacy binary chunk body without a route
ID) fall back to the Worker.

Once dispatched, `functions/upload/index.js` selects
`handleChunkMerge(context)` for `chunked=true&merge=true`. The merge handler
reads the upload session and manifest, waits for in-flight chunks, retries
recoverable failures, completes the selected storage provider's multipart
operation, persists metadata, and cleans up chunk state.

## Proposed Routing

Change only `shouldRouteUploadToDurableObject` in
`src/uploadRequestRouting.js`:

1. Parse the request URL.
2. If both `chunked=true` and `merge=true`, return `false` immediately.
3. Otherwise retain the current upload-ID and legacy-chunk rules.

The merge check must occur before the `if (uploadId)` branch. This is required
because the compatibility extractor may obtain an ID from the small multipart
body before the route decision is made.

No changes are needed in `src/worker.js`: a null DO stub already invokes the
existing `onUploadRequest(context)` fallback. The DO class and Wrangler
bindings remain intact for all other request types.

## Request and State Flow

1. The Worker validates the HTTP method and performs the existing upload ID
   extraction. Safe small merge forms may be cloned for ID consistency checks;
   the original request body remains available to the upload handler.
2. The route helper returns no DO stub for the merge request.
3. `onUploadRequest` parses the original form body and calls
   `handleChunkMerge`.
4. A completed or previously completed session returns the existing success
   response. An active merge returns the existing `409` response.
5. If chunks are still settling, the handler records the existing session
   status and schedules `finalizeMergeInBackground` through `waitUntil`.
6. The background routine retries using the current limits and writes the
   existing terminal success/failure status. Successful completion performs
   the existing provider merge, metadata persistence, and cleanup.

Query/header/body upload-ID mismatch validation remains enabled. It protects
callers that provide multiple IDs even though a valid merge is ultimately
handled by the Worker.

## Error Handling and Compatibility

- Preserve all current response codes and payloads, including `400` route-ID
  mismatch, `409` pending states, and terminal merge errors.
- Preserve method rejection and authentication/configuration middleware.
- Preserve `waitUntil` scheduling and cleanup protection while a merge is
  active.
- Do not change `wrangler.toml`; the DO binding is still required by other
  upload paths.

Moving merge execution out of a DO removes the DO's per-upload serialization.
Two concurrent merge requests can still race around the existing KV/D1 status
read/write sequence. The current `merging` status and idempotent session
checks reduce ordinary duplicate work, but they are not an atomic lock. This
known risk is documented and should be monitored during verification rather
than expanded into this focused change.

The merge implementation performs provider I/O and bounded waits. Worker
runtime behavior, especially long `waitUntil` retries, must be verified in a
Worker deployment; Pages development behavior is not sufficient evidence for
the DO-to-Worker routing change.

## Tests

Update `test/upload-durable-object-routing.test.js` with focused assertions:

- A merge URL with a query or header upload ID returns `false` from
  `shouldRouteUploadToDurableObject` and `null` from
  `resolveUploadDurableObject`, with no namespace calls.
- A merge compatibility form whose body contains an upload ID also bypasses
  the DO after extraction, while the original body remains unused by the
  routing helper.
- Initialization, ordinary uploads, and existing routable chunk requests
  retain their current DO behavior.
- Existing mismatch, unsafe-body, method-guard, and DO-dispatch tests remain
  unchanged unless their assertions need a merge-specific exception.

Run the focused routing and merge-state tests first, then the full `npm test`
suite. Existing unrelated baseline failures must be reported separately from
regressions introduced by this change.

## Acceptance Criteria

- Every `chunked=true&merge=true` request reaches the ordinary Worker handler
  without a call to `env.UPLOAD_DO`.
- Non-merge upload behavior is unchanged.
- Existing `409`/`waitUntil`/polling behavior and response formats remain
  compatible.
- Focused tests pass, and full-suite results are recorded with any baseline
  failures identified.
