import fs from 'fs';
import path from 'path';

// Hidden entries are excluded independently; these defaults also protect builds
// when the repository's .assetsignore is missing.
const COMMON_ASSET_IGNORES = [
    'node_modules', 'src', 'functions', 'data', 'database', 'deploy',
    'scripts', 'docs', 'test', 'wrangler.log', 'wrangler.toml',
    'package.json', 'package-lock.json', '*.map', '*.gz',
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
    // Hidden metadata and local secrets must never become public assets.
    const parts = entry.replaceAll('\\', '/').split('/');
    if (parts.some(part => part.startsWith('.'))) return true;
    if (entry === 'static/readme' || entry.startsWith('static/readme/')) return true;
    for (const pattern of ignored) {
        if (matchesAssetIgnore(entry, pattern) || matchesAssetIgnore(parts.at(-1), pattern)) {
            return true;
        }
    }

    return false;
}
