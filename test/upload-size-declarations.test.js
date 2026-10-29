import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

describe('frontend chunk size declarations', () => {
    it('sends exact byte sizes using the existing compiled uploader layout', () => {
        const bundle = fs.readFileSync('js/274.9b7364f3.js', 'utf8');
        const start = bundle.indexOf('t.append("originalFileName",e.file.name)');
        assert.notEqual(start, -1);
        const end = bundle.indexOf(';const p=', start);
        assert.ok(end > start);
        const initializer = bundle.slice(start, end);
        assert.match(initializer, /t\.append\("fileSize",a\.toString\(\)\)/);
        assert.match(initializer, /t\.append\("chunkSize",l\.toString\(\)\)/);
        const build = new Function('e', 'i', 'a', 'l', `const t = new FormData(); ${initializer}; return t;`);
        const bytes = 37 * 1024 * 1024;
        const chunkSize = 18 * 1024 * 1024;
        const form = build({ file: { name: 'report.pdf', type: 'application/pdf' } }, Math.ceil(bytes / chunkSize), bytes, chunkSize);
        assert.equal(form.get('fileSize'), String(bytes));
        assert.equal(form.get('chunkSize'), String(chunkSize));
        assert.equal(form.get('totalChunks'), '3');
    });

    it('keeps the checked-in uploader patch deterministic and idempotent', () => {
        const before = fs.readFileSync('js/274.9b7364f3.js', 'utf8');
        execFileSync(process.execPath, ['scripts/patch-tg-upload-performance.mjs'], { stdio: 'pipe' });
        assert.equal(fs.readFileSync('js/274.9b7364f3.js', 'utf8'), before);
    });
});
