#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePaths = [
    'js/128.a59bdcad.js',
    'js/443.08e0d7c5.js',
    'js/601.e77ce138.js',
].map(relativePath => path.join(root, relativePath));

const oldHandler = 'handleLogout(){this.$store.commit("setCredentials",null),this.$router.push("/adminLogin")}';
const newHandler = 'async handleLogout(){try{await fetch("/api/auth/logout",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({authType:"admin"})})}finally{this.$store.commit("setCredentials",null),this.$router.push("/adminLogin")}}';

function countOccurrences(text, needle) {
    return text.split(needle).length - 1;
}

let changedFiles = 0;

for (const bundlePath of bundlePaths) {
    const bundle = fs.readFileSync(bundlePath, 'utf8');

    if (bundle.includes(newHandler)) {
        if (countOccurrences(bundle, newHandler) !== 1) {
            throw new Error(`${path.basename(bundlePath)}: duplicate admin logout patch`);
        }
        continue;
    }

    const matches = countOccurrences(bundle, oldHandler);
    if (matches !== 1) {
        throw new Error(`${path.basename(bundlePath)}: expected one logout handler, found ${matches}`);
    }

    fs.writeFileSync(bundlePath, bundle.replace(oldHandler, newHandler), 'utf8');
    changedFiles += 1;
}

console.log(`Applied admin session logout patch (${changedFiles} file${changedFiles === 1 ? '' : 's'} updated)`);
