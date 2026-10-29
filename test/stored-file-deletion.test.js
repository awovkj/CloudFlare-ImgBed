import assert from 'node:assert/strict';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { deleteStoredFile } from '../functions/utils/deleteFile.js';
import { deleteFile, onRequest as deleteRequest } from '../functions/api/manage/delete/[[path]].js';
import { DiscordAPI } from '../functions/utils/discordAPI.js';
import { HuggingFaceAPI } from '../functions/utils/huggingfaceAPI.js';
import { WebDAVAPI } from '../functions/utils/storage/webdavAPI.js';

const FILE_ID = 'folder/report.pdf';
const ORIGIN = 'https://img.example';
const MESSAGE_IDS = ['111111111111111111', '222222222222222222', '333333333333333333'];

function fixture({ channel = 'CloudflareR2', metadata = {}, value = '', uploadConfig, missing = false } = {}) {
    const config = uploadConfig ?? {
        s3: { channels: [{ name: 's3-store', enabled: true, endpoint: 'https://s3.example',
            region: 'auto', bucketName: 'current-bucket', pathStyle: true,
            accessKeyId: 'current-access-key', secretAccessKey: 'current-secret-key' }] },
        discord: { channels: [{ name: 'discord-store', enabled: true,
            botToken: 'current-discord-token', channelId: 'current-channel' }] },
        huggingface: { channels: [{ name: 'hf-store', enabled: true,
            token: 'current-hf-token', repo: 'fixtures/current-repository', isPrivate: false }] },
        webdav: { channels: [{ name: 'webdav-store', enabled: true, baseUrl: 'https://dav.example/storage/',
            username: 'current-user', password: 'current-password', headers: { 'X-Storage-Key': 'current-header' } }] },
    };
    const record = { value, metadata: { ...(channel === undefined ? {} : { Channel: channel }), ...metadata } };
    const records = new Map(missing ? [] : [[FILE_ID, record]]);
    const values = new Map([['manage@sysConfig@upload', JSON.stringify(config)]]);
    const events = [];
    const deletes = [];
    const writes = [];
    const r2Calls = [];
    const env = {
        CF_ZONE_ID: 'fixture-zone', CF_EMAIL: 'fixture@example.com', CF_API_KEY: 'fixture-purge-key',
        img_r2: { async delete(key) { r2Calls.push(key); events.push('remote:r2'); } },
        img_url: {
            async get(key) { return values.get(key) ?? records.get(key)?.value ?? null; },
            async getWithMetadata(key) { return records.get(key) ?? { value: null, metadata: null }; },
            async put(key, data, options = {}) {
                writes.push({ key, value: data, options });
                values.set(key, data);
                records.set(key, { value: data, metadata: options.metadata ?? null });
            },
            async delete(key) {
                deletes.push(key);
                events.push('metadata:delete');
                records.delete(key);
                values.delete(key);
            },
            async list({ prefix = '' } = {}) {
                return { list_complete: true,
                    keys: [...records].filter(([key]) => key.startsWith(prefix)).map(([name, item]) => ({ name, metadata: item.metadata })) };
            },
        },
    };
    return { env, record, records, values, events, deletes, writes, r2Calls };
}

function remove(f) {
    return deleteStoredFile(f.env, FILE_ID, `${ORIGIN}/file/${FILE_ID}`, new URL(ORIGIN));
}

function chunks(count = 3) {
    return Array.from({ length: count }, (_, index) => ({ index, messageId: MESSAGE_IDS[index] ?? String(100000000000000000n + BigInt(index)), size: 4 }));
}

function discordFixture(parts = chunks(), metadata = {}) {
    return fixture({ channel: 'Discord', metadata: { ChannelName: 'discord-store', IsChunked: true, TotalChunks: parts.length, ...metadata },
        value: JSON.stringify(parts) });
}

