# Worker-Based Chunk Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every `chunked=true&merge=true` request to the ordinary Worker while preserving existing non-merge routing, upload-ID mismatch protection, and the current `409`/`waitUntil` merge protocol.

**Architecture:** Add an explicit merge exclusion to the Upload DO routing helper, before upload-ID-based routing. Propagate query/header route identity into the shared Worker context before any local upload fallback so `handleChunkMerge` can still compare it with the multipart body ID. Reuse the existing merge state machine and DO configuration without changing frontend or provider code.

**Tech Stack:** Cloudflare Workers, Durable Objects, Pages Functions-compatible handlers, JavaScript ES modules, Mocha, Node Web APIs (`Request`, `FormData`, `File`).

---

## File Structure

- Modify `src/uploadRequestRouting.js`: own the pure decision that merge requests never resolve an Upload DO.
- Modify `src/worker.js`: attach query/header route data to Worker-local upload contexts before direct fallback.
- Modify `test/upload-durable-object-routing.test.js`: cover merge bypass, non-merge preservation, and local route/body mismatch behavior.
- Keep `functions/upload/chunkMerge.js`, `src/uploadDurableObject.js`, and `wrangler.toml` unchanged; the existing state machine, DO implementation, binding, and migration remain authoritative.

### Task 1: Make Merge Requests Ineligible for Upload DO Routing

**Files:**
- Modify: `test/upload-durable-object-routing.test.js:66`
- Modify: `src/uploadRequestRouting.js:71`

- [ ] **Step 1: Extend the compatibility-form test with failing Worker-routing assertions**

After the existing extraction assertions in `extracts a merge uploadId from a small compatibility FormData body`, add:

```js
    const namespace = createNamespace();
    assert.equal(shouldRouteUploadToDurableObject(request, 'merge-id'), false);
    assert.equal(resolveUploadDurableObject(namespace, request, 'merge-id'), null);
    assert.deepEqual(namespace.calls, []);
```

This proves a body-extracted upload ID cannot override the merge exclusion.

- [ ] **Step 2: Add a failing test for query/header merge IDs**

Add this test after the compatibility-form test:

```js
  it('routes merge requests through the Worker even when a route uploadId exists', async () => {
    for (const request of [
      new Request('https://example.com/upload?chunked=true&merge=true&uploadId=query-id', {
        method: 'POST',
      }),
      new Request('https://example.com/upload?chunked=true&merge=true', {
        method: 'POST',
        headers: { 'X-Upload-Id': 'header-id' },
      }),
    ]) {
      const uploadId = await extractUploadId(request);
      const namespace = createNamespace();

      assert.equal(shouldRouteUploadToDurableObject(request, uploadId), false);
      assert.equal(resolveUploadDurableObject(namespace, request, uploadId), null);
      assert.deepEqual(namespace.calls, []);
    }
  });
```

- [ ] **Step 3: Run the focused tests and verify the new assertions fail**

Run:

```powershell
npm test -- --grep "upload durable object routing"
```

Expected: the new merge cases fail because `shouldRouteUploadToDurableObject` currently returns `true` whenever `uploadId` is present. Existing non-merge cases should still pass.

- [ ] **Step 4: Implement the minimal merge exclusion**

Replace `shouldRouteUploadToDurableObject` in `src/uploadRequestRouting.js` with:

```js
export function shouldRouteUploadToDurableObject(request, uploadId) {
    const url = new URL(request.url);
    const isChunkRequest = url.searchParams.get('chunked') === 'true';
    const isMergeRequest = url.searchParams.get('merge') === 'true';

    if (isChunkRequest && isMergeRequest) {
        return false;
    }

    if (uploadId) {
        return true;
    }

    return !isChunkRequest;
}
```

Keep the merge check before `if (uploadId)` so query/header/body IDs cannot send a merge to the DO.

- [ ] **Step 5: Run the focused routing tests and verify they pass**

Run:

```powershell
npm test -- --grep "upload durable object routing"
```

Expected: all tests in the routing suite pass, including existing init, ordinary upload, routable non-merge chunk, method, and dispatch assertions.

- [ ] **Step 6: Commit the routing change**

```powershell
git add src/uploadRequestRouting.js
git add -f test/upload-durable-object-routing.test.js
git commit -m "feat: route chunk merges through worker"
```

