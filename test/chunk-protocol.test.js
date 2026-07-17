import assert from 'node:assert/strict';

import {
  MAX_MULTIPART_CHUNKS,
  validateChunkInitialization,
  validateChunkRequest,
  normalizeUploadSession,
  canReuseCompletedChunk,
  classifyChunkStatuses,
  uploadError,
} from '../functions/upload/chunkProtocol.js';

describe('chunk protocol', () => {
  it('limits multipart uploads to 10000 chunks', () => {
    assert.equal(MAX_MULTIPART_CHUNKS, 10000);
    assert.equal(validateChunkInitialization({ totalChunks: 0 }).code, 'INVALID_TOTAL_CHUNKS');
    assert.equal(validateChunkInitialization({ totalChunks: 10001 }).code, 'INVALID_TOTAL_CHUNKS');
    assert.deepEqual(validateChunkInitialization({ totalChunks: '10000' }), {
      ok: true,
      totalChunks: 10000,
    });
  });

  it('validates optional file and chunk sizes and their chunk-count relationship', () => {
    assert.equal(
      validateChunkInitialization({ totalChunks: 2, fileSize: 0, chunkSize: 5 }).code,
      'INVALID_FILE_SIZE'
    );
    assert.equal(
      validateChunkInitialization({ totalChunks: 2, fileSize: 10, chunkSize: 'nope' }).code,
      'INVALID_CHUNK_SIZE'
    );
    assert.equal(
      validateChunkInitialization({ totalChunks: 2, fileSize: 10, chunkSize: -5 }).code,
      'INVALID_CHUNK_SIZE'
    );
    assert.equal(
      validateChunkInitialization({ totalChunks: 3, fileSize: 10, chunkSize: 5 }).code,
      'INVALID_CHUNK_LAYOUT'
    );
    assert.deepEqual(
      validateChunkInitialization({ totalChunks: '2', fileSize: '10', chunkSize: '5' }),
      { ok: true, totalChunks: 2, fileSize: 10, chunkSize: 5 }
    );
    assert.deepEqual(validateChunkInitialization({ totalChunks: 2 }), {
      ok: true,
      totalChunks: 2,
    });
  });

  it('rejects chunk indexes outside the upload range', () => {
    assert.equal(validateChunkRequest({ chunkIndex: 0, totalChunks: 0 }).code, 'INVALID_TOTAL_CHUNKS');
    assert.equal(validateChunkRequest({ chunkIndex: 3, totalChunks: 3 }).code, 'INVALID_CHUNK_INDEX');
    assert.equal(validateChunkRequest({ chunkIndex: -1, totalChunks: 3 }).code, 'INVALID_CHUNK_INDEX');
    assert.deepEqual(validateChunkRequest({ chunkIndex: '2', totalChunks: '3' }), {
      ok: true,
      chunkIndex: 2,
      totalChunks: 3,
    });
  });

  it('normalizes legacy sessions to schema version 2 without losing their fields', () => {
    const legacy = {
      schemaVersion: 1,
      uploadId: 'u',
      totalChunks: 2,
      status: 'uploading',
      customLegacyField: 'preserved',
    };

    assert.deepEqual(normalizeUploadSession(legacy, 123), {
      revision: 0,
      status: 'uploading',
      updatedAt: 123,
      ...legacy,
      schemaVersion: 2,
    });
    assert.deepEqual(legacy, {
      schemaVersion: 1,
      uploadId: 'u',
      totalChunks: 2,
      status: 'uploading',
      customLegacyField: 'preserved',
    });
  });

  it('reuses only compatible completed chunks', () => {
    assert.equal(canReuseCompletedChunk({ status: 'completed', size: 10 }, { size: 10 }), true);
    assert.equal(
      canReuseCompletedChunk(
        { status: 'completed', size: 10, checksum: 'a' },
        { size: 10, checksum: 'b' }
      ),
      false
    );
    assert.equal(
      canReuseCompletedChunk(
        { status: 'completed', size: '10', checksum: 'a' },
        { size: 10, checksum: 'a' }
      ),
      true
    );
    assert.equal(canReuseCompletedChunk({ status: 'uploading', size: 10 }, { size: 10 }), false);
  });

  it('classifies and sorts chunk statuses without mutating the input', () => {
    const statuses = [
      { index: 4, status: 'retry_failed' },
      { index: 2, status: 'failed' },
      { index: 3, status: 'retrying' },
      { index: 1, status: 'uploading' },
      { index: 5, status: 'completed' },
      { index: 0, status: 'completed' },
    ];
    const original = structuredClone(statuses);

    assert.deepEqual(classifyChunkStatuses(statuses), {
      uploadedChunks: [0, 5],
      inProgressChunks: [1, 3],
      failedChunks: [2, 4],
    });
    assert.deepEqual(statuses, original);
  });

  it('creates stable upload error payloads with optional details', () => {
    assert.deepEqual(uploadError('CHUNK_UPLOAD_RETRYABLE', 'try again', {
      success: true,
      code: 'OVERRIDDEN',
      message: 'overridden',
      retryable: true,
      retryAfterMs: 500,
    }), {
      success: false,
      code: 'CHUNK_UPLOAD_RETRYABLE',
      message: 'try again',
      retryable: true,
      retryAfterMs: 500,
    });
  });
});
