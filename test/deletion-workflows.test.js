import assert from 'node:assert/strict';
import { onRequest as manageDelete } from '../functions/api/manage/delete/[[path]].js';
import { onRequest as batchDelete } from '../functions/api/manage/delete/batch.js';
import { onRequest as manageList } from '../functions/api/manage/list.js';
import { onRequest as serveDav } from '../functions/dav/[[path]].js';

const origin = 'https://img.example';
const operationPrefix = 'manage@index@operation_';
const providerDetail = 'provider-failure-with-private-token';
const davAuthorization = `Basic ${btoa('fixture-dav:fixture-password')}`;

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function requestUrl(input) {
    return new URL(input instanceof Request ? input.url : String(input));
}

function fixture(files = [], vars = {}) {
    const records = new Map(files.map(({ id, metadata = {}, value = '' }) => [id, {
        value,
        metadata: { Channel: 'CloudflareR2', FileName: id, ...metadata },
    }]));
    records.set('manage@sysConfig@others', {
        value: JSON.stringify({
            webDAV: {
                enabled: true,
                username: 'fixture-dav',
                password: 'fixture-password',
                internalToken: 'fixture-internal-token',
            },
        }),
        metadata: null,
    });
    const writes = [];
    const deletes = [];
    const remoteDeletes = [];
    const pending = [];
    const failedRemoteIds = new Set();
    const env = {
        ...vars,
        img_url: {
            async get(key) { return records.get(key)?.value ?? null; },
            async getWithMetadata(key) { return records.get(key) ?? { value: null, metadata: null }; },
            async put(key, value, options = {}) {
                writes.push({ key, value, options });
                records.set(key, { value, metadata: options.metadata ?? null });
            },
            async delete(key) {
                deletes.push(key);
                records.delete(key);
            },
            async list({ prefix = '', limit = 1000 } = {}) {
                const keys = [...records].filter(([key]) => key.startsWith(prefix))
                    .slice(0, limit).map(([name, record]) => ({ name, metadata: record.metadata }));
                return { keys, list_complete: true };
            },
        },
        img_r2: {
            async delete(key) {
                remoteDeletes.push(key);
                if (failedRemoteIds.has(key)) throw new Error(providerDetail);
            },
        },
    };
    function context(id, { method = 'DELETE', folder = false, body, headers = {}, dav = false } = {}) {
        const path = id.split('/').map(encodeURIComponent).join('/');
        const request = new Request(`${origin}/${dav ? 'dav' : 'api/manage/delete'}/${path}${folder ? '?folder=true' : ''}`, {
            method,
            headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
            env,
            request,
            params: { path: encodeURIComponent(id.split('/').join(',')) },
            data: {},
            waitUntil(promise) { pending.push(Promise.resolve(promise)); },
        };
    }
    function operations() {
        return writes.filter(write => write.key.startsWith(operationPrefix)).map(write => JSON.parse(write.value));
    }
    return { env, records, writes, deletes, remoteDeletes, pending, failedRemoteIds, context, operations };
}

describe('deletion route and index failure contracts', () => {
    let originalFetch;
    let originalCaches;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalCaches = globalThis.caches;
        globalThis.caches = { default: { async put() {} } };
        globalThis.fetch = async input => { throw new Error(`Unexpected fetch: ${requestUrl(input)}`); };
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
    });

    it('reports a folder partial failure and indexes only confirmed deletions', async () => {
        const good = 'reports/good.pdf';
        const bad = 'reports/bad.pdf';
        const f = fixture([{ id: good }, { id: bad }]);
        f.failedRemoteIds.add(bad);
        globalThis.fetch = async input => {
            const url = requestUrl(input);
            assert.equal(url.pathname, '/api/manage/list');
            assert.equal(url.searchParams.get('dir'), 'reports');
            return jsonResponse({ files: [{ name: good }, { name: bad }], directories: [] });
        };

        const response = await manageDelete(f.context('reports', { folder: true }));
        const result = await response.json();
        await Promise.all(f.pending);
        assert.equal(response.status, 200);
        assert.equal(result.success, false);
        assert.deepEqual(result.deleted, [good]);
        assert.deepEqual(result.failed, [bad]);
        assert.equal(f.records.has(good), false);
        assert.equal(f.records.has(bad), true);
        assert.deepEqual(f.operations().map(operation => operation.data), [{ fileIds: [good] }]);
    });

    it('reports complete folder success and traverses nested folders', async () => {
        const files = ['reports/a.pdf', 'reports/nested/b.pdf'];
        const f = fixture(files.map(id => ({ id })));
        const listed = [];
        globalThis.fetch = async input => {
            const dir = requestUrl(input).searchParams.get('dir');
            listed.push(dir);
            if (dir === 'reports') {
                return jsonResponse({ files: [{ name: files[0] }], directories: ['reports/nested'] });
            }
            assert.equal(dir, 'reports/nested');
            return jsonResponse({ files: [{ name: files[1] }], directories: [] });
        };

        const response = await manageDelete(f.context('reports', { folder: true }));
        const result = await response.json();
        await Promise.all(f.pending);
        assert.equal(result.success, true);
        assert.deepEqual(result.deleted, files);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(listed, ['reports', 'reports/nested']);
        assert.deepEqual(f.operations().map(operation => operation.data), [{ fileIds: files }]);
    });

    it('does not remove index entries when every folder deletion fails', async () => {
        const fileId = 'reports/retained.pdf';
        const f = fixture([{ id: fileId }]);
        f.failedRemoteIds.add(fileId);
        globalThis.fetch = async () => jsonResponse({ files: [{ name: fileId }], directories: [] });

        const result = await (await manageDelete(f.context('reports', { folder: true }))).json();
        await Promise.all(f.pending);
        assert.equal(result.success, false);
        assert.deepEqual(result.deleted, []);
        assert.deepEqual(result.failed, [fileId]);
        assert.equal(f.records.has(fileId), true);
        assert.deepEqual(f.operations(), []);
    });

    for (const failure of ['http', 'json', 'network']) {
        it(`indexes earlier folder deletions even after a later ${failure} listing failure`, async () => {
            const fileId = 'reports/deleted.pdf';
            const f = fixture([{ id: fileId }]);
            globalThis.fetch = async input => {
                if (requestUrl(input).searchParams.get('dir') === 'reports') {
                    return jsonResponse({ files: [{ name: fileId }], directories: ['reports/nested'] });
                }
                if (failure === 'http') return new Response(providerDetail, { status: 503 });
                if (failure === 'json') return new Response(providerDetail);
                throw new Error(providerDetail);
            };

            const response = await manageDelete(f.context('reports', { folder: true }));
            const text = await response.text();
            const result = JSON.parse(text);
            await Promise.all(f.pending);
            assert.equal(response.status, 400);
            assert.equal(result.success, false);
            assert.deepEqual(result.deleted, [fileId]);
            assert.equal(f.records.has(fileId), false);
            assert.deepEqual(f.operations().map(operation => operation.data), [{ fileIds: [fileId] }]);
            assert.equal(text.includes(providerDetail), false);
        });
    }

    it('encodes a complete folder name instead of treating its characters as query syntax', async () => {
        const folder = 'reports &count=1#draft%/inner';
        const f = fixture();
        const listed = [];
        globalThis.fetch = async input => {
            const url = requestUrl(input);
            listed.push(url);
            return jsonResponse({ files: [], directories: [] });
        };

        const result = await (await manageDelete(f.context(folder, { folder: true }))).json();
        assert.equal(result.success, true);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].searchParams.get('dir'), folder);
        assert.equal(listed[0].searchParams.get('count'), '-1');
        assert.equal(listed[0].hash, '');
        assert.equal([...listed[0].searchParams].length, 2);
    });

    const invalidFolderListings = [
        { label: 'an error-shaped response', value: { error: providerDetail, files: [], directories: [] } },
        { label: 'an explicit failure flag', value: { success: false, files: [{ name: 'reports/retained.pdf' }], directories: [] } },
        { label: 'a malformed files collection', value: { files: {}, directories: [] } },
        { label: 'a missing directories collection', value: { files: [{ name: 'reports/retained.pdf' }] } },
    ];
    for (const { label, value } of invalidFolderListings) {
        it(`rejects HTTP 200 folder listings with ${label} before mutation`, async () => {
            const fileId = 'reports/retained.pdf';
            const f = fixture([{ id: fileId }]);
            globalThis.fetch = async () => jsonResponse(value);

            const response = await manageDelete(f.context('reports', { folder: true }));
            const text = await response.text();
            const result = JSON.parse(text);
            await Promise.all(f.pending);
            assert.equal(response.status, 400);
            assert.equal(result.success, false);
            assert.deepEqual(result.deleted, []);
            assert.deepEqual(result.failed, []);
            assert.equal(text.includes(providerDetail), false);
            assert.equal(f.records.has(fileId), true);
            assert.deepEqual(f.remoteDeletes, []);
            assert.deepEqual(f.deletes, []);
            assert.deepEqual(f.writes, []);
        });
    }

    const invalidDatabaseListings = [
        { label: 'an unavailable database', read: async () => { throw new Error(providerDetail); } },
        { label: 'malformed listing keys', read: async () => ({ keys: {}, list_complete: true }) },
        { label: 'incomplete pagination without a cursor', read: async () => ({ keys: [], list_complete: false }) },
    ];
    for (const { label, read } of invalidDatabaseListings) {
        it(`returns 500 instead of an empty successful fallback listing for ${label}`, async () => {
            const fileId = 'reports/retained.pdf';
            const f = fixture([{ id: fileId }]);
            const prefixes = [];
            f.env.img_url.list = async ({ prefix = '' } = {}) => {
                prefixes.push(prefix);
                if (prefix === 'reports/') return read();
                throw new Error(providerDetail);
            };
            const context = f.context('reports', { method: 'GET' });
            context.request = new Request(`${origin}/api/manage/list?dir=reports&count=-1`);
            const originalNow = Date.now;
            // Expire the shared index cache so the actual database fallback runs.
            Date.now = () => originalNow() + 60_000;
            try {
                const response = await manageList(context);
                const text = await response.text();
                const result = JSON.parse(text);
                await Promise.all(f.pending);
                assert.equal(response.status, 500);
                assert.equal(response.headers.get('Cache-Control'), 'no-store');
                assert.equal(result.success, false);
                assert.equal(result.code, 'INTERNAL_SERVER_ERROR');
                assert.equal(result.error, 'Internal Server Error');
                assert.equal(typeof result.requestId, 'string');
                assert.equal(text.includes(providerDetail), false);
                assert.ok(prefixes.includes('reports/'));
                assert.equal(f.records.has(fileId), true);
                assert.deepEqual(f.remoteDeletes, []);
                assert.deepEqual(f.deletes, []);
                assert.deepEqual(f.writes, []);
            } finally {
                Date.now = originalNow;
            }
        });
    }

    it('preserves a failed single deletion and returns a generic error without index writes', async () => {
        const fileId = 'reports/retained.pdf';
        const f = fixture([{ id: fileId }]);
        f.failedRemoteIds.add(fileId);

        const response = await manageDelete(f.context(fileId));
        const text = await response.text();
        assert.equal(response.status, 400);
        assert.equal(JSON.parse(text).success, false);
        assert.equal(text.includes(providerDetail), false);
        assert.equal(f.records.has(fileId), true);
        assert.deepEqual(f.deletes, []);
        assert.deepEqual(f.operations(), []);
    });

    it('retains the legacy GET deletion contract and records a successful single index removal', async () => {
        const fileId = 'reports/deleted.pdf';
        const f = fixture([{ id: fileId }]);

        const response = await manageDelete(f.context(fileId, { method: 'GET' }));
        const result = await response.json();
        await Promise.all(f.pending);
        assert.equal(response.status, 200);
        assert.equal(result.success, true);
        assert.equal(result.fileId, fileId);
        assert.deepEqual(f.remoteDeletes, [fileId]);
        assert.deepEqual(f.operations().map(operation => ({ type: operation.type, data: operation.data })), [
            { type: 'remove', data: { fileId } },
        ]);
    });

    it('lets idempotent missing-file deletion remove a stale index entry', async () => {
        const fileId = 'reports/already-deleted.pdf';
        const f = fixture();

        const result = await (await manageDelete(f.context(fileId))).json();
        await Promise.all(f.pending);
        assert.equal(result.success, true);
        assert.deepEqual(f.remoteDeletes, []);
        assert.deepEqual(f.deletes, []);
        assert.deepEqual(f.operations().map(operation => operation.data), [{ fileId }]);
    });

    it('deduplicates a mixed batch and removes only successful files from the index', async () => {
        const good = 'reports/good.pdf';
        const bad = 'reports/bad.pdf';
        const f = fixture([{ id: good }, { id: bad }]);
        f.failedRemoteIds.add(bad);

        const response = await batchDelete(f.context('batch', {
            method: 'POST',
            body: { fileIds: [good, bad, good, ` /${good}/ `] },
        }));
        const text = await response.text();
        const result = JSON.parse(text);
        await Promise.all(f.pending);
        assert.equal(response.status, 200);
        assert.equal(result.success, false);
        assert.deepEqual(result.deleted, [good]);
        assert.deepEqual(result.failed.map(item => item.fileId), [bad]);
        assert.equal(text.includes(providerDetail), false);
        assert.deepEqual(f.remoteDeletes.sort(), [bad, good].sort());
        assert.equal(f.records.has(bad), true);
        assert.deepEqual(f.operations().map(operation => operation.data), [{ fileIds: [good] }]);
    });

    it('rejects a batch larger than 500 before any storage or metadata mutation', async () => {
        const f = fixture();
        const response = await batchDelete(f.context('batch', {
            method: 'POST',
            body: { fileIds: Array.from({ length: 501 }, (_, i) => `file-${i}.pdf`) },
        }));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).success, false);
        assert.deepEqual(f.remoteDeletes, []);
        assert.deepEqual(f.deletes, []);
        assert.deepEqual(f.writes, []);
    });

    it('keeps batch provider concurrency bounded at ten while preserving all results', async () => {
        const fileIds = Array.from({ length: 25 }, (_, i) => `reports/${i}.pdf`);
        const f = fixture(fileIds.map(id => ({ id })));
        let active = 0;
        let maximumActive = 0;
        f.env.img_r2.delete = async key => {
            f.remoteDeletes.push(key);
            active++;
            maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
        };

        const response = await batchDelete(f.context('batch', { method: 'POST', body: { fileIds } }));
        const result = await response.json();
        await Promise.all(f.pending);
        assert.equal(result.success, true);
        assert.deepEqual(result.deleted, fileIds);
        assert.deepEqual(result.failed, []);
        assert.ok(maximumActive > 1);
        assert.ok(maximumActive <= 10, `Observed ${maximumActive} simultaneous provider deletes`);
        assert.deepEqual(f.operations().map(operation => operation.data), [{ fileIds }]);
    });
});

