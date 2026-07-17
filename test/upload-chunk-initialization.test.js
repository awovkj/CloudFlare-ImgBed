import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validateChunkInitialization } from '../functions/upload/chunkProtocol.js';

function createKv(config = {}) {
  const values = new Map();
  const puts = [];

  return {
    values,
    puts,
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value, options = {}) {
      if (config.failPut?.(key)) {
        throw new Error('secret persistence detail');
      }
      puts.push({ key, value, options });
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function createInitializationRequest(fields, query = '') {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, String(value));
  }

  return new Request(`https://example.com/upload?initChunked=true${query}`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '127.0.0.1' },
    body: form,
  });
}

async function withStubbedIpLookup(callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('chunk initialization', () => {
  it('uses explicit .js imports, the shared validator, stable JSON errors, and crypto UUIDs', () => {
    const source = fs.readFileSync('functions/upload/chunkUpload.js', 'utf8');

    assert.doesNotMatch(source, /from ['"]\.{1,2}\/[^'"]+(?<!\.js)['"]/);
    assert.match(source, /from ['"]\.\/chunkProtocol\.js['"]/);
    assert.match(source, /validateChunkInitialization\(/);
    assert.match(source, /uploadError\(/);
    assert.match(source, /createUploadJsonResponse\(/);
    assert.match(source, /crypto\.randomUUID\(\)/);
  });

  it('preserves optional file metadata after validating the chunk layout', () => {
    assert.deepEqual(validateChunkInitialization({
      totalChunks: '2',
      fileSize: '10',
      chunkSize: '5',
      fileFingerprint: 'sha256:abc',
    }), {
      ok: true,
      totalChunks: 2,
      fileSize: 10,
      chunkSize: 5,
      fileFingerprint: 'sha256:abc',
    });
  });

  it('rejects totalChunks outside 1..10000 with a stable 400 JSON code', async () => {
    const { initializeChunkedUpload } = await import('../functions/upload/chunkUpload.js');
    const kv = createKv();
    const request = createInitializationRequest({
      originalFileName: 'video.mp4',
      totalChunks: 10001,
    });

    const response = await initializeChunkedUpload({
      request,
      url: new URL(request.url),
      env: { img_url: kv },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      success: false,
      code: 'INVALID_TOTAL_CHUNKS',
      message: 'Invalid chunk upload initialization parameters',
    });
    assert.equal(kv.puts.length, 0);
  });

  it('persists schema-v2 session and manifest records while keeping legacy response fields', async () => {
    const { initializeChunkedUpload } = await import('../functions/upload/chunkUpload.js');
    const kv = createKv();
    const request = createInitializationRequest({
      originalFileName: 'video.mp4',
      originalFileType: 'video/mp4',
      totalChunks: 2,
      fileSize: 10,
      chunkSize: 5,
      fileFingerprint: 'sha256:abc',
    }, '&uploadChannel=telegram&channelName=primary');

    const response = await withStubbedIpLookup(() => initializeChunkedUpload({
      request,
      url: new URL(request.url),
      env: { img_url: kv },
    }));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.match(payload.uploadId, /^upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(payload.message, 'Chunked upload initialized successfully');
    assert.deepEqual(payload.sessionInfo, {
      uploadId: payload.uploadId,
      originalFileName: 'video.mp4',
      totalChunks: 2,
      uploadChannel: 'telegram',
      channelName: 'primary',
    });

    const session = JSON.parse(kv.values.get(`upload_session_${payload.uploadId}`));
    const manifest = JSON.parse(kv.values.get(`upload_manifest_${payload.uploadId}`));

    for (const record of [session, manifest]) {
      assert.equal(record.schemaVersion, 2);
      assert.equal(record.revision, 0);
      assert.equal(record.uploadId, payload.uploadId);
      assert.equal(record.totalChunks, 2);
      assert.equal(record.fileSize, 10);
      assert.equal(record.chunkSize, 5);
      assert.equal(record.fileFingerprint, 'sha256:abc');
      assert.equal(Number.isFinite(record.updatedAt), true);
      assert.equal(record.updatedAt >= record.createdAt, true);
      assert.equal(record.expiresAt, record.createdAt + 3600000);
    }
    assert.deepEqual(manifest.chunks, {});
  });

  it('keeps optional metadata absent for legacy initialization requests', async () => {
    const { initializeChunkedUpload } = await import('../functions/upload/chunkUpload.js');
    const kv = createKv();
    const request = createInitializationRequest({
      originalFileName: 'legacy.bin',
      totalChunks: 1,
    }, '&uploadChannel=telegram');

    const response = await withStubbedIpLookup(() => initializeChunkedUpload({
      request,
      url: new URL(request.url),
      env: { img_url: kv },
    }));
    const payload = await response.json();
    const session = JSON.parse(kv.values.get(`upload_session_${payload.uploadId}`));

    assert.equal(response.status, 200);
    assert.equal(Object.hasOwn(session, 'fileSize'), false);
    assert.equal(Object.hasOwn(session, 'chunkSize'), false);
    assert.equal(Object.hasOwn(session, 'fileFingerprint'), false);
  });

  it('returns a stable JSON 500 without leaking internal initialization errors', async () => {
    const { initializeChunkedUpload } = await import('../functions/upload/chunkUpload.js');
    const kv = createKv({ failPut: () => true });
    const request = createInitializationRequest({
      originalFileName: 'video.mp4',
      totalChunks: 1,
    }, '&uploadChannel=telegram');

    const originalConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args);
    let response;
    try {
      response = await withStubbedIpLookup(() => initializeChunkedUpload({
        request,
        url: new URL(request.url),
        env: { img_url: kv },
      }));
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(response.status, 500);
    const responseText = await response.text();
    assert.deepEqual(JSON.parse(responseText), {
      success: false,
      code: 'CHUNK_INITIALIZATION_FAILED',
      message: 'Failed to initialize chunked upload',
    });
    assert.equal(responseText.includes('secret persistence detail'), false);
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0][1].message, 'secret persistence detail');
  });
});
