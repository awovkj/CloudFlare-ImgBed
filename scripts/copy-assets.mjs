#!/usr/bin/env node
/**
 * scripts/copy-assets.mjs
 * 将项目根目录的静态资源复制到 .wrangler-assets/
 * 由 wrangler.toml [build] command 或 npm run build:assets 调用
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addCommonAssetIgnores, loadAssetIgnore, shouldIgnoreAsset } from './asset-ignore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const dest      = path.resolve(root, '.wrangler-assets');
const frontendDist = path.resolve(root, 'frontend-dist');
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
for (const entry of sourceEntries) {
    const src = path.join(sourceRoot, entry);
    const dst = path.join(dest, entry);
    try {
        fs.cpSync(src, dst, { recursive: true });
        copied++;
    } catch (error) {
        console.warn(`  skip ${entry}: ${error.message}`);
    }
}

console.log(`✓ Copied ${copied} entries from ${path.basename(sourceRoot)} to .wrangler-assets/`);
