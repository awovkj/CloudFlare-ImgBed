#!/usr/bin/env node
/**
 * scripts/copy-assets.mjs
 * 将项目根目录的静态资源复制到 .wrangler-assets/
 * 由 wrangler.toml [build] command 或 npm run build:assets 调用
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { addCommonAssetIgnores, loadAssetIgnore, shouldIgnoreAsset, pruneDeployArtifacts } from './asset-ignore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const dest      = path.resolve(root, '.wrangler-assets');
const frontendDist = path.resolve(root, 'frontend-dist');

// `wrangler deploy` can invoke this script directly and prefer an existing
// frontend-dist directory. Patch/synchronise Telegram assets before choosing
// that source so a stale generated directory cannot undo the upload tuning.
execFileSync(process.execPath, [path.join(root, 'scripts', 'patch-tg-upload-performance.mjs')], {
    stdio: 'inherit'
});

const sourceRoot = fs.existsSync(frontendDist) ? frontendDist : root;

const ignored = addCommonAssetIgnores(sourceRoot === root ? loadAssetIgnore(root) : new Set());

fs.mkdirSync(dest, { recursive: true });

const sourceEntries = new Set(
    fs.readdirSync(sourceRoot).filter((entry) => !shouldIgnoreAsset(entry, ignored))
);

for (const existingEntry of fs.readdirSync(dest)) {
    if (sourceEntries.has(existingEntry)) {
        continue;
    }

    const stalePath = path.join(dest, existingEntry);
    try {
        fs.rmSync(stalePath, { recursive: true, force: true });
    } catch (error) {
        console.warn(`  keep stale ${existingEntry}: ${error.message}`);
    }
}

let copied = 0;
let failed = 0;
for (const entry of sourceEntries) {
    const src = path.join(sourceRoot, entry);
    const dst = path.join(dest, entry);
    try {
        fs.cpSync(src, dst, { recursive: true });
        copied++;
    } catch (error) {
        failed++;
        console.error(`  FAIL ${entry}: ${error.message}`);
    }
}

// 递归清理嵌套开发/文档产物，确保 .wrangler-assets 不含 source map、预压缩 .gz、README 截图
const { removedFiles, removedBytes } = pruneDeployArtifacts(dest);
if (removedFiles > 0) {
    console.log(`✓ Pruned ${removedFiles} dev artifact(s) (~${(removedBytes / 1048576).toFixed(1)} MB)`);
}

console.log(`✓ Copied ${copied} entries from ${path.basename(sourceRoot)} to .wrangler-assets/`);

if (failed > 0) {
    console.error(`✗ ${failed} entr${failed === 1 ? 'y' : 'ies'} failed to copy`);
    process.exit(1);
}
