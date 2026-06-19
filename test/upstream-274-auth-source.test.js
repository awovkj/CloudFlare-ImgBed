import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');

describe('upstream auth/session integration', () => {
  it('login and session check return 503 when security config is unavailable', () => {
    for (const file of ['functions/api/auth/adminLogin.js', 'functions/api/auth/login.js', 'functions/api/auth/sessionCheck.js']) {
      const src = read(file);
      assert.match(src, /fetchSecurityConfig\(env, \{ throwOnError: true \}\)/);
      assert.match(src, /Security config unavailable/);
      assert.match(src, /503/);
    }
  });
  it('security settings normalize session max-age and rehash passwords', () => {
    const src = read('functions/api/manage/sysConfig/security.js');
    assert.match(src, /normalizeSessionMaxAgeDays/);
    assert.match(src, /hashPassword/);
    assert.match(src, /destroySessionsByAuthType/);
  });
});
