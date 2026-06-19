import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

describe('upstream worker build syntax guards', () => {
  it('keeps file handler parseable for Worker bundling', () => {
    const result = spawnSync(process.execPath, ['--check', 'functions/file/[[path]].js'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it('exports APIs required by upstream WebDAV and file handlers', () => {
    const apiTokens = fs.readFileSync('functions/api/manage/apiTokens.js', 'utf8');
    const fileTools = fs.readFileSync('functions/file/fileTools.js', 'utf8');
    assert.match(apiTokens, /export\s+async\s+function\s+createApiToken/);
    assert.match(fileTools, /export\s+const\s+FILE_CACHE_CONTROL/);
  });
});
