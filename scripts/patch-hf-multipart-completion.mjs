#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const original = 'n.length>0&&(r.multipartParts=n,r.uploadAction=i.uploadAction);';
const patched = 'n.length>0&&(r.multipartParts=n);';
const originalLog = 'console.log("Upload info:",i)';
const patchedLog = 'console.log("LFS upload mode:",i.alreadyExists?"already-exists":i.uploadAction?.header?.chunk_size?"multipart":"basic")';

export function patchHfMultipartCommit(bundle) {
    const oldCount = bundle.split(original).length - 1;
    const newCount = bundle.split(patched).length - 1;
    if (oldCount === 0 && newCount === 1) return bundle;
    if (oldCount !== 1 || newCount !== 0) {
        throw new Error('HF multipart commit patch: expected exactly one supported commit expression');
    }
    // Completion uses the issued server session, not a replay of signed part URLs.
    return bundle.replace(original, patched);
}

export function redactHfUploadInfo(bundle) {
    const oldCount = bundle.split(originalLog).length - 1;
    const newCount = bundle.split(patchedLog).length - 1;
    if (oldCount === 0 && newCount === 1) return bundle;
    if (oldCount !== 1 || newCount !== 0) {
        throw new Error('HF upload log patch: expected exactly one supported log expression');
    }
    return bundle.replace(originalLog, patchedLog);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const file = path.join(root, 'js', '274.9b7364f3.js');
    const before = fs.readFileSync(file, 'utf8');
    const after = redactHfUploadInfo(patchHfMultipartCommit(before));
    if (after !== before) fs.writeFileSync(file, after, 'utf8');
    console.log(`Applied HF multipart commit patch (${after !== before ? 1 : 0} files updated)`);
}
