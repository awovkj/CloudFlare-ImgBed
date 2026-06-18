# TG Upload Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram multi-channel upload scheduling so bulk uploads run one file per TG channel concurrently while extra files wait.

**Architecture:** Add a small browser-global scheduler helper that owns lane selection semantics and is testable in Mocha. Patch the existing compiled upload chunk to route Telegram uploads through TG-only lane queues, while non-TG uploads keep the existing `activeUploads/maxConcurrentUploads` logic. Update gzip assets so static serving remains consistent.

**Tech Stack:** Static Vue/Webpack bundle, browser JavaScript, Mocha, Node.js scripts, gzip assets.

---

## File Structure

- Create `js/tg-upload-lanes.js`: browser-global helper `window.TgUploadLaneScheduler` with pure lane utilities.
- Create `js/tg-upload-lanes.js.gz`: gzip copy of the helper for static serving.
- Create `test/tg-upload-lanes.test.js`: Mocha tests that load the helper in a VM context and prove lane behavior.
- Create `scripts/apply-tg-upload-lanes-patch.mjs`: deterministic patcher for the compiled upload chunk, index HTML, gzip files, and source-map metadata.
- Modify `js/274.9b7364f3.js`: compiled UploadForm runtime logic.
- Modify `js/274.9b7364f3.js.gz`: gzip copy of the compiled chunk.
- Modify `index.html` and `index.html.gz`: include `/js/tg-upload-lanes.js` before the app executes.
- Modify `js/274.9b7364f3.js.map` and `.map.gz`: add helper source metadata marker for traceability.

### Task 1: TG lane scheduler helper

**Files:**
- Create: `js/tg-upload-lanes.js`
- Create: `test/tg-upload-lanes.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/tg-upload-lanes.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadScheduler() {
  const code = fs.readFileSync('js/tg-upload-lanes.js', 'utf8');
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.TgUploadLaneScheduler;
}

describe('TgUploadLaneScheduler', () => {
  let scheduler;

  beforeEach(() => {
    scheduler = loadScheduler();
  });

  it('uses all unique Telegram channel names when no channel is selected', () => {
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }, { name: 'tg-a' }, { name: '' }];
    assert.deepEqual(scheduler.getLaneNames('', channels), ['tg-a', 'tg-b']);
  });

  it('uses only the selected Telegram channel when one is selected', () => {
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }];
    assert.deepEqual(scheduler.getLaneNames('tg-b', channels), ['tg-b']);
  });

  it('acquires one file per lane and waits when all lanes are busy', () => {
    const active = {};
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }, { name: 'tg-c' }];
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-a');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-b');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-c');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), '');
  });

  it('releases a lane so another file can use the same channel', () => {
    const active = {};
    const channels = [{ name: 'tg-a' }, { name: 'tg-b' }];
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-a');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-b');
    scheduler.releaseLane(active, 'tg-a');
    assert.equal(scheduler.acquireAvailableLane(active, '', channels), 'tg-a');
  });

  it('falls back to one unnamed default lane when channel list is unavailable', () => {
    const active = {};
    const lane = scheduler.acquireAvailableLane(active, '', []);
    assert.equal(lane, scheduler.DEFAULT_LANE);
    assert.equal(scheduler.channelNameForLane(lane), '');
    assert.equal(scheduler.acquireAvailableLane(active, '', []), '');
  });

  it('removes queued file wrappers by uid', () => {
    const queue = [
      { file: { uid: 1 } },
      { file: { uid: 2 } },
      { file: { uid: 3 } }
    ];
    assert.deepEqual(scheduler.removeQueuedFile(queue, 2).map(item => item.file.uid), [1, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --grep TgUploadLaneScheduler`

Expected: FAIL with `ENOENT: no such file or directory, open 'js/tg-upload-lanes.js'` or `TgUploadLaneScheduler` missing.

- [ ] **Step 3: Write minimal implementation**

Create `js/tg-upload-lanes.js`:

```js
(function attachTgUploadLaneScheduler(global) {
  'use strict';

  const DEFAULT_LANE = '__tg_default__';

  function normalizeName(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function getLaneNames(selectedChannelName, channels) {
    const selected = normalizeName(selectedChannelName);
    if (selected) return [selected];

    const names = [];
    const seen = new Set();
    if (Array.isArray(channels)) {
      for (const channel of channels) {
        const name = normalizeName(typeof channel === 'string' ? channel : channel && channel.name);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  function acquireAvailableLane(activeChannels, selectedChannelName, channels) {
    const active = activeChannels || {};
    const laneNames = getLaneNames(selectedChannelName, channels);
    const candidates = laneNames.length ? laneNames : [DEFAULT_LANE];
    for (const laneName of candidates) {
      if (!active[laneName]) {
        active[laneName] = true;
        return laneName;
      }
    }
    return '';
  }

  function releaseLane(activeChannels, laneName) {
    if (!activeChannels || !laneName) return;
    delete activeChannels[laneName];
  }

  function channelNameForLane(laneName) {
    return laneName === DEFAULT_LANE ? '' : normalizeName(laneName);
  }

  function removeQueuedFile(queue, uid) {
    if (!Array.isArray(queue)) return [];
    return queue.filter(item => item && item.file && item.file.uid !== uid);
  }

  global.TgUploadLaneScheduler = {
    DEFAULT_LANE,
    normalizeName,
    getLaneNames,
    acquireAvailableLane,
    releaseLane,
    channelNameForLane,
    removeQueuedFile
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --grep TgUploadLaneScheduler`

