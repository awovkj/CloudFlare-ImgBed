import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fileTools from '../functions/file/fileTools.js';

const fileRouteSource = fs.readFileSync('functions/file/[[path]].js', 'utf8');

function streamBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function compileFileRoute(overrides = {}) {
  const routeStart = fileRouteSource.indexOf('export async function onRequest');
  assert.notEqual(routeStart, -1, 'file route entry point is missing');

  const executableSource = fileRouteSource
    .slice(routeStart)
    .replace('export async function onRequest', 'async function onRequest');

  const fixedLengthCalls = [];
  const dependencies = {
    S3Client: class {},
    GetObjectCommand: class {},
    fetchSecurityConfig: async () => ({ access: { allowedDomains: '', whiteListMode: false } }),
    TelegramAPI: class {},
    DiscordAPI: class {},
    HuggingFaceAPI: { getMetadataFileSize: metadata => metadata?.FileSizeBytes ?? null },
    buildWebDAVUrl: (baseUrl, path) => new URL(path, baseUrl).toString(),
    WebDAVAPI: class {},
    setCommonHeaders: fileTools.setCommonHeaders,
    setRangeHeaders: fileTools.setRangeHeaders,
    handleHeadRequest: fileTools.handleHeadRequest,
    getFileContent: async () => null,
    isTgChannel: fileTools.isTgChannel,
    returnWithCheck: async () => new Response('success'),
    return404: async () => new Response('not found', { status: 404 }),
    returnBlockImg: async () => new Response('blocked', { status: 403 }),
    isDomainAllowed: () => true,
    FILE_CACHE_CONTROL: fileTools.FILE_CACHE_CONTROL,
    createFixedLengthBody(body, length) {
      fixedLengthCalls.push(length);
      return body;
    },
    parseSingleRange: fileTools.parseSingleRange,
    resolveResponseLength: fileTools.resolveResponseLength,
    getDatabase: env => env.__db,
    authenticate: async () => ({ authorized: false, authType: null }),
    AUTH_SCOPE: { ADMIN: 'admin' },
    resolveDiscordCredentials: async () => ({}),
    resolveHuggingFaceCredentials: async () => ({}),
    resolveS3Credentials: async () => ({}),
    resolveTelegramCredentials: async () => ({ botToken: 'token', proxyUrl: '' }),
    resolveWebDAVCredentials: async () => ({}),
    buildCdnFileUrl: () => '',
    ...overrides,
  };

  const names = Object.keys(dependencies);
  const factory = new Function(
    ...names,
    `${executableSource}\nreturn { onRequest };`,
  );

  return {
    ...factory(...names.map(name => dependencies[name])),
    fixedLengthCalls,
  };
}

function createContext(record, { method = 'GET', headers = {}, env = {} } = {}) {
  const request = new Request('https://img.example/file/archive.zip', { method, headers });
  return {
    request,
    env: {
      ...env,
      __db: {
        async getWithMetadata() {
          return record;
        },
      },
    },
    params: { path: 'archive.zip' },
    waitUntil() {},
    next() {},
    data: {},
  };
}

function createR2Binding(fileBytes) {
  return {
    async get(_key, options = {}) {
      const range = options.range;
      const start = range?.offset ?? 0;
      const requestedLength = range?.length ?? (fileBytes.length - start);
      const bodyBytes = fileBytes.slice(start, start + requestedLength);

      return {
        size: fileBytes.length,
        range: range ? { offset: start, length: bodyBytes.length } : undefined,
        body: streamBytes(bodyBytes),
        writeHttpMetadata(headers) {
          headers.set('Content-Type', 'application/zip');
        },
      };
    },
  };
}

function chunkedTelegramRecord() {
  return {
    value: JSON.stringify([
      { index: 0, size: 4, fileId: 'first' },
      { index: 1, size: 4, fileId: 'second' },
    ]),
    metadata: {
      Channel: 'TelegramNew',
      IsChunked: true,
      TotalChunks: 2,
      TimeStamp: 123,
      FileName: 'archive.zip',
      FileType: 'application/zip',
      FileSizeBytes: 8,
    },
  };
}

