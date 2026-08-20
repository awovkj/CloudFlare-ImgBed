import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTH_DIR,
  OUTPUT_FILE,
  collectAuthRouteFiles,
  isGeneratedRouteFileCurrent,
  renderGeneratedAuthRoutes,
} from '../deploy/worker/generate-routes.js';

describe('worker route generation', () => {
  it('renders auth routes deterministically in filename order', () => {
    const routeFiles = collectAuthRouteFiles(AUTH_DIR);
    const routeNames = routeFiles.map(filePath => path.basename(filePath));
    assert.deepEqual(routeNames, [...routeNames].sort());

    const output = renderGeneratedAuthRoutes();
    let lastPosition = -1;
    for (const routeName of routeNames) {
      const routePath = `/api/auth/${routeName.replace(/\.js$/, '')}`;
      const position = output.indexOf(`['${routePath}'`);
      assert.ok(position > lastPosition, `${routePath} should be emitted in sorted order`);
      lastPosition = position;
    }
  });

  it('keeps the checked-in route manifest synchronized', () => {
    assert.equal(isGeneratedRouteFileCurrent(), true);
    assert.equal(fs.readFileSync(OUTPUT_FILE, 'utf8'), renderGeneratedAuthRoutes());
  });

  it('detects a stale manifest without modifying it', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgbed-routes-'));
    const staleFile = path.join(tempDir, 'generatedAuthRoutes.js');
    try {
      fs.writeFileSync(staleFile, '// stale\n', 'utf8');

      assert.equal(isGeneratedRouteFileCurrent(staleFile, renderGeneratedAuthRoutes()), false);
      assert.equal(fs.readFileSync(staleFile, 'utf8'), '// stale\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wires verify and check scripts as non-mutating quality gates', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.match(pkg.scripts['ci-test'], /wait-on http:\/\/localhost:8080 && npm test/);
    assert.equal(pkg.scripts['verify:worker-routes'], 'node deploy/worker/generate-routes.js --check');
    assert.equal(pkg.scripts.test, 'npm run verify:worker-routes && mocha');
    assert.equal(pkg.scripts.check, 'npm test');
  });
});
