import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, '.wrangler-assets');

const assetItems = [
  'index.html',
  'index.html.gz',
  'stats.html',
  'css',
  'js',
  'fonts',
  'img',
  'static',
  'logo.png',
  'logo-dark.png'
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const item of assetItems) {
  const src = join(root, item);
  if (!existsSync(src)) {
    continue;
  }

  const dest = join(outDir, item);
  cpSync(src, dest, { recursive: true });
}
