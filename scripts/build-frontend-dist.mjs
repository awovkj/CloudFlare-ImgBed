#!/usr/bin/env node
/**
 * Generate a frontend-dist directory from the current customized root assets.
 *
 * Phase-1 goal:
 * - keep root files as the editable source of truth
 * - produce an upstream-compatible frontend-dist output directory
 * - let Pages / Worker asset pipelines consume frontend-dist consistently
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { addCommonAssetIgnores, loadAssetIgnore, shouldIgnoreAsset, pruneDeployArtifacts } from './asset-ignore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dest = path.resolve(root, 'frontend-dist');

// The checked-in frontend bundle is a generated artifact. Apply the small,
// idempotent Telegram tuning before copying it so every build carries the
// same concurrency/retry settings, including builds started without npm.
execFileSync(process.execPath, [path.join(__dirname, 'patch-tg-upload-performance.mjs')], {
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

// 递归清理顶层过滤无法覆盖的嵌套产物（source map、预压缩 .gz、README 截图）
const { removedFiles, removedBytes } = pruneDeployArtifacts(dest);
if (removedFiles > 0) {
    console.log(`✓ Pruned ${removedFiles} dev artifact(s) (~${(removedBytes / 1048576).toFixed(1)} MB)`);
}

console.log(`✓ Built frontend-dist with ${copied} entries`);

if (failed > 0) {
    console.error(`✗ ${failed} entr${failed === 1 ? 'y' : 'ies'} failed to copy`);
    process.exit(1);
}
