#!/usr/bin/env node
/** Copy the deployable root assets into .wrangler-assets/. */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { addCommonAssetIgnores, loadAssetIgnore, shouldIgnoreAsset, pruneDeployArtifacts } from './asset-ignore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const dest      = path.resolve(root, '.wrangler-assets');

// Apply bundle patches before copying so deployment always uses the checked-in
// behavior, even after an upstream bundle refresh.
execFileSync(process.execPath, [path.join(root, 'scripts', 'patch-music-admin-password.mjs')], {
    stdio: 'inherit'
});
execFileSync(process.execPath, [path.join(root, 'scripts', 'patch-tg-upload-performance.mjs')], {
    stdio: 'inherit'
});

const ignored = addCommonAssetIgnores(loadAssetIgnore(root));

fs.mkdirSync(dest, { recursive: true });

const sourceEntries = new Set(
    fs.readdirSync(root).filter((entry) => !shouldIgnoreAsset(entry, ignored))
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
    const src = path.join(root, entry);
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

console.log(`✓ Copied ${copied} entries to .wrangler-assets/`);

if (failed > 0) {
    console.error(`✗ ${failed} entr${failed === 1 ? 'y' : 'ies'} failed to copy`);
    process.exit(1);
}
