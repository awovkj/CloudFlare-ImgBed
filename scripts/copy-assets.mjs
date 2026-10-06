#!/usr/bin/env node
/** Copy the deployable root assets into .wrangler-assets/. */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { copyDeployAssets } from './deploy-assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const dest      = path.resolve(root, '.wrangler-assets');

// Apply bundle patches before copying so deployment always uses the checked-in
// behavior, even after an upstream bundle refresh.
execFileSync(process.execPath, [path.join(root, 'scripts', 'patch-admin-session.mjs')], {
    stdio: 'inherit'
});
execFileSync(process.execPath, [path.join(root, 'scripts', 'patch-music-admin-password.mjs')], {
    stdio: 'inherit'
});
execFileSync(process.execPath, [path.join(root, 'scripts', 'patch-tg-upload-performance.mjs')], {
    stdio: 'inherit'
});

const copied = copyDeployAssets(root);
console.log(`Copied ${copied} entries to ${dest}`);
