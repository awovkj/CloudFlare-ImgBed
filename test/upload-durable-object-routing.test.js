import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  extractUploadId,
  shouldRouteUploadToDurableObject,
} from '../src/uploadRequestRouting.js';

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

    assert.equal(uploadId, null);
    assert.equal(shouldRouteUploadToDurableObject(request, uploadId), false);
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

  it('uses a named durable object for upload IDs and allows cleanup GET requests', () => {
    const workerSource = fs.readFileSync('src/worker.js', 'utf8');
    const durableObjectSource = fs.readFileSync('src/uploadDurableObject.js', 'utf8');

    assert.match(workerSource, /idFromName\(uploadId\)/);
    assert.match(durableObjectSource, /\['GET', 'POST', 'OPTIONS'\]/);
  });
});
