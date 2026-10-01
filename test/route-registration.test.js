import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectHandlerFiles,
  collectRegisteredModules,
  collectGeneratedModules,
  verifyRouteCoverage,
} from '../deploy/worker/route-coverage.js';
import {
  FUNCTIONS_DIR,
  OUTPUT_FILE,
  ROUTES_FILE,
} from '../deploy/worker/generate-routes.js';
import {
  isWorkerOwnedPath,
  resolveRoute,
  ROUTE_TABLE_FOR_CHECK,
  WORKER_OWNED_EXACT,
  WORKER_OWNED_PREFIXES,
} from '../src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('route registration contract', () => {
  it('registers every handler exported under functions/', () => {
    const result = verifyRouteCoverage({
      functionsDir: FUNCTIONS_DIR,
      routesFile: ROUTES_FILE,
      generatedFile: OUTPUT_FILE,
    });

    assert.equal(
      result.ok,
      true,
      `以下 handler 导出了 onRequest 但未登记到任何路由:\n  ${result.unregistered.join('\n  ')}\n` +
      '请在 src/routes.js 登记，或在 deploy/worker/route-coverage.js 中写明豁免原因。',
    );
    assert.ok(result.total > 50, `handler 数量异常偏少: ${result.total}`);
    assert.equal(result.registered, result.total);
  });

  it('detects an unregistered handler (negative control)', () => {
    // 反向验证：证明校验不是「永远返回 ok」的空壳。
    // 从已登记集合中摘掉一个 handler，校验必须失败。
    const handlers = collectHandlerFiles(FUNCTIONS_DIR);
    const registered = collectRegisteredModules(ROUTES_FILE);
    const generated = collectGeneratedModules(OUTPUT_FILE);

    const probe = handlers.find((rel) => registered.has(rel) && !generated.has(rel));
    assert.ok(probe, '找不到可用于反向验证的 handler');

    const mutated = new Set([...registered].filter((rel) => rel !== probe));
    const unregistered = handlers.filter((rel) => !mutated.has(rel) && !generated.has(rel));

    assert.ok(
      unregistered.includes(probe),
      `摘掉 ${probe} 后应被判定为未登记`,
    );
  });

  it('excludes middleware, utils and generated auth routes from the contract', () => {
    const handlers = collectHandlerFiles(FUNCTIONS_DIR);

    assert.equal(handlers.some((rel) => rel.endsWith('_middleware.js')), false,
      '中间件不应被当作路由 handler');
    assert.equal(handlers.some((rel) => rel.startsWith('api/auth/')), false,
      'api/auth/* 由 generatedAuthRoutes 覆盖，不应重复要求登记');
    assert.equal(handlers.some((rel) => rel.startsWith('utils/')), false,
      'utils/ 是工具库目录，不承载路由');
    assert.equal(handlers.some((rel) => rel.endsWith('shared.js')), false,
      '不导出 onRequest 的工具模块不应进入 handler 集合');
  });

  it('resolves alias routes that cannot be derived from file paths', () => {
    // 这些别名正是不做「全量自动生成路由」的原因
    for (const alias of ['/music', '/music/', '/music.html', '/chat', '/chat/', '/chat.html']) {
      const resolved = resolveRoute(alias);
      assert.ok(resolved, `${alias} 应能解析到路由`);
      assert.equal(resolved.kind, 'chain', `${alias} 应走中间件链`);
    }

    // /api/site/* 是 /api/manage/* 的别名，有意公开（stats.html 依赖）
    assert.ok(resolveRoute('/api/site/storage-overview'), '/api/site/storage-overview 应可解析');
    assert.ok(resolveRoute('/api/site/storage-panel'), '/api/site/storage-panel 应可解析');
  });

  it('resolves dynamic routes with path params', () => {
    const file = resolveRoute('/file/a/b.png');
    assert.equal(file.kind, 'chain');
    assert.deepEqual(file.params, { path: 'a/b.png' });

    const del = resolveRoute('/api/manage/delete/a/b.png');
    assert.equal(del.kind, 'chain');
    assert.deepEqual(del.params, { path: 'a/b.png' });
  });

  it('resolves generated auth routes', () => {
    const resolved = resolveRoute('/api/auth/logout');
    assert.ok(resolved, '/api/auth/logout 应可解析');
    assert.equal(resolved.kind, 'generated');
  });

  it('returns null for paths outside the route table', () => {
    assert.equal(resolveRoute('/dashboard'), null);
    assert.equal(resolveRoute('/'), null);
  });

  it('classifies worker-owned paths so they never fall through to static assets', () => {
    const owned = [
      '/api', '/api/anything',
      '/file', '/file/x.png',
      '/upload', '/upload/chunkStatus',
      '/temp/abc',
      '/dav', '/dav/x',
      '/random',
      '/music', '/music/', '/music.html',
      '/chat', '/chat/', '/chat.html',
    ];

    for (const p of owned) {
      assert.equal(isWorkerOwnedPath(p), true, `${p} 应被判定为 worker 负责路径`);
    }
  });

  it('does not misclassify SPA routes as worker-owned paths', () => {
    // /musical 是这里的关键回归用例：若把 '/music' 当纯前缀匹配，
    // '/musical' 会被误判，导致正常的 SPA 路由变成 404。
    const spa = ['/', '/dashboard', '/index.html', '/login', '/musical', '/chatter', '/api-docs'];

    for (const p of spa) {
      assert.equal(isWorkerOwnedPath(p), false, `${p} 不应被判定为 worker 负责路径`);
    }
  });

  it('keeps worker-owned paths in sync with wrangler.toml run_worker_first', () => {
    const toml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
    const block = toml.match(/run_worker_first\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(block, 'wrangler.toml 中未找到 run_worker_first');

    const declaredBases = [...block[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1].replace(/\/\*$/, ''));

    const covered = new Set([
      ...WORKER_OWNED_EXACT,
      ...WORKER_OWNED_PREFIXES.map((p) => p.replace(/\/$/, '')),
    ]);

    for (const base of declaredBases) {
      assert.ok(
        covered.has(base),
        `wrangler.toml 声明了 ${base} 归 worker 处理，但 src/routes.js 的兜底清单未覆盖它`,
      );
    }

    for (const base of covered) {
      assert.ok(
        declaredBases.includes(base),
        `src/routes.js 声明 ${base} 归 worker 处理，但 wrangler.toml 的 run_worker_first 未包含它`,
      );
    }
  });

  it('has a non-trivial route table', () => {
    const { static: staticRoutes, dynamic } = ROUTE_TABLE_FOR_CHECK;
    assert.ok(staticRoutes.size >= 50, `静态路由过少: ${staticRoutes.size}`);
    assert.ok(dynamic.length >= 10, `动态路由过少: ${dynamic.length}`);
  });
});
