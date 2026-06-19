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
