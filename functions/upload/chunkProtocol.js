export const MAX_MULTIPART_CHUNKS = 10000;

function normalizeOptionalPositiveInteger(value, code) {
  if (value === undefined || value === null) return { ok: true };

  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    return { ok: false, code };
  }

  return { ok: true, value: normalized };
}

export function validateChunkInitialization(input) {
  const totalChunks = Number(input?.totalChunks);
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_MULTIPART_CHUNKS) {
    return { ok: false, code: 'INVALID_TOTAL_CHUNKS' };
  }

  const fileSizeResult = normalizeOptionalPositiveInteger(input?.fileSize, 'INVALID_FILE_SIZE');
  if (!fileSizeResult.ok) return fileSizeResult;

  const chunkSizeResult = normalizeOptionalPositiveInteger(input?.chunkSize, 'INVALID_CHUNK_SIZE');
  if (!chunkSizeResult.ok) return chunkSizeResult;

  if (
    fileSizeResult.value !== undefined
    && chunkSizeResult.value !== undefined
    && Math.ceil(fileSizeResult.value / chunkSizeResult.value) !== totalChunks
  ) {
    return { ok: false, code: 'INVALID_CHUNK_LAYOUT' };
  }

  const result = { ok: true, totalChunks };
  if (fileSizeResult.value !== undefined) result.fileSize = fileSizeResult.value;
  if (chunkSizeResult.value !== undefined) result.chunkSize = chunkSizeResult.value;
  if (input?.fileFingerprint !== undefined && input?.fileFingerprint !== null && input.fileFingerprint !== '') {
    result.fileFingerprint = String(input.fileFingerprint);
  }
  return result;
}

export function validateChunkRequest(input) {
  const totalChunksResult = validateChunkInitialization({ totalChunks: input?.totalChunks });
  if (!totalChunksResult.ok) return totalChunksResult;

  const chunkIndex = Number(input?.chunkIndex);
  const { totalChunks } = totalChunksResult;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    return { ok: false, code: 'INVALID_CHUNK_INDEX' };
  }

  return { ok: true, chunkIndex, totalChunks };
}

export function normalizeUploadSession(session, now = Date.now()) {
  return {
    revision: 0,
    status: 'initialized',
    updatedAt: now,
    ...session,
    schemaVersion: 2,
  };
}

export function canReuseCompletedChunk(existing, incoming) {
  return existing?.status === 'completed'
    && Number(existing.size) === Number(incoming?.size)
    && (!existing.checksum || !incoming?.checksum || existing.checksum === incoming.checksum);
}

export function classifyChunkStatuses(statuses) {
  const result = { uploadedChunks: [], inProgressChunks: [], failedChunks: [] };

  for (const part of statuses) {
    if (part.status === 'completed') result.uploadedChunks.push(part.index);
    else if (['uploading', 'retrying'].includes(part.status)) result.inProgressChunks.push(part.index);
    else if (['failed', 'timeout', 'retry_failed', 'missing', 'error'].includes(part.status)) {
      result.failedChunks.push(part.index);
    }
  }

  for (const values of Object.values(result)) values.sort((a, b) => a - b);
  return result;
}

export function uploadError(code, message, options = {}) {
  return { ...options, success: false, code, message };
}
