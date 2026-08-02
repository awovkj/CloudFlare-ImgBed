import assert from 'node:assert/strict';
import fs from 'node:fs';

const uploadChunkMap = JSON.parse(fs.readFileSync('js/274.9b7364f3.js.map', 'utf8'));
const uploadFormSource = uploadChunkMap.sourcesContent[uploadChunkMap.sources.indexOf('webpack://sanyue_imghub/./src/components/upload/UploadForm.vue')];
const uploadChunkBundle = fs.readFileSync('js/274.9b7364f3.js', 'utf8');
const chunkMergeSource = fs.readFileSync('functions/upload/chunkMerge.js', 'utf8');
const chunkUploadSource = fs.readFileSync('functions/upload/chunkUpload.js', 'utf8');

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
});
