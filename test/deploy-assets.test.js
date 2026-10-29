import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyDeployAssets } from '../scripts/deploy-assets.mjs';
import { shouldIgnoreAsset, addCommonAssetIgnores, loadAssetIgnore } from '../scripts/asset-ignore.mjs';

describe('deploy assets', () => {
    let root;
    const put = (name, value = 'fixture') => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
    };
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgbed-assets-')); });
    afterEach(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('imgbed-assets-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    it('excludes hidden secrets, nested maps and documentation before copying', () => {
        fs.copyFileSync('.assetsignore', path.join(root, '.assetsignore'));
        for (const name of ['index.html', 'music.html', 'js/app.js', 'css/app.css',
            '.env', '.dev.vars', '.aws/credentials', '.workbuddy-ai/state.json',
            'js/app.js.map', 'js/app.js.gz', 'js/.env', 'static/readme/demo.png',
            'functions/api.js', 'node_modules/example/index.js']) put(name);
        copyDeployAssets(root);
        const exists = name => fs.existsSync(path.join(root, '.wrangler-assets', name));
        for (const name of ['index.html', 'music.html', 'js/app.js', 'css/app.css']) assert.ok(exists(name), name);
        for (const name of ['.env', '.dev.vars', '.aws', '.workbuddy-ai', 'js/app.js.map',
            'js/app.js.gz', 'js/.env', 'static/readme', 'functions', 'node_modules']) assert.equal(exists(name), false, name);
    });
    it('removes stale nested bundles and handles file/directory type changes', () => {
        put('js/current.js'); put('.wrangler-assets/js/old.js');
        put('.wrangler-assets/removed.html'); put('.wrangler-assets/js/current.js/old');
        copyDeployAssets(root);
        assert.equal(fs.existsSync(path.join(root, '.wrangler-assets/js/old.js')), false);
        assert.equal(fs.existsSync(path.join(root, '.wrangler-assets/removed.html')), false);
        assert.equal(fs.readFileSync(path.join(root, '.wrangler-assets/js/current.js'), 'utf8'), 'fixture');
        copyDeployAssets(root);
        assert.equal(fs.existsSync(path.join(root, '.wrangler-assets/.wrangler-assets')), false);
    });
    it('refuses a linked destination without modifying its target', () => {
        put('outside/keep.txt');
        fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.wrangler-assets'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => copyDeployAssets(root), /symbolic link/);
        assert.ok(fs.existsSync(path.join(root, 'outside/keep.txt')));
        fs.unlinkSync(path.join(root, '.wrangler-assets'));
    });
    it('retains all public standalone pages under the repository ignore policy', () => {
        const ignored = addCommonAssetIgnores(loadAssetIgnore('.'));
        for (const page of ['index.html', 'music.html', 'video.html', 'chat.html', 'stats.html', 'document-preview.html']) {
            assert.equal(shouldIgnoreAsset(page, ignored), false);
        }
    });
    it('deploys local document renderers but excludes credentials, test output and source configuration', () => {
        fs.copyFileSync('.assetsignore', path.join(root, '.assetsignore'));
        const included = ['document-preview.html', 'js/document-office-worker.js', 'js/document-docx-frame.js',
            'js/document-archive-guards.js', 'js/vendor/jszip-3.10.1.min.js', 'js/vendor/xlsx-0.20.3.full.min.js'];
        const excluded = ['js/vendor/README.md', '.playwright-mcp/preview.png', 'private.pem', 'nested/server.key',
            'credentials.json', 'tsconfig.audit.json', 'build/main.js', 'dist/main.js', 'coverage/index.html', 'nested/worker.log', 'img/\u6d77\u62a5.png'];
        for (const name of [...included, ...excluded]) put(name);
        copyDeployAssets(root);
        for (const name of included) assert.ok(fs.existsSync(path.join(root, '.wrangler-assets', name)), name);
        for (const name of excluded) assert.equal(fs.existsSync(path.join(root, '.wrangler-assets', name)), false, name);
    });
});
