import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('music page route regression', () => {
  it('fetches music.html from the asset binding with an explicit GET request', () => {
    const source = fs.readFileSync('functions/music/index.js', 'utf8');

    assert.match(source, /const assetRequest = new Request\(musicHtmlUrl\.toString\(\), \{\s*method: 'GET',\s*headers: request\.headers,\s*\}\);/);
    assert.match(source, /await env\.ASSETS\.fetch\(assetRequest\)/);
    assert.doesNotMatch(source, /new Request\(musicHtmlUrl\.toString\(\), request\)/);
  });

  it('includes music.html in the deployable assets', () => {
    assert.equal(fs.existsSync('music.html'), true);
    assert.equal(fs.existsSync('.wrangler-assets/music.html'), true);
  });
});
