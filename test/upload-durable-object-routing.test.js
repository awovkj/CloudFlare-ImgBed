import assert from 'node:assert/strict';
import {
  extractUploadId,
  isUploadDurableObjectMethodAllowed,
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
  it('prefers the uploadId query parameter over the request header', async () => {
    const request = new Request('https://example.com/upload?chunked=true&uploadId=query-id', {
      method: 'POST',
      headers: { 'X-Upload-Id': 'header-id' },
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

  it('allows GET, POST, and OPTIONS in the upload durable object only', () => {
    assert.equal(isUploadDurableObjectMethodAllowed('GET'), true);
    assert.equal(isUploadDurableObjectMethodAllowed('POST'), true);
    assert.equal(isUploadDurableObjectMethodAllowed('OPTIONS'), true);

    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD']) {
      assert.equal(isUploadDurableObjectMethodAllowed(method), false);
    }
  });
});