describe('shared stored-file deletion contract', () => {
    let originalFetch;
    let originalCaches;
    let originalSend;
    let originalDiscordDelete;
    let originalHfDelete;
    let originalWebdavDelete;
    let networkCalls;
    let cacheCalls;
    let s3Calls;
    let discordCalls;
    let hfCalls;
    let webdavCalls;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalCaches = globalThis.caches;
        originalSend = S3Client.prototype.send;
        originalDiscordDelete = DiscordAPI.prototype.deleteMessage;
        originalHfDelete = HuggingFaceAPI.prototype.deleteFile;
        originalWebdavDelete = WebDAVAPI.prototype.deleteFile;
        networkCalls = []; cacheCalls = []; s3Calls = []; discordCalls = []; hfCalls = []; webdavCalls = [];
        globalThis.fetch = async (input, options = {}) => {
            const url = new URL(typeof input === 'string' ? input : input.url);
            networkCalls.push({ url, options });
            assert.equal(url.hostname, 'api.cloudflare.com', 'unexpected provider request escaped the fixture');
            return Response.json({ success: true });
        };
        globalThis.caches = { default: { async put(url, response) { cacheCalls.push({ url, response }); } } };
        S3Client.prototype.send = async function (command) {
            s3Calls.push({ command, credentials: await this.config.credentials(), region: await this.config.region(),
                endpoint: typeof this.config.endpoint === 'function' ? await this.config.endpoint() : this.config.endpoint,
                pathStyle: this.config.forcePathStyle });
            return {};
        };
        DiscordAPI.prototype.deleteMessage = async function (channelId, messageId) {
            discordCalls.push({ token: this.botToken, channelId, messageId });
            return true;
        };
        HuggingFaceAPI.prototype.deleteFile = async function (filePath) {
            hfCalls.push({ token: this.token, repo: this.repo, isPrivate: this.isPrivate, filePath });
            return true;
        };
        WebDAVAPI.prototype.deleteFile = async function (filePath) {
            webdavCalls.push({ baseUrl: this.baseUrl, username: this.username, password: this.password,
                headers: this.getRequestHeaders(), filePath });
            return true;
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.caches = originalCaches;
        S3Client.prototype.send = originalSend;
        DiscordAPI.prototype.deleteMessage = originalDiscordDelete;
        HuggingFaceAPI.prototype.deleteFile = originalHfDelete;
        WebDAVAPI.prototype.deleteFile = originalWebdavDelete;
    });

    function assertPreserved(f) {
        assert.equal(f.records.get(FILE_ID), f.record);
        assert.deepEqual(f.deletes, []);
        assert.deepEqual(f.writes, []);
        assert.equal(networkCalls.filter(call => call.url.hostname === 'api.cloudflare.com').length, 0);
        assert.deepEqual(cacheCalls, []);
    }

    it('keeps the management export as the exact shared implementation', () => {
        assert.equal(deleteFile, deleteStoredFile);
    });

    it('deletes the R2 object before metadata and invalidates caches only on success', async () => {
        const f = fixture();
        assert.equal(await remove(f), true);
        assert.deepEqual(f.r2Calls, [FILE_ID]);
        assert.deepEqual(f.events, ['remote:r2', 'metadata:delete']);
        assert.deepEqual(f.deletes, [FILE_ID]);
        assert.equal(f.records.has(FILE_ID), false);
        assert.equal(networkCalls.length, 1);
        assert.deepEqual(JSON.parse(networkCalls[0].options.body), { files: [`${ORIGIN}/file/${FILE_ID}`] });
        assert.equal(cacheCalls.length, 3);
    });

    for (const shape of ['kv', 'null']) {
        it(`treats a missing ${shape} record as an idempotent no-op`, async () => {
            const f = fixture({ missing: true });
            if (shape === 'null') f.env.img_url.getWithMetadata = async () => null;
            assert.equal(await remove(f), true);
            assert.deepEqual(f.r2Calls, []);
            assert.deepEqual(f.deletes, []);
            assert.deepEqual(f.writes, []);
            assert.deepEqual(networkCalls, []);
            assert.deepEqual(cacheCalls, []);
        });
    }

    for (const fileId of ['manage@sysConfig@upload', 'manage@index@meta', 'chunk_upload_000']) {
        it(`rejects the reserved key ${fileId} before reading or deleting database state`, async () => {
            const f = fixture();
            let reads = 0;
            f.env.img_url.getWithMetadata = async () => {
                reads++;
                return { value: 'internal-state', metadata: {} };
            };
            assert.equal(await deleteStoredFile(f.env, fileId, `${ORIGIN}/file/${fileId}`, new URL(ORIGIN)), false);
            assert.equal(reads, 0);
            assertPreserved(f);
            assert.deepEqual(f.r2Calls, []);
        });
    }

    it('allows a hosted root filename beginning with chunk_ without treating it as internal upload state', async () => {
        const fileId = 'chunk_notes.pdf';
        const f = fixture({ metadata: { FileName: fileId, FileType: 'application/pdf', FileSizeBytes: 10 } });
        f.records.delete(FILE_ID);
        f.records.set(fileId, f.record);
        assert.equal(await deleteStoredFile(f.env, fileId, `${ORIGIN}/file/${fileId}`, new URL(ORIGIN)), true);
        assert.deepEqual(f.r2Calls, [fileId]);
        assert.deepEqual(f.deletes, [fileId]);
        assert.equal(f.records.has(fileId), false);
        assert.equal(networkCalls.length, 1);
        assert.equal(cacheCalls.length, 3);
    });

    it('fails closed for an unrecognized remote storage channel rather than dropping its only reference', async () => {
        const f = fixture({ channel: 'UnrecognizedStorage' });
        assert.equal(await remove(f), false);
        assertPreserved(f);
        assert.deepEqual(f.r2Calls, []);
        assert.deepEqual(s3Calls, []);
        assert.deepEqual(discordCalls, []);
        assert.deepEqual(hfCalls, []);
        assert.deepEqual(webdavCalls, []);
    });

    it('preserves the metadata and skips invalidation when the database read fails', async () => {
        const f = fixture();
        f.env.img_url.getWithMetadata = async () => { throw new Error('fixture database read failed'); };
        assert.equal(await remove(f), false);
        assertPreserved(f);
        assert.deepEqual(f.r2Calls, []);
    });

    it('preserves metadata and skips invalidation when R2 deletion throws', async () => {
        const f = fixture();
        f.env.img_r2.delete = async () => { throw new Error('fixture R2 failed'); };
        assert.equal(await remove(f), false);
        assertPreserved(f);
    });

    it('does not purge caches or claim success when metadata deletion fails after remote deletion', async () => {
        const f = fixture();
        f.env.img_url.delete = async () => { throw new Error('fixture database delete failed'); };
        assert.equal(await remove(f), false);
        assertPreserved(f);
        assert.deepEqual(f.r2Calls, [FILE_ID]);
    });

    for (const channel of ['Telegram', 'TelegramNew', 'External', undefined]) {
        it(`preserves metadata-only deletion compatibility for ${channel ?? 'legacy records without a channel'}`, async () => {
            const f = fixture({ channel });
            if (channel === undefined) delete f.record.metadata.Channel;
            assert.equal(await remove(f), true);
            assert.equal(f.records.has(FILE_ID), false);
            assert.deepEqual(f.r2Calls, []);
            assert.deepEqual(s3Calls, []);
            assert.deepEqual(discordCalls, []);
            assert.deepEqual(hfCalls, []);
            assert.deepEqual(webdavCalls, []);
        });
    }

    it('does not mistake an existing empty legacy record for the KV missing-record envelope', async () => {
        const f = fixture();
        f.record.metadata = null;
        assert.equal(await remove(f), true);
        assert.deepEqual(f.deletes, [FILE_ID]);
    });

    it('does not skip a metadata-bearing record merely because its legacy value is null', async () => {
        const f = fixture({ value: null });
        assert.equal(await remove(f), true);
        assert.deepEqual(f.r2Calls, [FILE_ID]);
        assert.deepEqual(f.deletes, [FILE_ID]);
    });

    it('resolves rotated S3 credentials from configuration while retaining the stored object identity', async () => {
        const f = fixture({ channel: 'S3', metadata: { ChannelName: 's3-store', S3FileKey: 'objects/report.pdf',
            S3AccessKeyId: 'expired-access-key', S3SecretAccessKey: 'expired-secret-key', S3BucketName: 'current-bucket',
            S3Endpoint: 'https://s3.example', S3PathStyle: true } });
        assert.equal(await remove(f), true);
        assert.equal(s3Calls.length, 1);
        assert.ok(s3Calls[0].command instanceof DeleteObjectCommand);
        assert.deepEqual(s3Calls[0].command.input, { Bucket: 'current-bucket', Key: 'objects/report.pdf' });
        assert.equal(s3Calls[0].credentials.accessKeyId, 'current-access-key');
        assert.equal(s3Calls[0].credentials.secretAccessKey, 'current-secret-key');
        assert.equal(s3Calls[0].endpoint.hostname, 's3.example');
        assert.equal(s3Calls[0].pathStyle, true);
    });

    it('can delete a sanitized S3 record that never persisted credentials', async () => {
        const f = fixture({ channel: 'S3', metadata: { ChannelName: 's3-store', S3FileKey: 'objects/report.pdf' } });
        assert.equal(await remove(f), true);
        assert.equal(s3Calls.length, 1);
        assert.equal(s3Calls[0].credentials.secretAccessKey, 'current-secret-key');
    });

    it('preserves the record when the S3 SDK rejects deletion', async () => {
        const f = fixture({ channel: 'S3', metadata: { ChannelName: 's3-store', S3FileKey: 'objects/report.pdf' } });
        S3Client.prototype.send = async () => { throw new Error('fixture S3 rejected deletion'); };
        assert.equal(await remove(f), false);
        assertPreserved(f);
    });

    it('uses a rotated Discord token and configured channel for a sanitized record', async () => {
        const f = fixture({ channel: 'Discord', metadata: { ChannelName: 'discord-store', DiscordMessageId: MESSAGE_IDS[0],
            DiscordBotToken: 'expired-discord-token', DiscordChannelId: 'current-channel' } });
        assert.equal(await remove(f), true);
        assert.deepEqual(discordCalls, [{ token: 'current-discord-token', channelId: 'current-channel', messageId: MESSAGE_IDS[0] }]);
    });

    it('retains Hugging Face object identity while resolving a rotated configured token', async () => {
        const f = fixture({ channel: 'HuggingFace', metadata: { ChannelName: 'hf-store', HfObjectRepo: 'fixtures/original-repository',
            HfObjectPrivate: true, HfFilePath: 'objects/report.pdf', HfToken: 'expired-hf-token', HfRepo: 'fixtures/stale-copy' } });
        assert.equal(await remove(f), true);
        assert.deepEqual(hfCalls, [{ token: 'current-hf-token', repo: 'fixtures/original-repository', isPrivate: true, filePath: 'objects/report.pdf' }]);
    });

    it('uses configured WebDAV credentials and headers instead of stale metadata', async () => {
        const f = fixture({ channel: 'WebDAV', metadata: { ChannelName: 'webdav-store', WebDAVFilePath: 'objects/report.pdf',
            WebDAVBaseUrl: 'https://dav.example/storage/', WebDAVUsername: 'old-user', WebDAVPassword: 'old-password' } });
        assert.equal(await remove(f), true);
        assert.equal(webdavCalls.length, 1);
        assert.equal(webdavCalls[0].baseUrl, 'https://dav.example/storage/');
        assert.equal(webdavCalls[0].username, 'current-user');
        assert.equal(webdavCalls[0].password, 'current-password');
        assert.equal(webdavCalls[0].filePath, 'objects/report.pdf');
        assert.equal(webdavCalls[0].headers.get('X-Storage-Key'), 'current-header');
    });

    const remoteFiles = [
        { channel: 'S3', metadata: { ChannelName: 's3-store', S3FileKey: 'objects/report.pdf', S3AccessKeyId: 'stale-key', S3SecretAccessKey: 'stale-secret' } },
        { channel: 'Discord', metadata: { ChannelName: 'discord-store', DiscordMessageId: MESSAGE_IDS[0], DiscordBotToken: 'stale-token', DiscordChannelId: 'stale-channel' } },
        { channel: 'HuggingFace', metadata: { ChannelName: 'hf-store', HfObjectRepo: 'fixtures/repository', HfFilePath: 'objects/report.pdf', HfToken: 'stale-token' } },
        { channel: 'WebDAV', metadata: { ChannelName: 'webdav-store', WebDAVFilePath: 'objects/report.pdf', WebDAVBaseUrl: 'https://old-dav.example/' } },
    ];
    for (const remote of remoteFiles) {
        it(`fails closed for ${remote.channel} when the configured channel is unavailable`, async () => {
            const f = fixture({ ...remote, uploadConfig: {} });
            assert.equal(await remove(f), false);
            assertPreserved(f);
            assert.deepEqual(s3Calls, []);
            assert.deepEqual(discordCalls, []);
            assert.deepEqual(hfCalls, []);
            assert.deepEqual(webdavCalls, []);
        });
    }

    for (const [name, channel, metadata] of [
        ['S3 endpoint', 'S3', { ChannelName: 's3-store', S3FileKey: 'objects/report.pdf', S3Endpoint: 'https://old-s3.example' }],
        ['S3 bucket', 'S3', { ChannelName: 's3-store', S3FileKey: 'objects/report.pdf', S3BucketName: 'old-bucket' }],
        ['Discord channel', 'Discord', { ChannelName: 'discord-store', DiscordMessageId: MESSAGE_IDS[0], DiscordChannelId: 'old-channel' }],
        ['WebDAV base URL', 'WebDAV', { ChannelName: 'webdav-store', WebDAVFilePath: 'objects/report.pdf', WebDAVBaseUrl: 'https://old-dav.example/storage/' }],
    ]) {
        it(`preserves a legacy object instead of deleting a different target after ${name} drift`, async () => {
            const f = fixture({ channel, metadata });
            assert.equal(await remove(f), false);
            assertPreserved(f);
            assert.deepEqual(s3Calls, []);
            assert.deepEqual(discordCalls, []);
            assert.deepEqual(hfCalls, []);
            assert.deepEqual(webdavCalls, []);
        });
    }

    for (const [name, storedUrl, equivalent] of [
        ['ordinary trailing slash', 'https://dav.example/storage', true],
        ['implicit HTTPS', 'dav.example/storage/', true],
        ['legacy URL credentials', 'https://old-user:old-password@dav.example/storage/', true],
        ['an ignored fragment', 'https://dav.example/storage/#old-fragment', true],
        ['a changed scheme', 'http://dav.example/storage/', false],
        ['a changed port', 'https://dav.example:8443/storage/', false],
        ['a changed object root', 'https://dav.example/other-storage/', false],
        ['a repeated trailing slash', 'https://dav.example/storage//', false],
    ]) {
        it(`compares the actual WebDAV object root safely for ${name}`, async () => {
            const f = fixture({ channel: 'WebDAV', metadata: { ChannelName: 'webdav-store',
                WebDAVFilePath: 'objects/report.pdf', WebDAVBaseUrl: storedUrl } });
            assert.equal(await remove(f), equivalent);
            if (equivalent) {
                assert.equal(webdavCalls.length, 1);
                assert.equal(webdavCalls[0].baseUrl, 'https://dav.example/storage/');
                assert.equal(webdavCalls[0].username, 'current-user');
                assert.equal(f.records.has(FILE_ID), false);
            } else {
                assertPreserved(f);
                assert.deepEqual(webdavCalls, []);
            }
        });
    }

    it('accepts a repeated-slash WebDAV root only when both stored and configured roots retain it', async () => {
        const baseUrl = 'https://dav.example/storage//';
        const f = fixture({ channel: 'WebDAV', metadata: { ChannelName: 'webdav-store',
            WebDAVFilePath: 'objects/report.pdf', WebDAVBaseUrl: baseUrl },
        uploadConfig: { webdav: { channels: [{ name: 'webdav-store', enabled: true, baseUrl,
            username: 'current-user', password: 'current-password' }] } } });
        assert.equal(await remove(f), true);
        assert.equal(webdavCalls.length, 1);
        assert.equal(webdavCalls[0].baseUrl, baseUrl);
    });

    it('does not collapse a repeated trailing slash when comparing an S3 object endpoint', async () => {
        const f = fixture({ channel: 'S3', metadata: { ChannelName: 's3-store', S3FileKey: 'objects/report.pdf',
            S3Endpoint: 'https://s3.example//' } });
        assert.equal(await remove(f), false);
        assertPreserved(f);
        assert.deepEqual(s3Calls, []);
    });

    for (const [channel, prototype, method, metadata] of [
        ['Discord', DiscordAPI.prototype, 'deleteMessage', { ChannelName: 'discord-store', DiscordMessageId: MESSAGE_IDS[0] }],
        ['HuggingFace', HuggingFaceAPI.prototype, 'deleteFile', { ChannelName: 'hf-store', HfObjectRepo: 'fixtures/repository', HfFilePath: 'objects/report.pdf' }],
        ['WebDAV', WebDAVAPI.prototype, 'deleteFile', { ChannelName: 'webdav-store', WebDAVFilePath: 'objects/report.pdf' }],
    ]) {
        for (const failure of ['false', 'throw']) {
            it(`preserves ${channel} metadata when its provider reports ${failure}`, async () => {
                const f = fixture({ channel, metadata });
                prototype[method] = async () => {
                    if (failure === 'throw') throw new Error('fixture provider failed');
                    return false;
                };
                assert.equal(await remove(f), false);
                assertPreserved(f);
            });
        }
    }

    it('deletes every Discord chunk sequentially before committing metadata removal', async () => {
        const f = discordFixture();
        let active = 0;
        let maxActive = 0;
        DiscordAPI.prototype.deleteMessage = async (_channelId, messageId) => {
            active++;
            maxActive = Math.max(maxActive, active);
            f.events.push(`remote:${messageId}`);
            await Promise.resolve();
            active--;
            return true;
        };
        assert.equal(await remove(f), true);
        assert.equal(maxActive, 1);
        assert.deepEqual(f.events, [...MESSAGE_IDS.map(id => `remote:${id}`), 'metadata:delete']);
        assert.equal(f.records.has(FILE_ID), false);
    });

    it('accepts a historical Discord manifest without TotalChunks when the manifest itself is complete', async () => {
        const f = discordFixture();
        delete f.record.metadata.TotalChunks;
        assert.equal(await remove(f), true);
        assert.deepEqual(discordCalls.map(call => call.messageId), MESSAGE_IDS);
    });

    const invalidManifests = [
        ['malformed JSON', '{', 3],
        ['non-array JSON', '{}', 3],
        ['empty parts', '[]', 0],
        ['a missing final message ID', JSON.stringify([chunks()[0], { index: 1, size: 4 }]), 2],
        ['an empty final message ID', JSON.stringify([chunks()[0], { index: 1, messageId: '', size: 4 }]), 2],
        ['duplicate message IDs', JSON.stringify([chunks()[0], { ...chunks()[1], messageId: MESSAGE_IDS[0] }]), 2],
        ['duplicate indices', JSON.stringify([chunks()[0], { ...chunks()[1], index: 0 }]), 2],
        ['a gap in indices', JSON.stringify([chunks()[0], { ...chunks()[1], index: 2 }]), 2],
        ['a negative index', JSON.stringify([{ ...chunks()[0], index: -1 }, chunks()[1]]), 2],
        ['a fractional index', JSON.stringify([{ ...chunks()[0], index: 0.5 }, chunks()[1]]), 2],
        ['a mismatched part count', JSON.stringify(chunks(2)), 3],
    ];
    for (const [name, value, totalChunks] of invalidManifests) {
        it(`validates the whole Discord manifest before deleting any messages: ${name}`, async () => {
            const f = discordFixture(chunks(), { TotalChunks: totalChunks });
            f.record.value = value;
            assert.equal(await remove(f), false);
            assertPreserved(f);
            assert.deepEqual(discordCalls, []);
        });
    }

    it('rejects a Discord manifest above the 10000-part limit before any provider mutation', async () => {
        const f = discordFixture(chunks(10001));
        assert.equal(await remove(f), false);
        assertPreserved(f);
        assert.deepEqual(discordCalls, []);
    });

    it('accepts the exact 10000-part Discord protocol limit without an off-by-one rejection', async () => {
        const f = discordFixture(chunks(10000));
        assert.equal(await remove(f), true);
        assert.equal(discordCalls.length, 10000);
    });

    for (const status of [200, 204, 404, 202, 207, 302, 403, 500]) {
        it(`uses a real WebDAV DELETE with idempotent/mutating status handling: ${status}`, async () => {
            const f = fixture({ channel: 'WebDAV', metadata: { ChannelName: 'webdav-store', WebDAVFilePath: 'objects/report name.pdf' } });
            WebDAVAPI.prototype.deleteFile = originalWebdavDelete;
            globalThis.fetch = async (input, options = {}) => {
                const url = new URL(input);
                networkCalls.push({ url, options });
                if (url.hostname === 'api.cloudflare.com') return Response.json({ success: true });
                assert.equal(url.href, 'https://dav.example/storage/objects/report%20name.pdf');
                assert.equal(options.method, 'DELETE');
                assert.equal(options.redirect, 'manual');
                assert.equal(options.headers.get('X-Storage-Key'), 'current-header');
                assert.equal(options.headers.get('Authorization'), `Basic ${Buffer.from('current-user:current-password').toString('base64')}`);
                return new Response(null, { status, headers: { Location: 'https://other.example/object' } });
            };
            const confirmed = [200, 204, 404].includes(status);
            assert.equal(await remove(f), confirmed);
            if (confirmed) assert.equal(f.records.has(FILE_ID), false);
            else assertPreserved(f);
            assert.equal(networkCalls.filter(call => call.url.hostname !== 'api.cloudflare.com').length, 1);
        });
    }

    for (const status of [200, 201, 204, 202, 207]) {
        it(`requires a completed WebDAV MOVE rather than accepting asynchronous/multistatus responses: ${status}`, async () => {
            const api = new WebDAVAPI({ baseUrl: 'https://dav.example/storage/', createDirectory: false });
            globalThis.fetch = async (input, options = {}) => {
                const url = new URL(input);
                networkCalls.push({ url, options });
                assert.equal(url.href, 'https://dav.example/storage/original.pdf');
                assert.equal(options.method, 'MOVE');
                assert.equal(options.redirect, 'manual');
                return new Response(null, { status });
            };
            const result = api.moveFile('original.pdf', 'renamed.pdf');
            if ([200, 201, 204].includes(status)) assert.equal(await result, true);
            else await assert.rejects(result, /MOVE failed/);
            assert.equal(networkCalls.length, 1);
        });
    }

    for (const status of [204, 404, 302, 403, 500]) {
        it(`uses a real Discord DELETE with idempotent/mutating status handling: ${status}`, async () => {
            const f = fixture({ channel: 'Discord', metadata: { ChannelName: 'discord-store', DiscordMessageId: MESSAGE_IDS[0] } });
            DiscordAPI.prototype.deleteMessage = originalDiscordDelete;
            globalThis.fetch = async (input, options = {}) => {
                const url = new URL(input);
                networkCalls.push({ url, options });
                if (url.hostname === 'api.cloudflare.com') return Response.json({ success: true });
                assert.equal(url.href, `https://discord.com/api/v10/channels/current-channel/messages/${MESSAGE_IDS[0]}`);
                assert.equal(options.method, 'DELETE');
                assert.equal(options.redirect, 'manual');
                assert.equal(new Headers(options.headers).get('Authorization'), 'Bot current-discord-token');
                return new Response(null, { status, headers: { Location: 'https://other.example/object' } });
            };
            assert.equal(await remove(f), status === 204 || status === 404);
            if (status === 204 || status === 404) assert.equal(f.records.has(FILE_ID), false);
            else assertPreserved(f);
            assert.equal(networkCalls.filter(call => call.url.hostname !== 'api.cloudflare.com').length, 1);
        });
    }

    it('retains a partially deleted Discord manifest and safely retries already-missing messages', async () => {
        const f = discordFixture();
        const originalValue = f.record.value;
        const removed = new Set();
        let blockMiddle = true;
        const statuses = [];
        DiscordAPI.prototype.deleteMessage = originalDiscordDelete;
        globalThis.fetch = async (input, options = {}) => {
            const url = new URL(input);
            networkCalls.push({ url, options });
            if (url.hostname === 'api.cloudflare.com') return Response.json({ success: true });
            assert.equal(url.hostname, 'discord.com');
            const id = url.pathname.split('/').pop();
            const status = removed.has(id) ? 404 : (blockMiddle && id === MESSAGE_IDS[1] ? 403 : 204);
            statuses.push(status);
            if (status === 204) removed.add(id);
            return new Response(null, { status });
        };
        assert.equal(await remove(f), false);
        assertPreserved(f);
        assert.equal(f.record.value, originalValue);
        assert.equal(removed.has(MESSAGE_IDS[0]), true);
        blockMiddle = false;
        statuses.length = 0;
        assert.equal(await remove(f), true);
        assert.equal(statuses[0], 404);
        assert.deepEqual([...removed].sort(), [...MESSAGE_IDS].sort());
        assert.equal(f.records.has(FILE_ID), false);
        assert.deepEqual(f.deletes, [FILE_ID]);
    });

    it('still reports committed deletion as successful if CDN purge fails', async () => {
        const f = fixture();
        globalThis.fetch = async () => { throw new Error('fixture cache service failed'); };
        assert.equal(await remove(f), true);
        assert.equal(f.records.has(FILE_ID), false);
        assert.deepEqual(f.deletes, [FILE_ID]);
    });

    it('still records the management index removal after committed deletion and cache failure', async () => {
        const f = fixture();
        const pending = [];
        globalThis.fetch = async () => { throw new Error('fixture cache service failed'); };
        const response = await deleteRequest({ env: f.env,
            request: new Request(`${ORIGIN}/api/manage/delete/${FILE_ID}`, { method: 'DELETE' }),
            params: { path: FILE_ID }, waitUntil(promise) { pending.push(promise); } });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).success, true);
        await Promise.all(pending);
        const operations = f.writes.filter(write => write.key.startsWith('manage@index@operation_')).map(write => JSON.parse(write.value));
        assert.deepEqual(operations.map(operation => operation.type), ['remove']);
        assert.equal(operations[0].data.fileId, FILE_ID);
        assert.equal(f.records.has(FILE_ID), false);
    });

    it('does not schedule management index removal when remote deletion fails', async () => {
        const f = fixture({ channel: 'Discord', metadata: { ChannelName: 'discord-store', DiscordMessageId: MESSAGE_IDS[0] } });
        const pending = [];
        DiscordAPI.prototype.deleteMessage = async () => false;
        const response = await deleteRequest({ env: f.env,
            request: new Request(`${ORIGIN}/api/manage/delete/${FILE_ID}`, { method: 'DELETE' }),
            params: { path: FILE_ID }, waitUntil(promise) { pending.push(promise); } });
        assert.ok(response.status >= 400);
        assert.equal((await response.json()).success, false);
        assert.deepEqual(pending, []);
        assertPreserved(f);
    });
});