Expected: PASS with 6 passing tests.

### Task 2: Patch compiled upload runtime to use TG lanes

**Files:**
- Create: `scripts/apply-tg-upload-lanes-patch.mjs`
- Modify: `js/274.9b7364f3.js`
- Modify: `index.html`
- Modify gzip/map files generated by the patch script

- [ ] **Step 1: Write patch verification before implementation**

Create `scripts/apply-tg-upload-lanes-patch.mjs` with replacement assertions first. The script must throw if a target snippet is missing. It must include a `replaceOnce(text, from, to, label)` helper that checks `text.includes(from)` and checks that the replacement changes exactly one occurrence.

- [ ] **Step 2: Run patch script to verify it fails before replacements exist**

Run: `node scripts/apply-tg-upload-lanes-patch.mjs`

Expected: FAIL while trying to patch because the implementation replacement content has not yet been added to the script.

- [ ] **Step 3: Implement deterministic bundle patching**

The script must:

1. Add `<script src="/js/tg-upload-lanes.js"></script>` to `index.html` before the existing `/js/file-stats-widget.js` script when missing.
2. Add `tgUploadQueue:[],tgActiveChannels:{},tgChannelList:[]` to UploadForm data.
3. Add `this.tgUploadQueue=[],this.tgActiveChannels={}` to `beforeUnmount` cleanup.
4. Replace `uploadFile(e){...}` so Telegram files are routed through `enqueueTelegramUpload(e)` before the generic concurrency counter.
5. Insert methods `refreshTelegramChannels`, `enqueueTelegramUpload`, `processTelegramUploadQueue`, and `onTelegramUploadComplete` after `onUploadComplete`.
6. Patch direct and chunked `/upload` URLs so they use the file-assigned `channelName` first.
7. Patch upload `finally` blocks so Telegram completion releases a TG lane instead of decrementing generic `activeUploads`.
8. Patch `handleRemove` and `clearFileList` to clear TG queue/lane state.
9. Regenerate `.gz` files with `zlib.gzipSync`.
10. Add source-map metadata marker `webpack://sanyue_imghub/./src/utils/upload/tgUploadLanesRuntimePatch.js` if absent, then regenerate `.map.gz`.

- [ ] **Step 4: Run patch script**

Run: `node scripts/apply-tg-upload-lanes-patch.mjs`

Expected: exit 0 and print patched files.

- [ ] **Step 5: Verify runtime patch markers**

Run:

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('js/274.9b7364f3.js','utf8'); for (const marker of ['enqueueTelegramUpload','processTelegramUploadQueue','tgActiveChannels','TgUploadLaneScheduler']) { if (!s.includes(marker)) throw new Error('missing '+marker); } console.log('runtime markers ok')"
```

Expected: `runtime markers ok`.

### Task 3: Full verification and commit

**Files:**
- Modify as produced by Tasks 1-2

- [ ] **Step 1: Run focused scheduler tests**

Run: `npm test -- --grep TgUploadLaneScheduler`

Expected: PASS with 6 passing tests.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: exit 0. Existing unrelated tests may be absent; Mocha must not report failures.

- [ ] **Step 3: Run frontend/worker asset build check**

Run: `npm run build:frontend-dist`

Expected: exit 0 and `Built frontend-dist` output.

- [ ] **Step 4: Review git diff**

Run: `git diff --stat && git diff -- js/tg-upload-lanes.js test/tg-upload-lanes.test.js scripts/apply-tg-upload-lanes-patch.mjs index.html js/274.9b7364f3.js`

Expected: diff shows only TG lane scheduler, upload bundle patch, test, and generated gzip/map changes.

- [ ] **Step 5: Commit**

Run:

```bash
git add js/tg-upload-lanes.js js/tg-upload-lanes.js.gz test/tg-upload-lanes.test.js scripts/apply-tg-upload-lanes-patch.mjs index.html index.html.gz js/274.9b7364f3.js js/274.9b7364f3.js.gz js/274.9b7364f3.js.map js/274.9b7364f3.js.map.gz docs/superpowers/plans/2026-06-18-tg-upload-lanes-implementation.md
git commit -m "feat: schedule telegram uploads by channel lane"
```

Expected: commit succeeds.

## Self-Review

- Spec coverage: Task 1 defines and tests lane semantics. Task 2 routes TG uploads through lanes, assigns channel names, preserves non-TG path, clears queues, and regenerates served assets. Task 3 verifies tests/build and commits.
- Placeholder scan: no placeholder steps remain; each task includes exact files, code or script responsibilities, commands, and expected results.
- Type consistency: helper methods are consistently named `getLaneNames`, `acquireAvailableLane`, `releaseLane`, `channelNameForLane`, and `removeQueuedFile`; runtime patch references `window.TgUploadLaneScheduler`.
