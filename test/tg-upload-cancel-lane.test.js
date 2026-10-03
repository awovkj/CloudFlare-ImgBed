import assert from 'node:assert/strict';
import fs from 'node:fs';

const uploadBundle = fs.readFileSync('js/274.9b7364f3.js', 'utf8');

function bundleSection(startMarker, endMarker) {
  const start = uploadBundle.indexOf(startMarker);
  assert.notEqual(start, -1, `bundle marker not found: ${startMarker}`);
  const end = uploadBundle.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `bundle marker not found: ${endMarker}`);
  return uploadBundle.slice(start, end);
}

describe('Telegram upload lane cancellation ownership', () => {
  it('releases an active lane from the finalizer even when the file was removed', () => {
    const complete = bundleSection(
      'onTelegramUploadComplete(',
      'async uploadSingleFile('
    );

    // The file list entry can disappear before an aborted request settles. The
    // lane captured by the upload must therefore be sufficient for release.
    assert.match(complete, /l=t\|\|\(o&&o\.tgUploadLane\)/);
    assert.match(complete, /s&&l&&s\.releaseLane\(this\.tgActiveChannels,l\)/);
    assert.doesNotMatch(complete, /o&&o\.tgUploadLane&&s\.releaseLane/);
  });

  it('captures the lane for both direct and chunked Telegram uploads', () => {
    const direct = bundleSection(
      'async uploadSingleFile(',
      'async uploadFileInChunks('
    );
    const chunked = bundleSection('async uploadFileInChunks(', 'handleRemove(');

    assert.match(direct, /const __tgLane=t\.tgUploadLane/);
    assert.match(
      direct,
      /"telegram"===s\?this\.onTelegramUploadComplete\(e\.file\.uid,__tgLane\)/
    );
    assert.match(chunked, /const __tgLane=t\.tgUploadLane/);
    assert.match(
      chunked,
      /"telegram"===o\?this\.onTelegramUploadComplete\(e\.file\.uid,__tgLane\)/
    );
  });

  it('keeps the lane occupied while remove/clear only abort in-flight work', () => {
    const remove = bundleSection('handleRemove(', 'async cleanupUploadResources(');
    const clear = bundleSection('clearFileList(', 'clearSuccessList(');

    assert.match(remove, /abort\(\)/);
    assert.match(remove, /processTelegramUploadQueue\(\)/);
    assert.doesNotMatch(remove, /releaseLane/);
    assert.doesNotMatch(clear, /tgActiveChannels=\{\}/);
  });

  it('propagates cancellation to chunk initialization', () => {
    const chunked = bundleSection('async uploadFileInChunks(', 'handleRemove(');

    assert.match(
      chunked,
      /&initChunked=true",method:"post",data:t,withAuthCode:!0,signal:s\.signal/
    );
  });
});

describe('Chunk requests carry uploadId so they route to the Durable Object', () => {
  it('appends uploadId to the chunk request URL', () => {
    const chunked = bundleSection('async uploadFileInChunks(', 'handleRemove(');

    // src/uploadRequestRouting.js 的 shouldRouteUploadToDurableObject() 只认 URL
    // 或 X-Upload-Id 上的 uploadId（extractUploadId 对非 merge 请求不解析 body）。
    // 不带 uploadId 时分片会回退到 Worker：吃 Free 计划的 10ms CPU 预算，
    // 且同一 uploadId 落不到同一个 DO 实例，runSerial 串行队列不生效。
    assert.match(
      chunked,
      /&chunked=true&uploadId="\+encodeURIComponent\(h\),method:"post",data:f,/
    );
    assert.doesNotMatch(chunked, /&chunked=true",method:"post",data:f,/);
  });

  it('leaves the merge URL unchanged (merge 靠 body 解析路由)', () => {
    const chunked = bundleSection('async uploadFileInChunks(', 'handleRemove(');

    assert.match(chunked, /&chunked=true&merge=true/);
  });
});
