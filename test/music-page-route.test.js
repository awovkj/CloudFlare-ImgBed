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

  it('uses cookie sessions instead of exposing an authCode in the URL', () => {
    const source = fs.readFileSync('music.html', 'utf8');

    assert.doesNotMatch(source, /authCode/);
    assert.match(source, /<meta\s+name="robots"\s+content="noindex,nofollow">/);
    assert.match(source, /fetch\(['"]\/api\/music\/session['"]/);
    assert.match(source, /fetch\(['"]\/api\/music\/login['"]/);
    assert.match(source, /fetch\(['"]\/api\/music\/logout['"]/);
  });

  it('posts login credentials as same-origin JSON', () => {
    const source = fs.readFileSync('music.html', 'utf8');

    assert.match(source, /fetch\(['"]\/api\/music\/login['"],\s*\{[\s\S]*?method:\s*['"]POST['"][\s\S]*?credentials:\s*['"]same-origin['"][\s\S]*?['"]Content-Type['"]:\s*['"]application\/json['"][\s\S]*?body:\s*JSON\.stringify\(\{\s*password\s*\}\)[\s\S]*?\}\)/);
  });

  it('renders a password form, logout control, and visible auth service errors', () => {
    const source = fs.readFileSync('music.html', 'utf8');

    assert.match(source, /id="music-password"/);
    assert.match(source, /id="music-login-error"/);
    assert.match(source, /id="music-logout"/);
    assert.match(source, /form\.addEventListener\(['"]submit['"],\s*submitMusicLogin\)/);
    assert.match(source, /response\.ok[\s\S]*?location\.reload\(\)/);
    assert.match(source, /session\.valid\s*\?\s*loadMusicPage\(\)\s*:\s*showAuthPrompt\(\)/);
    assert.match(source, /status\s*===\s*401[\s\S]*?密码/);
    assert.match(source, /status\s*===\s*429[\s\S]*?尝试/);
    assert.match(source, /status\s*===\s*503[\s\S]*?服务/);
  });
});
