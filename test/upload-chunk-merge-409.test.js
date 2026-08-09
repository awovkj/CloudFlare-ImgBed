import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  calculateTelegramRetryDelayMs,
  getChunkRecordTtlSeconds,
  selectTelegramChunkChannel,
  shouldPersistChunkDataBeforeUpload,
  TELEGRAM_LARGE_FILE_CONCURRENCY,
} from '../functions/upload/chunkUpload.js';

const uploadChunkMap = JSON.parse(fs.readFileSync('js/274.9b7364f3.js.map', 'utf8'));
const uploadFormSource = uploadChunkMap.sourcesContent[uploadChunkMap.sources.indexOf('webpack://sanyue_imghub/./src/components/upload/UploadForm.vue')];
const uploadChunkBundle = fs.readFileSync('js/274.9b7364f3.js', 'utf8');
const chunkMergeSource = fs.readFileSync('functions/upload/chunkMerge.js', 'utf8');
const chunkUploadSource = fs.readFileSync('functions/upload/chunkUpload.js', 'utf8');
const fileHandlerSource = fs.readFileSync('functions/file/[[path]].js', 'utf8');
const tgPatchScript = 'scripts/patch-tg-upload-performance.mjs';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('chunked upload merge 409 handling', () => {
  it('main upload bundle polls merge when backend returns 409 instead of failing upload', () => {
    assert.match(uploadChunkBundle, /__mA<660/);
    assert.match(uploadChunkBundle, /409===__st/);
    assert.match(uploadChunkBundle, /retryAfterMs/);
    assert.match(uploadChunkBundle, /合并进行中/);
  });

  it('backend separates waiting for chunks from final merge lock so 409 can recover', () => {
    assert.match(chunkMergeSource, /buildWaitingForChunksPatch/);
    assert.match(chunkMergeSource, /classifyMergeSession/);
    assert.match(chunkMergeSource, /mergeState\.kind\s*===\s*'waiting'/);
    assert.match(chunkMergeSource, /mergeState\.kind\s*===\s*'stale'/);
    assert.match(chunkMergeSource, /startMergeHeartbeat/);
    assert.match(chunkMergeSource, /getChunkUploadStatusesWithManifest/);
    assert.doesNotMatch(chunkMergeSource, /finalizeMergeInBackground/);
    assert.doesNotMatch(chunkMergeSource, /MERGE_TIMEOUT/);
  });

  it('backend maintains a manifest for chunk completion and failure states', () => {
    assert.match(chunkUploadSource, /upload_manifest_\$\{uploadId\}/);
    assert.match(chunkUploadSource, /export async function getUploadManifest/);
    assert.match(chunkUploadSource, /export async function updateUploadManifestChunk/);
    assert.match(chunkUploadSource, /export async function getChunkUploadStatusesWithManifest/);
    assert.match(chunkUploadSource, /updateUploadManifestChunk\(env,\s*uploadId,\s*chunkIndex/);
    assert.match(chunkUploadSource, /status:\s*'retry_failed'/);
  });

  it('pins every chunk of one Telegram upload to the same bot while balancing separate files', () => {
    const context = {
      uploadConfig: {
        telegram: {
          channels: [{ name: 'tg-a' }, { name: 'tg-b' }],
          loadBalance: { enabled: true },
        },
      },
      specifiedChannelName: '',
    };

    const firstChannel = selectTelegramChunkChannel(context, 'a', 0);
    for (let chunkIndex = 1; chunkIndex < 8; chunkIndex++) {
      assert.equal(selectTelegramChunkChannel(context, 'a', chunkIndex), firstChannel);
    }
    assert.notEqual(
      selectTelegramChunkChannel(context, 'a', 0),
      selectTelegramChunkChannel(context, 'b', 0),
    );
    assert.match(chunkUploadSource, /sessionInfo\.channelName\s*\|\|\s*url\.searchParams\.get\('channelName'\)/);
    assert.match(chunkMergeSource, /sessionInfo\.channelName\s*\|\|\s*url\.searchParams\.get\('channelName'\)/);
  });

  it('keeps historical mixed-bot chunks readable with per-chunk credentials', () => {
    assert.match(fileHandlerSource, /chunk\.tgBotToken\s*\|\|\s*fallbackTgBotToken/);
    assert.match(fileHandlerSource, /typeof chunk\.tgProxyUrl === 'string'/);
    assert.match(fileHandlerSource, /fetchTelegramChunkWithRetry\(chunkBotToken,\s*chunk,\s*chunkProxyUrl/);
  });

  it('uses the default TTL when a non-URL uploadId reaches timeout recovery', () => {
    assert.equal(getChunkRecordTtlSeconds('upload_legacy_string'), 3600);
    assert.equal(
      getChunkRecordTtlSeconds(new URL('https://example.test/upload?sourceApp=chat')),
      24 * 60 * 60,
    );
  });

  it('honors Telegram retry_after without racing away a late file_id', () => {
    assert.equal(calculateTelegramRetryDelayMs({ retryAfter: 30 }, 0), 30_150);
    assert.doesNotMatch(chunkUploadSource, /Math\.min\(retryAfterSeconds \* 1000 \+ 150,\s*8000\)/);
    assert.match(chunkUploadSource, /if \(uploadChannel === 'telegram'\) \{[\s\S]*?uploadResult = await uploadPromise;/);
    assert.match(chunkUploadSource, /if \(uploadChannel === 'telegram'\) \{[\s\S]*?uploadResult = await retryPromise;/);
  });

  it('avoids a full KV write on successful Telegram chunks and uses four upload workers', () => {
    assert.equal(shouldPersistChunkDataBeforeUpload('telegram'), false);
    assert.equal(shouldPersistChunkDataBeforeUpload('cfr2'), true);
    assert.equal(TELEGRAM_LARGE_FILE_CONCURRENCY, 4);
    assert.match(chunkUploadSource, /initialChunkValue = usingD1 \|\| !shouldPersistChunkDataBeforeUpload\(uploadChannel\)/);
    assert.match(uploadChunkBundle, /const f="telegram"===o\?4:"discord"===o\?3:6/);
    assert.match(uploadChunkBundle, /const v="telegram"===o\?3:5;while\(b<v\)/);
  });

  it('keeps the Telegram bundle patch idempotent and wired into both asset build paths', () => {
    assert.equal(fs.existsSync(tgPatchScript), true);
    const firstRun = spawnSync(process.execPath, [tgPatchScript], { encoding: 'utf8' });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstHash = sha256('js/274.9b7364f3.js');

    const secondRun = spawnSync(process.execPath, [tgPatchScript], { encoding: 'utf8' });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    assert.equal(sha256('js/274.9b7364f3.js'), firstHash);

    const frontendBuildSource = fs.readFileSync('scripts/build-frontend-dist.mjs', 'utf8');
    const assetBuildSource = fs.readFileSync('scripts/copy-assets.mjs', 'utf8');
    assert.match(frontendBuildSource, /patch-tg-upload-performance\.mjs/);
    assert.match(assetBuildSource, /patch-tg-upload-performance\.mjs/);
  });
});