describe('WebDAV deletion acknowledgements', () => {
    let originalFetch;
    let originalCaches;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalCaches = globalThis.caches;
        globalThis.caches = { default: { async put() {} } };
        globalThis.fetch = async input => { throw new Error(`Unexpected fetch: ${requestUrl(input)}`); };
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
    });

    it('acknowledges only a confirmed successful management deletion', async () => {
        const f = fixture();
        const calls = [];
        globalThis.fetch = async (input, options) => {
            calls.push({ url: requestUrl(input), options });
            return jsonResponse({ success: true, deleted: ['reports/file.pdf'], failed: [] });
        };

        const response = await serveDav(f.context('reports/', {
            dav: true,
            headers: { Authorization: davAuthorization },
        }));
        assert.equal(response.status, 204);
        assert.equal(await response.text(), '');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.method, 'DELETE');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-internal-token');
        assert.equal(calls[0].url.searchParams.get('folder'), 'true');
    });

    const invalidAcknowledgements = [
        { label: 'an explicit partial failure', value: { success: false, failed: ['retained.pdf'], error: providerDetail } },
        { label: 'a stale success flag with failed files', value: { success: true, failed: ['retained.pdf'] } },
        { label: 'a truthy non-boolean success flag', value: { success: 'true', failed: [] } },
        { label: 'a failed HTTP response with a success body', value: { success: true, failed: [] }, status: 403 },
        { label: 'an accepted but unfinished HTTP response', value: { success: true, failed: [] }, status: 202 },
        { label: 'a multistatus HTTP response', value: { success: true, failed: [] }, status: 207 },
        { label: 'a body without an explicit success flag', value: { deleted: [], failed: [] } },
    ];
    for (const { label, value, status = 200 } of invalidAcknowledgements) {
        it(`does not return 204 for ${label}`, async () => {
            const f = fixture();
            globalThis.fetch = async () => jsonResponse(value, status);

            const response = await serveDav(f.context('reports/', {
                dav: true,
                headers: { Authorization: davAuthorization },
            }));
            assert.equal(response.status, 500);
            assert.equal((await response.text()).includes(providerDetail), false);
        });
    }

    it('does not leak exception details when the management delete request fails', async () => {
        const f = fixture();
        globalThis.fetch = async () => { throw new Error(providerDetail); };

        const response = await serveDav(f.context('reports/file.pdf', {
            dav: true,
            headers: { Authorization: davAuthorization },
        }));
        assert.equal(response.status, 500);
        assert.equal((await response.text()).includes(providerDetail), false);
    });

    it('rejects malformed deletion acknowledgement JSON without exposing its body', async () => {
        const f = fixture();
        globalThis.fetch = async () => new Response('private-key');

        const response = await serveDav(f.context('reports/file.pdf', {
            dav: true,
            headers: { Authorization: davAuthorization },
        }));
        assert.equal(response.status, 500);
        assert.equal((await response.text()).includes('private-key'), false);
    });

    it('preserves reserved filename characters in the management delete URL', async () => {
        const fileId = 'reports/finance?#draft%.pdf';
        const f = fixture();
        const calls = [];
        globalThis.fetch = async input => {
            calls.push(requestUrl(input));
            return jsonResponse({ success: true, failed: [] });
        };

        const response = await serveDav(f.context(fileId, {
            dav: true,
            headers: { Authorization: davAuthorization },
        }));
        assert.equal(response.status, 204);
        assert.equal(calls.length, 1);
        assert.equal(decodeURIComponent(calls[0].pathname.slice('/api/manage/delete/'.length)), fileId);
        assert.equal(calls[0].search, '');
        assert.equal(calls[0].hash, '');
    });

    it('propagates an actual partial folder deletion without losing failed records or index results', async () => {
        const good = 'reports/good.pdf';
        const bad = 'reports/bad.pdf';
        const f = fixture([{ id: good }, { id: bad }]);
        f.failedRemoteIds.add(bad);
        globalThis.fetch = async input => {
            const url = requestUrl(input);
            if (url.pathname === '/api/manage/list') {
                return jsonResponse({ files: [{ name: good }, { name: bad }], directories: [] });
            }
            assert.ok(url.pathname.startsWith('/api/manage/delete/'));
            return manageDelete(f.context('reports', { folder: true }));
        };

        const response = await serveDav(f.context('reports/', {
            dav: true,
            headers: { Authorization: davAuthorization },
        }));
        await Promise.all(f.pending);
        assert.equal(response.status, 500);
        assert.equal(f.records.has(good), false);
        assert.equal(f.records.has(bad), true);
        assert.deepEqual(f.operations().map(operation => operation.data), [{ fileIds: [good] }]);
    });

    for (const kind of ['file', 'folder']) {
        for (const { label, value, raw, status = 200 } of [
            { label: 'an explicit failure', value: { success: false, failed: ['retained.pdf'] } },
            { label: 'failed files despite a success flag', value: { success: true, failed: ['retained.pdf'] } },
            { label: 'an unfinished 202 acknowledgement', value: { success: true, failed: [] }, status: 202 },
            { label: 'a 207 multistatus acknowledgement', value: { success: true, failed: [] }, status: 207 },
            { label: 'malformed acknowledgement JSON', raw: 'private-key' },
        ]) {
            it(`does not overwrite an existing ${kind} after ${label}`, async () => {
                const destination = kind === 'file' ? 'destination.pdf' : 'destination/';
                const existingId = kind === 'file' ? destination : 'destination/retained.pdf';
                const f = fixture([{ id: 'source.pdf' }, { id: existingId }]);
                const calls = [];
                globalThis.fetch = async (input, options) => {
                    const url = requestUrl(input);
                    calls.push({ url, options });
                    if (url.pathname.startsWith('/api/manage/delete/')) {
                        return raw === undefined ? jsonResponse(value, status) : new Response(raw, { status });
                    }
                    return jsonResponse({ success: true });
                };

                const response = await serveDav(f.context('source.pdf', {
                    dav: true,
                    method: 'MOVE',
                    headers: { Authorization: davAuthorization, Destination: `${origin}/dav/${destination}` },
                }));
                assert.equal(response.status, 500);
                assert.equal((await response.text()).includes('private-key'), false);
                assert.equal(calls.length, 1);
                assert.ok(calls[0].url.pathname.startsWith('/api/manage/delete/'));
                assert.equal(calls[0].url.searchParams.get('folder'), kind === 'folder' ? 'true' : null);
                assert.equal(f.records.has('source.pdf'), true);
                assert.equal(f.records.has(existingId), true);
            });
        }
    }

    it('continues a successful overwrite only after confirmed destination deletion', async () => {
        const f = fixture([{ id: 'source.pdf' }, { id: 'destination.pdf' }]);
        const calls = [];
        globalThis.fetch = async (input, options) => {
            const url = requestUrl(input);
            calls.push({ url, options });
            if (url.pathname.startsWith('/api/manage/delete/')) {
                return jsonResponse({ success: true, failed: [] });
            }
            assert.ok(url.pathname.startsWith('/api/manage/rename/'));
            return jsonResponse({ success: true });
        };

        const response = await serveDav(f.context('source.pdf', {
            dav: true,
            method: 'MOVE',
            headers: { Authorization: davAuthorization, Destination: `${origin}/dav/destination.pdf` },
        }));
        assert.equal(response.status, 204);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].options.method, 'DELETE');
        assert.equal(calls[1].options.method, 'POST');
        assert.deepEqual(JSON.parse(calls[1].options.body), { newFileId: 'destination.pdf' });
        assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer fixture-internal-token'));
    });

    it('keeps Overwrite: F side-effect free for an existing destination', async () => {
        const f = fixture([{ id: 'source.pdf' }, { id: 'destination.pdf' }]);
        const response = await serveDav(f.context('source.pdf', {
            dav: true,
            method: 'MOVE',
            headers: {
                Authorization: davAuthorization,
                Destination: `${origin}/dav/destination.pdf`,
                Overwrite: 'F',
            },
        }));
        assert.equal(response.status, 412);
        assert.deepEqual(f.deletes, []);
        assert.deepEqual(f.writes, []);
    });
});
