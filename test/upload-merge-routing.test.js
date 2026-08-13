import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createSerialExecutor,
  extractUploadId,
  resolveUploadDurableObject,
  shouldRouteUploadToDurableObject,
} from '../src/uploadRequestRouting.js';

function createNamespace() {
  const calls = [];
  return {
    calls,
    idFromName(uploadId) {
      calls.push(['idFromName', uploadId]);
      return `named:${uploadId}`;
    },
    get(id) {
      calls.push(['get', id]);
      return { id };
    },
  };
}

describe('merge upload routing', () => {
  it('serializes overlapping merge work for one durable object instance', async () => {
    const runSerial = createSerialExecutor();
    const order = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => {
      releaseFirst = resolve;
    });

    const first = runSerial(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = runSerial(async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.resolve();
    assert.deepEqual(order, ['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('routes chunk merge requests to the Durable Object when uploadId is available', async () => {
    const queryRequest = new Request(
      'https://example.com/upload?chunked=true&merge=true&uploadId=query-id',
      { method: 'POST' },
    );
    const headerRequest = new Request(
      'https://example.com/upload?chunked=true&merge=true',
      { method: 'POST', headers: { 'X-Upload-Id': 'header-id' } },
    );
    const body = new FormData();
    body.set('uploadId', 'body-id');
    body.set('totalChunks', '2');
    const bodyRequest = new Request(
      'https://example.com/upload?chunked=true&merge=true',
      { method: 'POST', headers: { 'Content-Length': '256' }, body },
    );

    const cases = [
      [queryRequest, 'query-id'],
      [headerRequest, 'header-id'],
      [bodyRequest, 'body-id'],
    ];

    for (const [request, expectedId] of cases) {
      const uploadId = await extractUploadId(request);
      const namespace = createNamespace();

      assert.equal(uploadId, expectedId);
      assert.equal(shouldRouteUploadToDurableObject(request, uploadId), true);
      assert.deepEqual(resolveUploadDurableObject(namespace, request, uploadId), { id: `named:${expectedId}` });
      assert.deepEqual(namespace.calls, [
        ['idFromName', expectedId],
        ['get', `named:${expectedId}`],
      ]);
    }
  });

  it('does not change non-merge durable object routing', async () => {
    const request = new Request(
      'https://example.com/upload?chunked=true&uploadId=chunk-id',
      { method: 'POST' },
    );
    const uploadId = await extractUploadId(request);
    const namespace = createNamespace();

    assert.equal(shouldRouteUploadToDurableObject(request, uploadId), true);
    assert.deepEqual(resolveUploadDurableObject(namespace, request, uploadId), { id: 'named:chunk-id' });
    assert.deepEqual(namespace.calls, [
      ['idFromName', 'chunk-id'],
      ['get', 'named:chunk-id'],
    ]);
  });

  it('propagates the route uploadId before any local Worker fallback', () => {
    const source = fs.readFileSync('src/worker.js', 'utf8');
    const methodCheck = source.indexOf('const methodRejection = getUploadRequestMethodRejection(request)');
    const routeExtraction = source.indexOf('extractRouteUploadId(request)');
    const localFallback = source.indexOf("if (!env.UPLOAD_DO || env.DISABLE_UPLOAD_DO === 'true')");

    assert.ok(methodCheck >= 0, 'method validation must exist');
    assert.ok(routeExtraction > methodCheck, 'route uploadId must be extracted after method validation');
    assert.ok(localFallback > routeExtraction, 'route uploadId must be propagated before local fallback');
    assert.match(source, /context\.data\.routeUploadId\s*=\s*extractRouteUploadId\(request\)/);
    assert.match(source, /isRouteUploadIdMismatchError\(error\)[\s\S]*createRouteUploadIdMismatchResponse\(error\)/);
  });

  it('routes non-merge durable object requests through the serial executor', () => {
    const source = fs.readFileSync('src/uploadDurableObject.js', 'utf8');

    assert.match(source, /createSerialExecutor/);
    assert.match(source, /this\.runSerial/);
    // 非 merge 请求（cleanup 等）仍走 runSerial
    assert.match(source, /return this\.runSerial\(\(\) => this\._handleRequest\(request\)\)/);
  });

  it('bypasses runSerial for merge requests to avoid blocking polling and cleanup', () => {
    const source = fs.readFileSync('src/uploadDurableObject.js', 'utf8');

    // 合并请求通过 activeMergePromise 内存锁控制并发，不走 runSerial
    assert.match(source, /activeMergePromise/);
    assert.match(source, /_handleMergeRequest/);
    // 合并期间轮询请求立即返回 409，不触碰 KV
    assert.match(source, /MERGE_IN_PROGRESS/);
    assert.match(source, /createMergeInProgressResponse/);
    // merge=true 检测在 runSerial 之前
    const mergeCheck = source.indexOf("get('merge') === 'true'");
    const runSerialCall = source.indexOf('return this.runSerial');
    assert.ok(mergeCheck >= 0, 'merge request detection must exist');
    assert.ok(runSerialCall > mergeCheck, 'merge check must come before the runSerial fallback');
  });
});
