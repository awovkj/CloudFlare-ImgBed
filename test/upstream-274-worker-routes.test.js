import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('src/worker.js', 'utf8');

describe('upstream Worker route integration', () => {
  it('routes upload HuggingFace direct upload endpoints', () => {
    assert.match(source, /onUploadHfGetUploadUrlPost/);
    assert.match(source, /onUploadHfCommitPost/);
    assert.match(source, /onUploadHfCompleteMultipartPost/);
    assert.match(source, /\/upload\/huggingface\/getUploadUrl/);
    assert.match(source, /\/upload\/huggingface\/commitUpload/);
    assert.match(source, /\/upload\/huggingface\/completeMultipart/);
  });
  it('routes management custom files endpoint', () => {
    assert.match(source, /onManageCusConfigFiles/);
    assert.match(source, /\/api\/manage\/cusConfig\/files/);
  });
});
