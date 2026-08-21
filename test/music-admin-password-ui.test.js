import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const bundlePath = 'js/128.a59bdcad.js';
const patchScript = 'scripts/patch-music-admin-password.mjs';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('music admin password UI patch', () => {
  it('adds password status, password entry, explicit clearing, and transient-secret cleanup', () => {
    assert.equal(fs.existsSync(patchScript), true, 'music admin password patch script must exist');

    const bundle = fs.readFileSync(bundlePath, 'utf8');
    assert.match(bundle, /data-music-password-patch/);
    assert.match(bundle, /settings\.musicPlayer\.passwordConfigured/);
    assert.match(bundle, /settings\.musicPlayer\.password[^C]/);
    assert.match(bundle, /type:"password"/);
    assert.match(bundle, /clearMusicPassword/);
    assert.match(bundle, /settings\.musicPlayer\.clearPassword=!0/);
    assert.match(bundle, /settings\.musicPlayer\.password=""/);
    assert.match(bundle, /settings\.musicPlayer\.clearPassword=!1/);
  });

  it('is wired as a standalone patch script for the Workers pipeline', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(pkg.scripts['patch:music-admin-password'], `node ${patchScript}`);
  });

  it('is idempotent when run repeatedly', () => {
    const firstRun = spawnSync(process.execPath, [patchScript], { encoding: 'utf8' });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstHash = sha256(bundlePath);

    const secondRun = spawnSync(process.execPath, [patchScript], { encoding: 'utf8' });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    const secondHash = sha256(bundlePath);

    assert.equal(secondHash, firstHash);
  });
});
