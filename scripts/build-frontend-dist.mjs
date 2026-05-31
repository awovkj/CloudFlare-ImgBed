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
import { addCommonAssetIgnores, loadAssetIgnore, shouldIgnoreAsset } from './asset-ignore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dest = path.resolve(root, 'frontend-dist');

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
for (const entry of sourceEntries) {
    const src = path.join(root, entry);
    const dst = path.join(dest, entry);

    try {
        fs.cpSync(src, dst, { recursive: true });
        copied++;
    } catch (error) {
        console.warn(`  skip ${entry}: ${error.message}`);
    }
}

console.log(`✓ Built frontend-dist with ${copied} entries`);
