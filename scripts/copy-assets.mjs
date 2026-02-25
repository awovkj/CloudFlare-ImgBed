#!/usr/bin/env node
/**
 * scripts/copy-assets.mjs
 * 将项目根目录的静态资源复制到 .wrangler-assets/
 * 由 wrangler.toml [build] command 或 npm run build:assets 调用
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');
const dest      = path.resolve(root, '.wrangler-assets');

// 读取 .assetsignore 排除规则
function loadIgnore() {
    const ignoreFile = path.join(root, '.assetsignore');
    if (!fs.existsSync(ignoreFile)) return new Set();
    return new Set(
        fs.readFileSync(ignoreFile, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
    );
}

const ignored = loadIgnore();
// 目标目录本身也排除
ignored.add('.wrangler-assets');
ignored.add('.wrangler-assets/');

fs.mkdirSync(dest, { recursive: true });

let copied = 0;
for (const entry of fs.readdirSync(root)) {
    if (ignored.has(entry) || ignored.has(entry + '/')) continue;
    const src = path.join(root, entry);
    const dst = path.join(dest, entry);
    try {
        fs.cpSync(src, dst, { recursive: true });
        copied++;
    } catch (e) {
        console.warn(`  skip ${entry}: ${e.message}`);
    }
}

console.log(`✓ Copied ${copied} entries to .wrangler-assets/`);