### Task 2: Preserve Route-ID Validation on Worker-Local Fallbacks

**Files:**
- Modify: `test/upload-durable-object-routing.test.js:103`
- Modify: `src/worker.js:9`
- Modify: `src/worker.js:285`

- [ ] **Step 1: Add a failing source-contract test for local route propagation**

Extend `stores and enforces the query or header route uploadId in durable object context data` with these assertions:

```js
    const workerSource = fs.readFileSync('src/worker.js', 'utf8');
    assert.match(
      workerSource,
      /extractRouteUploadId,/,
      'Worker must import the synchronous query/header route-ID extractor',
    );
    assert.match(
      workerSource,
      /context\.data\.routeUploadId\s*=\s*extractRouteUploadId\(request\)/,
      'Worker-local upload handling must receive the route uploadId',
    );
    assert.ok(
      workerSource.indexOf('context.data.routeUploadId = extractRouteUploadId(request)')
        < workerSource.indexOf("!env.UPLOAD_DO"),
      'route identity must be attached before disabled or missing DO fallback',
    );
```

Keep this file read inside the same test so the ordering assertions inspect the
exact Worker source used by the current checkout.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npm test -- --grep "stores and enforces the query or header route uploadId"
```

Expected: FAIL because `src/worker.js` does not import `extractRouteUploadId` or assign `context.data.routeUploadId`.

- [ ] **Step 3: Import and propagate route identity before all local fallbacks**

Add `extractRouteUploadId` to the routing imports in `src/worker.js`:

```js
import {
    createRouteUploadIdMismatchResponse,
    dispatchUploadToDurableObject,
    extractRouteUploadId,
    extractUploadId,
    getUploadRequestMethodRejection,
    isRouteUploadIdMismatchError,
    resolveUploadDurableObject,
} from './uploadRequestRouting.js';
```

Then, immediately after the method check in `forwardToUploadDO`, add:

```js
    context.data = context.data || {};
    try {
        context.data.routeUploadId = extractRouteUploadId(request);
    } catch (error) {
        if (isRouteUploadIdMismatchError(error)) {
            return createRouteUploadIdMismatchResponse(error);
        }
        throw error;
    }
```

This assignment must remain before the `!env.UPLOAD_DO` / `DISABLE_UPLOAD_DO` branch. It gives all direct Worker paths the same query/header identity that the DO context currently receives, without parsing or consuming the multipart body.

- [ ] **Step 4: Run the focused route-propagation test and verify it passes**

Run:

```powershell
npm test -- --grep "stores and enforces the query or header route uploadId"
```

Expected: PASS. The existing assertions for `chunkUpload.js`, `chunkMerge.js`, and `uploadDurableObject.js` also continue to pass. The implementation must initialize `context.data` before assigning the route ID so direct middleware calls and normal middleware chains are both safe.

- [ ] **Step 5: Add the unsafe merge-body regression assertions**

Add this test near the existing unsafe-body extraction test:

```js
  it('retains the route ID for an unsafe merge body so local handling can compare IDs', async () => {
    const form = new FormData();
    form.set('uploadId', 'body-id');
    form.set('totalChunks', '3');
    form.set('originalFileName', 'large.bin');
    const request = new Request(
      'https://example.com/upload?chunked=true&merge=true&uploadId=route-id',
      { method: 'POST', body: form },
    );

    assert.equal(await extractUploadId(request), 'route-id');
    assert.deepEqual(buildUploadDurableObjectRouteData(request), {
      routeUploadId: 'route-id',
    });
    assert.equal(shouldRouteUploadToDurableObject(request, 'route-id'), false);

    const workerSource = fs.readFileSync('src/worker.js', 'utf8');
    const mergeSource = fs.readFileSync('functions/upload/chunkMerge.js', 'utf8');
    assert.match(workerSource, /context\.data\.routeUploadId\s*=\s*extractRouteUploadId\(request\)/);
    assert.match(mergeSource, /assertRouteUploadIdMatches\(context\.data\?\.routeUploadId, uploadId\)/);
  });
