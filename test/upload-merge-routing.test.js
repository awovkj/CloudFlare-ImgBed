import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
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
  it('keeps every chunk merge request in the Worker regardless of uploadId source', async () => {
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

    for (const request of [queryRequest, headerRequest, bodyRequest]) {
      const uploadId = await extractUploadId(request);
      const namespace = createNamespace();

      assert.equal(shouldRouteUploadToDurableObject(request, uploadId), false);
      assert.equal(resolveUploadDurableObject(namespace, request, uploadId), null);
      assert.deepEqual(namespace.calls, []);
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
});