describe('IDM-compatible file download responses', () => {
  describe('single byte range parsing', () => {
    function parse(header, totalSize) {
      assert.equal(typeof fileTools.parseSingleRange, 'function', 'parseSingleRange must be exported');
      return fileTools.parseSingleRange(header, totalSize);
    }

    it('accepts bounded, open-ended, and suffix ranges', () => {
      const bounded = parse('bytes=2-5', 10);
      assert.equal(bounded.start, 2);
      assert.equal(bounded.end, 5);

      const openEnded = parse('bytes=5-', 10);
      assert.equal(openEnded.start, 5);
      assert.equal(openEnded.end, 9);

      const suffix = parse('bytes=-4', 10);
      assert.equal(suffix.start, 6);
      assert.equal(suffix.end, 9);

      const clamped = parse('bytes=0-10', 10);
      assert.equal(clamped.start, 0);
      assert.equal(clamped.end, 9);
    });

    it('rejects malformed, multiple, reversed, and unsatisfiable ranges', () => {
      const invalidRanges = [
        'bytes=0-1,4-5',
        'bytes=5-4',
        'bytes=10-',
        'bytes=1.5-3',
        'bytes=-',
        'items=0-1',
      ];

      for (const range of invalidRanges) {
        assert.equal(parse(range, 10), null, range);
      }
    });
  });

  describe('known response length resolution', () => {
    function resolve(headers, fallbackSize = null) {
      assert.equal(typeof fileTools.resolveResponseLength, 'function', 'resolveResponseLength must be exported');
      return fileTools.resolveResponseLength(new Headers(headers), fallbackSize);
    }

    it('prefers the partial length from Content-Range', () => {
      assert.equal(resolve({
        'Content-Range': 'bytes 20-29/100',
        'Content-Length': '100',
      }, 100), 10);
    });

    it('uses Content-Length and then the metadata fallback', () => {
      assert.equal(resolve({ 'Content-Length': '42' }, 100), 42);
      assert.equal(resolve({}, 100), 100);
      assert.equal(resolve({ 'Content-Length': 'invalid' }, '73'), 73);
      assert.equal(resolve({}, null), null);
    });
  });

  it('reports the complete R2 object size on HEAD requests', async () => {
    const fileBytes = new TextEncoder().encode('0123456789');
    const { onRequest, fixedLengthCalls } = compileFileRoute();
    const response = await onRequest(createContext({
      value: '',
      metadata: {
        Channel: 'CloudflareR2',
        FileName: 'archive.zip',
        FileType: 'application/zip',
        FileSizeBytes: fileBytes.length,
      },
    }, {
      method: 'HEAD',
      env: { img_r2: createR2Binding(fileBytes) },
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), String(fileBytes.length));
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(await response.text(), '');
    assert.deepEqual(fixedLengthCalls, []);
  });

  it('uses fixed-length bodies for complete and ranged R2 downloads', async () => {
    const fileBytes = new TextEncoder().encode('0123456789');
    const record = {
      value: '',
      metadata: {
        Channel: 'CloudflareR2',
        FileName: 'archive.zip',
        FileType: 'application/zip',
        FileSizeBytes: fileBytes.length,
      },
    };

    const fullRoute = compileFileRoute();
    const fullResponse = await fullRoute.onRequest(createContext(record, {
      env: { img_r2: createR2Binding(fileBytes) },
    }));
    assert.equal(fullResponse.status, 200);
    assert.equal(fullResponse.headers.get('Content-Length'), '10');
    assert.equal(await fullResponse.text(), '0123456789');
    assert.deepEqual(fullRoute.fixedLengthCalls, [10]);

    const rangeRoute = compileFileRoute();
    const rangeResponse = await rangeRoute.onRequest(createContext(record, {
      headers: { Range: 'bytes=2-5' },
      env: { img_r2: createR2Binding(fileBytes) },
    }));
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get('Content-Length'), '4');
    assert.equal(rangeResponse.headers.get('Content-Range'), 'bytes 2-5/10');
    assert.equal(await rangeResponse.text(), '2345');
    assert.deepEqual(rangeRoute.fixedLengthCalls, [4]);
  });

  it('falls back to FileSizeBytes when an upstream HEAD omits Content-Length', async () => {
    const fileBytes = new TextEncoder().encode('zip-content');
    const record = {
      value: '',
      metadata: {
        Channel: 'Telegraph',
        FileName: 'archive.zip',
        FileType: 'application/zip',
        FileSizeBytes: fileBytes.length,
      },
    };
    const route = compileFileRoute({
      getFileContent: async request => request.method === 'HEAD'
        ? new Response(null, { headers: { 'Content-Type': 'application/zip' } })
        : new Response(streamBytes(fileBytes), { headers: { 'Content-Type': 'application/zip' } }),
    });

    const response = await route.onRequest(createContext(record, { method: 'HEAD' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), String(fileBytes.length));
    assert.equal(await response.text(), '');
    assert.deepEqual(route.fixedLengthCalls, []);
  });

  it('does not report a false zero length when a legacy HEAD size is unknown', async () => {
    const route = compileFileRoute({
      getFileContent: async () => new Response(null, {
        headers: { 'Content-Type': 'application/zip' },
      }),
    });

    const response = await route.onRequest(createContext({
      value: '',
      metadata: {
        Channel: 'Telegraph',
        FileName: 'legacy.zip',
        FileType: 'application/zip',
      },
    }, { method: 'HEAD' }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), null);
    assert.deepEqual(route.fixedLengthCalls, []);
  });

  it('uses FileSizeBytes and a fixed-length body for a complete upstream download', async () => {
    const fileBytes = new TextEncoder().encode('zip-content');
    const record = {
      value: '',
      metadata: {
        Channel: 'Telegraph',
        FileName: 'archive.zip',
        FileType: 'application/zip',
        FileSizeBytes: fileBytes.length,
      },
    };
    const route = compileFileRoute({
      getFileContent: async () => new Response(streamBytes(fileBytes), {
        headers: { 'Content-Type': 'application/zip' },
      }),
    });

    const response = await route.onRequest(createContext(record));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), String(fileBytes.length));
    assert.equal(await response.text(), 'zip-content');
    assert.deepEqual(route.fixedLengthCalls, [fileBytes.length]);
  });

  it('returns an exact fixed-length body for a range spanning Telegram chunks', async () => {
    const chunks = {
      first: new TextEncoder().encode('abcd'),
      second: new TextEncoder().encode('efgh'),
    };
    const route = compileFileRoute({
      TelegramAPI: class {
        async getFileContent(fileId) {
          return new Response(chunks[fileId]);
        }
      },
    });

    const response = await route.onRequest(createContext(chunkedTelegramRecord(), {
      headers: { Range: 'bytes=2-6' },
    }));

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Length'), '5');
    assert.equal(response.headers.get('Content-Range'), 'bytes 2-6/8');
    assert.equal(await response.text(), 'cdefg');
    assert.deepEqual(route.fixedLengthCalls, [5]);
  });

  it('rejects an IDM-style multi-range request instead of serving its first segment', async () => {
    const fallbackChunk = new TextEncoder().encode('abcd');
    const route = compileFileRoute({
      TelegramAPI: class {
        async getFileContent() {
          return new Response(fallbackChunk);
        }
      },
    });

    const response = await route.onRequest(createContext(chunkedTelegramRecord(), {
      headers: { Range: 'bytes=0-1,4-5' },
    }));

    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */8');
    assert.deepEqual(route.fixedLengthCalls, []);
  });
});
