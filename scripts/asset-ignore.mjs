import fs from 'fs';
import path from 'path';

const COMMON_ASSET_IGNORES = [
    '.wrangler-assets',
    '.wrangler-assets/',
    'frontend-dist',
    'frontend-dist/',
    '.wrangler-pages-dev.log',
    '.wrangler-pages-func-build',
    '.wrangler-pages-func-build/',
    'database',
    'database/',
    'deploy',
    'deploy/',
    'scripts',
    'scripts/',
    'wrangler.log',
];

export function loadAssetIgnore(root) {
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

export function addCommonAssetIgnores(ignored) {
    for (const pattern of COMMON_ASSET_IGNORES) {
        ignored.add(pattern);
    }

    return ignored;
}

export function matchesAssetIgnore(entry, pattern) {
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

export function shouldIgnoreAsset(entry, ignored) {
    for (const pattern of ignored) {
        if (matchesAssetIgnore(entry, pattern)) {
            return true;
        }
    }

    return false;
}
