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
