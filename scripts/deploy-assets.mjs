import fs from 'node:fs';
import path from 'node:path';
import { addCommonAssetIgnores, loadAssetIgnore, shouldIgnoreAsset } from './asset-ignore.mjs';

/** Build a fresh asset tree; never follow links or retain removed nested bundles. */
export function copyDeployAssets(sourceRoot) {
    const root = fs.realpathSync(sourceRoot);
    const dest = path.resolve(root, '.wrangler-assets');
    const ignored = addCommonAssetIgnores(loadAssetIgnore(root));
    // Validate the exact deletion target before any recursive filesystem operation.
    if (path.dirname(dest) !== root || path.basename(dest) !== '.wrangler-assets') {
        throw new Error('Unsafe asset destination');
    }
    if (fs.existsSync(dest)) {
        assertNoLinks(dest);
        if (fs.realpathSync(dest) !== dest) throw new Error('Unsafe asset destination');
        fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.mkdirSync(dest, { recursive: true });
    let copied = 0;
    for (const entry of fs.readdirSync(root)) {
        if (shouldIgnoreAsset(entry, ignored)) continue;
        const src = path.join(root, entry);
        if (fs.lstatSync(src).isSymbolicLink()) continue;
        fs.cpSync(src, path.join(dest, entry), {
            recursive: true,
            filter: candidate => !fs.lstatSync(candidate).isSymbolicLink()
                && !shouldIgnoreAsset(path.relative(root, candidate).split(path.sep).join('/'), ignored),
        });
        copied++;
    }
    return copied;
}

function assertNoLinks(directory) {
    if (fs.lstatSync(directory).isSymbolicLink()) {
        throw new Error('Asset destination contains a symbolic link: ' + directory);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Asset destination contains a symbolic link: ' + full);
        if (entry.isDirectory()) assertNoLinks(full);
    }
}
