#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadBundleRelativePath = path.join('js', '274.9b7364f3.js');
const uploadBundlePaths = [
    path.join(root, uploadBundleRelativePath),
    path.join(root, 'frontend-dist', uploadBundleRelativePath),
].filter((candidate, index, candidates) =>
    fs.existsSync(candidate) && candidates.indexOf(candidate) === index
);

function countOccurrences(text, needle) {
    let count = 0;
    let offset = 0;

    while ((offset = text.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }

    return count;
}

function replaceExactlyOnce(text, from, to, label) {
    if (text.includes(to)) {
        return text;
    }

    const matches = countOccurrences(text, from);
    if (matches !== 1) {
        throw new Error(`${label}: expected one source match, found ${matches}`);
    }

    return text.replace(from, to);
}

let changedFiles = 0;

for (const uploadBundlePath of uploadBundlePaths) {
    let bundle = fs.readFileSync(uploadBundlePath, 'utf8');

    const patchedBundle = replaceExactlyOnce(
        replaceExactlyOnce(
            bundle,
            'const f=("discord"===o||"telegram"===o)?3:6,',
            'const f="telegram"===o?4:"discord"===o?3:6,',
            'Telegram chunk concurrency'
        ),
        'let b=0;const v=5;while(b<v)',
        'let b=0;const v="telegram"===o?3:5;while(b<v)',
        'Telegram request retry count'
    );

    if (patchedBundle !== bundle) {
        fs.writeFileSync(uploadBundlePath, patchedBundle, 'utf8');
        changedFiles += 1;
    }
}

// frontend-dist is generated and ignored by git, but Wrangler uses it when it
// already exists. Keep the separately loaded lane scheduler in sync as well,
// otherwise a direct `wrangler deploy` could silently ship the old scheduler.
const laneSourcePath = path.join(root, 'js', 'tg-upload-lanes.js');
const laneTargetPath = path.join(root, 'frontend-dist', 'js', 'tg-upload-lanes.js');
if (fs.existsSync(laneSourcePath) && fs.existsSync(laneTargetPath)) {
    const laneSource = fs.readFileSync(laneSourcePath, 'utf8');
    if (fs.readFileSync(laneTargetPath, 'utf8') !== laneSource) {
        fs.copyFileSync(laneSourcePath, laneTargetPath);
        changedFiles += 1;
    }
}

console.log(`✓ Applied Telegram large-upload performance patch (${changedFiles} file${changedFiles === 1 ? '' : 's'} updated)`);