```

The request deliberately omits an explicit safe `Content-Length`. The test
does not import `src/worker.js` or `chunkMerge.js` (those Worker modules use
Wrangler's extension resolution); it verifies the pure route-data contract and
the two source contracts that connect it to local merge validation.

- [ ] **Step 6: Run the complete routing suite**

Run:

```powershell
npm test -- --grep "upload durable object routing"
```

Expected: all routing tests pass. In particular, disallowed methods are still rejected before route extraction, query/header conflicts return the stable `ROUTE_UPLOAD_ID_MISMATCH` response, merge resolves no DO, and non-merge routing is unchanged.

- [ ] **Step 7: Commit local route propagation**

```powershell
git add src/worker.js
git add -f test/upload-durable-object-routing.test.js
git commit -m "fix: preserve upload route identity in worker"
```

### Task 3: Verify Merge Protocol and Worker Build Compatibility

**Files:**
- Verify: `functions/upload/chunkMerge.js`
- Verify: `test/upload-chunk-merge-409.test.js`
- Verify: `wrangler.toml`
- Verify: `src/uploadDurableObject.js`

- [ ] **Step 1: Run the merge-state regression tests**

Run:

```powershell
npm test -- --grep "chunk merge|MERGE_IN_PROGRESS|CHUNKS_INCOMPLETE"
```

Expected: all matching tests pass, proving the existing `409`, polling, manifest, and background-state contracts remain intact.

- [ ] **Step 2: Run the full unit test suite**

Run:

```powershell
npm test
```

Expected: no new failures. At the planning baseline, the suite reports 111 passing and 3 pre-existing failures in `test/upload-chunk-initialization.test.js` around R2 multipart initialization; compare names and assertions rather than treating the count alone as proof.

- [ ] **Step 3: Build the Worker bundle**

Run:

```powershell
npm run build:worker
```

Expected: Wrangler dry-run exits `0`, includes the existing `UploadDurableObject` export/binding, and produces the Worker bundle without missing exports or route-generation errors.

- [ ] **Step 4: Review the final diff for scope containment**

Run:

```powershell
git diff --check
git diff -- src/uploadRequestRouting.js src/worker.js test/upload-durable-object-routing.test.js wrangler.toml functions/upload/chunkMerge.js
```

Expected: `git diff --check` exits `0`; only the routing helper, Worker context propagation, and routing tests contain implementation changes. `wrangler.toml` and `functions/upload/chunkMerge.js` have no diff.

- [ ] **Step 5: Commit any verification-only adjustment if required**

If the verification steps in this task reveal a necessary code adjustment,
add only the affected implementation/test files and commit it with a precise
message. If no adjustment is needed, do not create an empty commit.

```powershell
git status --short
```

Expected: only intentionally ignored/generated build artifacts may remain; tracked implementation files are committed.

### Task 4: Final Verification and Evidence Capture

**Files:**
- Verify: `src/uploadRequestRouting.js`
- Verify: `src/worker.js`
- Verify: `test/upload-durable-object-routing.test.js`
- Verify: `docs/superpowers/specs/2026-08-01-worker-chunk-merge-design.md`

- [ ] **Step 1: Confirm the decisive routing lines**

Run:

```powershell
rg -n "isMergeRequest|return false|routeUploadId = extractRouteUploadId|forwardToUploadDO" src/uploadRequestRouting.js src/worker.js
```

Expected: the merge exclusion appears before upload-ID routing, and local route propagation appears before the missing/disabled DO fallback.

- [ ] **Step 2: Re-run the focused tests after all commits**

Run:

```powershell
npm test -- --grep "upload durable object routing|chunk merge|MERGE_IN_PROGRESS|CHUNKS_INCOMPLETE"
```

Expected: all matching tests pass.

- [ ] **Step 3: Confirm repository state and commit history**

Run:

```powershell
git status --short
git log --oneline -5
```

Expected: no unintended tracked changes. History includes the routing, route-identity, and integration-test commits (or equivalent squashed commits if explicitly requested).

- [ ] **Step 4: Report outcome with evidence and residual risk**

The implementation report must state:

```text
Outcome: merge requests run in the ordinary Worker; non-merge routing and DO configuration remain unchanged.
Key evidence: focused routing/merge tests and Worker dry-run build results.
Verification: full-suite result, explicitly separating any known baseline failures.
Residual risk: Worker-local merges no longer receive DO serialization; concurrent duplicate merge claims remain non-atomic in KV/D1.
```
