import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MERGE_LEASE_MS,
  buildMergeLeasePatch,
  buildWaitingForChunksPatch,
  canApplyMergeSessionPatch,
  classifyMergeSession,
  isCleanupProtectedByMerge,
} from '../functions/upload/chunkMergeState.js';
import { claimUploadMerge, updateUploadSession } from '../functions/upload/mergeSessionStore.js';
import {
  getMergeSuccessReceipt,
  persistMergeSuccessReceipt,
} from '../functions/upload/mergeSuccessReceipt.js';

describe('chunk merge 409 recovery', () => {
  const now = 2_000_000;

  it('treats only a live short lease as an active merge', () => {
    const active = classifyMergeSession({
      status: 'merging',
      mergeLeaseUntil: now + 5_000,
      mergeProtectedUntil: now + 600_000,
    }, now);
    assert.equal(active.kind, 'active');

    const stale = classifyMergeSession({
      status: 'merging',
      mergeLeaseUntil: now - 1,
      mergeProtectedUntil: now + 600_000,
    }, now);
    assert.equal(stale.kind, 'stale');
  });

  it('recovers legacy merging sessions without honoring the old ten-minute lock', () => {
    const legacyStale = classifyMergeSession({
      status: 'merging',
      lastUpdatedAt: now - MERGE_LEASE_MS - 1,
      mergeProtectedUntil: now + 500_000,
    }, now);
    assert.equal(legacyStale.kind, 'stale');

    const legacyActive = classifyMergeSession({
      status: 'merging',
      lastUpdatedAt: now - 1_000,
      mergeProtectedUntil: now + 500_000,
    }, now);
    assert.equal(legacyActive.kind, 'active');
  });

  it('lets a client take over a background wait after its recovery grace expires', () => {
    assert.equal(classifyMergeSession({
      status: 'waiting_chunks',
      mergeResumeAfter: now + 5_000,
    }, now).kind, 'waiting');

    assert.equal(classifyMergeSession({
      status: 'waiting_chunks',
      mergeResumeAfter: now - 1,
    }, now).kind, 'resumable');
  });

  it('builds separate active-lease and cleanup-protection windows', () => {
    const lease = buildMergeLeasePatch('job-1', now);
    assert.equal(lease.status, 'merging');
    assert.equal(lease.mergeJobId, 'job-1');
    assert.equal(lease.mergeLeaseUntil, now + MERGE_LEASE_MS);
    assert.ok(lease.mergeProtectedUntil > lease.mergeLeaseUntil);

    const waiting = buildWaitingForChunksPatch('job-1', now, 1_000);
    assert.equal(waiting.status, 'waiting_chunks');
    assert.equal(waiting.mergeLeaseUntil, 0);
    assert.ok(waiting.mergeResumeAfter > waiting.mergeNextAttemptAt);

    assert.equal(isCleanupProtectedByMerge({
      status: 'merging',
      mergeLeaseUntil: now - 1,
      mergeProtectedUntil: now + 500_000,
    }, now), false);
    assert.equal(isCleanupProtectedByMerge(waiting, now), true);
  });

  it('prevents stale owners and terminal sessions from being overwritten', () => {
    assert.equal(canApplyMergeSessionPatch(
      { status: 'merging', mergeJobId: 'new-job' },
      { status: 'waiting_chunks' },
      { expectedJobId: 'old-job', allowedStatuses: ['merging'] },
    ), false);

    assert.equal(canApplyMergeSessionPatch(
      { status: 'merge_success', mergeJobId: 'job-1' },
      { status: 'waiting_chunks' },
      { expectedJobId: 'job-1' },
    ), false);

    assert.equal(canApplyMergeSessionPatch(
      { status: 'merging', mergeJobId: 'job-1' },
      { status: 'waiting_chunks' },
      { expectedJobId: 'job-1', allowedStatuses: ['merging'] },
    ), true);

    assert.equal(canApplyMergeSessionPatch(
      { status: 'initialized', revision: 4 },
      { status: 'merging' },
      { expectedRevision: 3 },
    ), false);
  });

  it('verifies a claimed lease after the non-atomic session write', async () => {
    let session = {
      status: 'initialized',
      revision: 0,
      expiresAt: now + 60_000,
    };
    const db = {
      async get() {
        return JSON.stringify(session);
      },
      async put(_key, value) {
        session = JSON.parse(value);
      },
    };

    assert.equal(await claimUploadMerge(
      db,
      'upload-1',
      buildMergeLeasePatch('job-1', now),
      { expectedRevision: 0 },
      () => now,
    ), true);

    const staleOwnerUpdated = await updateUploadSession(
      db,
      'upload-1',
      { status: 'waiting_chunks' },
      { expectedJobId: 'old-job' },
      () => now,
    );
    assert.equal(staleOwnerUpdated, false);
  });

  it('round-trips a merge success receipt independently of the upload session', async () => {
    const values = new Map();
    const puts = [];
    const db = {
      async get(key) {
        return values.get(key) || null;
      },
      async put(key, value, options) {
        values.set(key, value);
        puts.push({ key, options });
      },
    };
    const result = [{ src: '/file/success.bin' }];

    await persistMergeSuccessReceipt(db, 'upload-1', result, 'job-1', () => now);
    values.delete('upload_session_upload-1');

    const receipt = await getMergeSuccessReceipt(db, 'upload-1');
    assert.deepEqual(receipt.mergeResult, result);
    assert.equal(receipt.mergeJobId, 'job-1');
    assert.equal(puts[0].options.expirationTtl, 3600);
  });

  it('persists a success receipt before cleanup and keeps the session for idempotent polling', () => {
    const source = fs.readFileSync('functions/upload/chunkMerge.js', 'utf8');
    const receiptWrite = source.indexOf('persistMergeSuccessReceipt(');
    const cleanup = source.indexOf('cleanupChunkData(', receiptWrite);

    assert.ok(receiptWrite >= 0, 'merge success must be persisted as a receipt');
    assert.ok(cleanup > receiptWrite, 'success receipt must be written before chunk cleanup');
    assert.doesNotMatch(source, /cleanupUploadSession\s*\(/);
    assert.match(source, /startMergeHeartbeat\(/);
    assert.match(source, /buildWaitingForChunksPatch\(/);
    assert.doesNotMatch(source, /mergeExpired[\s\S]*MERGE_TIMEOUT/);
  });

  it('does not resume terminal merge sessions through the fingerprint index', () => {
    const source = fs.readFileSync('functions/upload/chunkUpload.js', 'utf8');
    assert.match(source, /!\['merge_success', 'merge_failed'\]\.includes\(existingSession\.status\)/);
  });
});
