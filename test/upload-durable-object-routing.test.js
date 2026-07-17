import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertRouteUploadIdMatches,
  buildUploadDurableObjectRouteData,
  createRouteUploadIdMismatchResponse,
  dispatchUploadToDurableObject,
  extractUploadId,
  isRouteUploadIdMismatchError,
  isUploadDurableObjectRequestAllowed,
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
    newUniqueId() {
      calls.push(['newUniqueId']);
      return 'unique:1';
    },
    get(id) {
      calls.push(['get', id]);
      return { id };
    },
  };
}

describe('upload durable object routing', () => {
  it('uses the uploadId query parameter when present', async () => {
    const request = new Request('https://example.com/upload?chunked=true&uploadId=query-id', {
      method: 'POST',
    });

    assert.equal(await extractUploadId(request), 'query-id');
  });

  it('uses X-Upload-Id when the URL does not contain an uploadId', async () => {
    const request = new Request('https://example.com/upload?chunked=true', {
      method: 'POST',
      headers: { 'X-Upload-Id': 'header-id' },
    });

    assert.equal(await extractUploadId(request), 'header-id');
  });

  it('rejects conflicting query and header upload IDs with a stable mismatch error', async () => {
    const request = new Request('https://example.com/upload?chunked=true&uploadId=query-id', {
      method: 'POST',
      headers: { 'X-Upload-Id': 'header-id' },
    });

    await assert.rejects(
      extractUploadId(request),
      error => isRouteUploadIdMismatchError(error) && error.code === 'ROUTE_UPLOAD_ID_MISMATCH',
    );
  });

  it('extracts a merge uploadId from a small compatibility FormData body', async () => {
    const form = new FormData();
    form.set('uploadId', 'merge-id');
    form.set('totalChunks', '3');
    const request = new Request('https://example.com/upload?chunked=true&merge=true', {
      method: 'POST',
      body: form,
    });
    const originalClone = request.clone.bind(request);
    let cloneCalls = 0;
    request.clone = () => {
      cloneCalls += 1;
      return originalClone();
    };

    assert.equal(await extractUploadId(request), 'merge-id');
    assert.equal(cloneCalls, 1, 'small merge compatibility forms may be cloned once');
    assert.equal(request.bodyUsed, false, 'compatibility extraction must preserve the original request body');
  });

  it('rejects a merge body uploadId that differs from its route uploadId', async () => {
    const form = new FormData();
    form.set('uploadId', 'body-id');
    form.set('totalChunks', '3');
    const request = new Request('https://example.com/upload?chunked=true&merge=true&uploadId=route-id', {
      method: 'POST',
      body: form,
    });

    await assert.rejects(
      extractUploadId(request),
      error => isRouteUploadIdMismatchError(error) && error.code === 'ROUTE_UPLOAD_ID_MISMATCH',
    );
  });

  it('does not parse a legacy chunk body without a query or header uploadId', async () => {
    const form = new FormData();
    form.set('uploadId', 'body-only-id');
    form.set('chunkIndex', '0');
    form.set('file', new File([new Uint8Array(1024)], 'chunk.bin'));
    const request = new Request('https://example.com/upload?chunked=true', {
      method: 'POST',
      body: form,
    });
    let cloneCalls = 0;
    request.clone = () => {
      cloneCalls += 1;
      throw new Error('legacy chunk bodies must not be cloned');
    };

    const uploadId = await extractUploadId(request);
    const namespace = createNamespace();

    assert.equal(uploadId, null);
    assert.equal(shouldRouteUploadToDurableObject(request, uploadId), false);
    assert.equal(resolveUploadDurableObject(namespace, request, uploadId), null);
    assert.deepEqual(namespace.calls, []);
    assert.equal(cloneCalls, 0);
    assert.equal(request.bodyUsed, false, 'legacy fallback must leave the original chunk body untouched');
  });

  it('routes init and ordinary uploads to a unique durable object when no uploadId exists', async () => {
    const initRequest = new Request('https://example.com/upload?initChunked=true', { method: 'POST' });
    const ordinaryRequest = new Request('https://example.com/upload', { method: 'POST' });

    assert.equal(await extractUploadId(initRequest), null);
    assert.equal(shouldRouteUploadToDurableObject(initRequest, null), true);
    assert.equal(shouldRouteUploadToDurableObject(ordinaryRequest, null), true);
  });

  it('resolves upload IDs through idFromName and namespace.get', () => {
    const namespace = createNamespace();
    const request = new Request('https://example.com/upload?chunked=true&uploadId=upload-1', {
      method: 'POST',
    });

    assert.deepEqual(resolveUploadDurableObject(namespace, request, 'upload-1'), { id: 'named:upload-1' });
    assert.deepEqual(namespace.calls, [
      ['idFromName', 'upload-1'],
      ['get', 'named:upload-1'],
    ]);
  });

  it('resolves init and ordinary no-ID requests through newUniqueId and namespace.get', () => {
    for (const url of [
      'https://example.com/upload?initChunked=true',
      'https://example.com/upload',
    ]) {
      const namespace = createNamespace();
      const request = new Request(url, { method: 'POST' });

      assert.deepEqual(resolveUploadDurableObject(namespace, request, null), { id: 'unique:1' });
      assert.deepEqual(namespace.calls, [
        ['newUniqueId'],
        ['get', 'unique:1'],
      ]);
    }
  });

  it('returns a 502 response when durable object fetch fails instead of retrying the request locally', async () => {
    const request = new Request('https://example.com/upload?initChunked=true', { method: 'POST' });
    const originalConsoleError = console.error;
    console.error = () => {};
    let response;
    try {
      response = await dispatchUploadToDurableObject({
        async fetch(receivedRequest) {
          assert.equal(receivedRequest, request);
          throw new Error('do unavailable');
        },
      }, request);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      success: false,
      code: 'UPLOAD_DURABLE_OBJECT_FETCH_FAILED',
      message: 'Upload Durable Object request failed',
    });

    const workerSource = fs.readFileSync('src/worker.js', 'utf8');
    assert.match(workerSource, /return dispatchUploadToDurableObject\(stub, request\);/);
    assert.doesNotMatch(workerSource, /stub\.fetch\(request\)/);
  });

  it('stores and enforces the query or header route uploadId in durable object context data', async () => {
    const queryRequest = new Request('https://example.com/upload?uploadId=query-id', {
      headers: { 'X-Upload-Id': 'query-id' },
    });
    const headerRequest = new Request('https://example.com/upload', {
      headers: { 'X-Upload-Id': 'header-id' },
    });

    assert.deepEqual(buildUploadDurableObjectRouteData(queryRequest), { routeUploadId: 'query-id' });
    assert.deepEqual(buildUploadDurableObjectRouteData(headerRequest), { routeUploadId: 'header-id' });
    assert.doesNotThrow(() => assertRouteUploadIdMatches('route-id', 'route-id'));
    let mismatchError;
    assert.throws(() => assertRouteUploadIdMatches('route-id', 'body-id'), error => {
      mismatchError = error;
      return isRouteUploadIdMismatchError(error);
    });
    const mismatchResponse = createRouteUploadIdMismatchResponse(mismatchError);
    assert.equal(mismatchResponse.status, 400);
    assert.equal((await mismatchResponse.json()).code, 'ROUTE_UPLOAD_ID_MISMATCH');

    for (const path of ['functions/upload/chunkUpload.js', 'functions/upload/chunkMerge.js']) {
      const source = fs.readFileSync(path, 'utf8');
      assert.match(source, /assertRouteUploadIdMatches\(context\.data\?\.routeUploadId, uploadId\)/);
      assert.match(source, /return createRouteUploadIdMismatchResponse\(error\)/);
    }
    assert.match(fs.readFileSync('src/uploadDurableObject.js', 'utf8'), /data: buildUploadDurableObjectRouteData\(request\)/);
  });

  it('allows POST and OPTIONS, and allows GET only for cleanup requests', () => {
    assert.equal(isUploadDurableObjectRequestAllowed(new Request('https://example.com/upload', { method: 'POST' })), true);
    assert.equal(isUploadDurableObjectRequestAllowed(new Request('https://example.com/upload', { method: 'OPTIONS' })), true);
    assert.equal(isUploadDurableObjectRequestAllowed(new Request('https://example.com/upload?cleanup=true', { method: 'GET' })), true);
    assert.equal(isUploadDurableObjectRequestAllowed(new Request('https://example.com/upload', { method: 'GET' })), false);

    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD']) {
      assert.equal(isUploadDurableObjectRequestAllowed(new Request('https://example.com/upload?cleanup=true', { method })), false);
    }
    assert.match(fs.readFileSync('src/uploadDurableObject.js', 'utf8'), /isUploadDurableObjectRequestAllowed\(request\)/);
  });
});
