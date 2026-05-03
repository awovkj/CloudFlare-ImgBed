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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dest = path.resolve(root, 'frontend-dist');

function loadIgnore() {
    const ignoreFile = path.join(root, '.assetsignore');
    if (!fs.existsSync(ignoreFile)) {
        return new Set();
    }

    return new Set(
        fs.readFileSync(ignoreFile, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
    );
}

function matchesIgnore(entry, pattern) {
    if (pattern === entry || pattern === `${entry}/`) {
        return true;
    }

    if (!pattern.includes('*')) {
        return false;
    }

    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(entry) || regex.test(`${entry}/`);
}

function shouldIgnore(entry, ignored) {
    for (const pattern of ignored) {
        if (matchesIgnore(entry, pattern)) {
            return true;
        }
    }

    return false;
}

const ignored = loadIgnore();
ignored.add('frontend-dist');
ignored.add('frontend-dist/');
ignored.add('.wrangler-assets');
ignored.add('.wrangler-assets/');
ignored.add('.wrangler-pages-dev.log');
ignored.add('.wrangler-pages-func-build');
ignored.add('.wrangler-pages-func-build/');
ignored.add('database');
ignored.add('database/');
ignored.add('deploy');
ignored.add('deploy/');
ignored.add('scripts');
ignored.add('scripts/');
ignored.add('wrangler.log');

fs.mkdirSync(dest, { recursive: true });

const sourceEntries = new Set(
    fs.readdirSync(root).filter((entry) => !shouldIgnore(entry, ignored))
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
