import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('upload metadata persistence regression', () => {
  it('writes sanitized metadata to the database instead of recursing', () => {
    const source = fs.readFileSync('functions/upload/index.js', 'utf8');
    const helper = source.match(/async function persistMetadata[\s\S]*?\n}/)?.[0] ?? '';

    assert.match(helper, /await db\.put\(fullId, "", \{ metadata \}\);/);
    assert.doesNotMatch(helper, /await persistMetadata\(/);
  });
});
