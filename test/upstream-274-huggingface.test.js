import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');

describe('upstream HuggingFace direct upload integration', () => {
  it('validates multipart completion targets and bodies', async () => {
    const mod = await import('../functions/upload/huggingface/completeMultipart.js');
    assert.equal(mod.isValidCompletionTarget(new URL('https://huggingface.co/api/complete_multipart')), true);
    assert.equal(mod.isValidCompletionTarget(new URL('http://huggingface.co/api/complete_multipart')), false);
    assert.doesNotThrow(() => mod.validateMultipartBody(JSON.stringify({ oid: 'abc', parts: [{ partNumber: 1, etag: 'e' }] })));
    assert.throws(() => mod.validateMultipartBody('x'), /Invalid multipart completion body/);
    assert.throws(() => mod.validateMultipartBody(JSON.stringify({ oid: 'abc', parts: [{ partNumber: 0, etag: 'e' }] })), /Invalid multipart parts/);
  });
  it('rewrites completion URL and accepts empty MIME type', () => {
    const src = read('functions/upload/huggingface/getUploadUrl.js');
    assert.match(src, /rewriteMultipartCompletionUrl/);
    assert.match(src, /\/upload\/huggingface\/completeMultipart\?target=/);
    assert.match(src, /application\/octet-stream/);
  });
  it('keeps legacy API paths as re-exports', () => {
    assert.match(read('functions/api/huggingface/getUploadUrl.js'), /upload\/huggingface\/getUploadUrl\.js/);
    assert.match(read('functions/api/huggingface/commitUpload.js'), /upload\/huggingface\/commitUpload\.js/);
  });
});
