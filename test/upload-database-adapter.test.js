import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkDatabaseConfig, getDatabase } from '../functions/utils/databaseAdapter.js';
import { D1Database } from '../functions/utils/d1Database.js';

function createD1() {
    const files = new Map();
    return {
        files,
        prepare(sql) {
            let args = [];
            return {
                bind(...values) { args = values; return this; },
                async run() {
                    if (sql.startsWith('INSERT OR REPLACE INTO files')) {
                        files.set(args[0], { id: args[0], value: args[1], metadata: args[2] });
                    } else if (sql.startsWith('DELETE FROM files')) {
                        files.delete(args[0]);
                    }
                    return { success: true };
                },
                async first() {
                    if (sql.startsWith('SELECT * FROM files')) return files.get(args[0]) || null;
                    return null;
                },
                async all() {
                    const cutoff = args[1];
                    const limit = args[args.length - 1];
                    return { results: Array.from(files.values()).filter(row => {
                        const m = JSON.parse(row.metadata || '{}').__imgbedInternal;
                        return !(m && m.marker === 'kv-expiry-v1' && m.expiresAt <= cutoff);
                    }).sort((a,b) => a.id.localeCompare(b.id)).slice(0, limit) };
                }
            };
        }
    };
}

describe('database adapter selection', function() {
    it('reports and selects KV when both KV and D1 are configured', async function() {
        const kv = {
            get: async () => 'from-kv',
            put: async () => {},
            getWithMetadata: async () => null,
            delete: async () => {},
            list: async () => ({ keys: [] })
        };
        const env = { img_url: kv, img_d1: createD1() };

        assert.deepEqual(checkDatabaseConfig(env), {
            hasD1: true, hasKV: true, usingD1: false, usingKV: true, configured: true
        });
        assert.equal(await getDatabase(env).get('key'), 'from-kv');
    });

    it('reports D1 as selected when it is the only configured database', function() {
        assert.deepEqual(checkDatabaseConfig({ img_d1: createD1() }), {
            hasD1: true, hasKV: false, usingD1: true, usingKV: false, configured: true
        });
    });
});

describe('D1Database expiry compatibility', function() {
    it('groups TTL predicates before applying prefix and cursor constraints', function() {
        const source = fs.readFileSync(new URL('../functions/utils/d1Database.js', import.meta.url), 'utf8');
        assert.match(source, /WHERE \(json_extract\(metadata/);
    });
    it('expires expirationTtl entries and removes the internal metadata', async function() {
        let now = 1_000_000;
        const raw = createD1();
        const db = new D1Database(raw, () => now);
        await db.put('file', 'body', { expirationTtl: 10, metadata: { FileName: 'a.jpg', custom: 7 } });

        const stored = JSON.parse(raw.files.get('file').metadata);
        assert.equal(stored.__imgbedInternal.expiresAt, 1_010_000);
        assert.deepEqual(await db.getWithMetadata('file'), {
            value: 'body', metadata: { FileName: 'a.jpg', custom: 7 }
        });

        now = 1_010_000;
        assert.equal(await db.get('file'), null);
        assert.equal(raw.files.has('file'), false);
    });

    it('supports absolute expiration without changing ordinary file metadata', async function() {
        let now = 2_000_000;
        const raw = createD1();
        const db = new D1Database(raw, () => now);
        await db.put('absolute', 'value', { expiration: 2005, metadata: { FileType: 'image/png' } });
        await db.put('permanent', 'value', { metadata: { FileName: 'keep.png' } });

        assert.equal(JSON.parse(raw.files.get('absolute').metadata).__imgbedInternal.expiresAt, 2_005_000);
        assert.deepEqual(await db.getWithMetadata('permanent'), {
            value: 'value', metadata: { FileName: 'keep.png' }
        });
        now = 2_005_000;
        assert.equal(await db.getWithMetadata('absolute'), null);
    });

    it('preserves user __expiresAt metadata and hides expired keys from lists', async function() {
        let now = 3_000_000;
        const raw = createD1();
        const db = new D1Database(raw, () => now);
        await db.put('user-meta', 'v', { metadata: { __expiresAt: 'user-value' } });
        await db.put('expired', 'x', { expirationTtl: 1, metadata: { note: 'old' } });
        await db.put('visible', 'y', { metadata: { note: 'ok' } });
        now += 1000;
        assert.deepEqual((await db.getWithMetadata('user-meta')).metadata, { __expiresAt: 'user-value' });
        const listed = await db.list({ limit: 10 });
        assert.deepEqual(listed.keys.map(k => k.name), ['user-meta', 'visible']);
        assert.equal('__imgbedInternal' in listed.keys[0].metadata, false);
        assert.equal('__expiresAt' in listed.keys[0].metadata, true);
    });
});
