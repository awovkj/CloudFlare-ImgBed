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

// 部署产物中禁止出现的嵌套开发/文档文件。
// .assetsignore 的顶层过滤无法覆盖 js/*.map、static/readme/* 等嵌套路径，
// 因此在生成部署目录后再递归清理一次，作为权威的兜底。
const PRUNE_FILE_SUFFIXES = ['.map', '.gz'];
const PRUNE_DIR_RELPATHS = ['static/readme'];

export function pruneDeployArtifacts(destDir) {
    let removedFiles = 0;
    let removedBytes = 0;

    // 先删除整目录（README 截图等）
    for (const rel of PRUNE_DIR_RELPATHS) {
        const dirPath = path.join(destDir, ...rel.split('/'));
        if (fs.existsSync(dirPath)) {
            try {
                removedBytes += dirSize(dirPath);
                fs.rmSync(dirPath, { recursive: true, force: true });
                removedFiles++;
            } catch (error) {
                console.warn(`  prune skip ${rel}: ${error.message}`);
            }
        }
    }

    // 再递归删除按后缀匹配的文件（source map、预压缩 .gz）
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (error) {
            console.warn(`  prune walk ${current}: ${error.message}`);
            return;
        }
        for (const dirent of entries) {
            const full = path.join(current, dirent.name);
            if (dirent.isDirectory()) {
                walk(full);
            } else if (PRUNE_FILE_SUFFIXES.some((suffix) => dirent.name.endsWith(suffix))) {
                try {
                    removedBytes += fs.statSync(full).size;
                    fs.rmSync(full, { force: true });
                    removedFiles++;
                } catch (error) {
                    console.warn(`  prune skip ${full}: ${error.message}`);
                }
            }
        }
    };
    walk(destDir);

    return { removedFiles, removedBytes };
}

function dirSize(dirPath) {
    let total = 0;
    for (const dirent of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, dirent.name);
        if (dirent.isDirectory()) {
            total += dirSize(full);
        } else {
            try { total += fs.statSync(full).size; } catch { /* ignore */ }
        }
    }
    return total;
}
