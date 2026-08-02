import {
    canApplyMergeSessionPatch,
    classifyMergeSession
} from './chunkMergeState.js';

export async function readUploadSession(db, uploadId) {
    const sessionData = await db.get(`upload_session_${uploadId}`);
    return sessionData ? JSON.parse(sessionData) : null;
}

export async function updateUploadSession(db, uploadId, patch = {}, options = {}, now = Date.now) {
    const sessionKey = `upload_session_${uploadId}`;
    const sessionInfo = await readUploadSession(db, uploadId);
    if (!sessionInfo || !canApplyMergeSessionPatch(sessionInfo, patch, options)) {
        return false;
    }

    const updatedSessionInfo = {
        ...sessionInfo,
        ...patch,
        lastUpdatedAt: now(),
        revision: Number(sessionInfo.revision || 0) + 1
    };

    await db.put(sessionKey, JSON.stringify(updatedSessionInfo), {
        expirationTtl: 3600
    });
    return true;
}

export async function claimUploadMerge(db, uploadId, leasePatch, options = {}, now = Date.now) {
    const updated = await updateUploadSession(db, uploadId, leasePatch, options, now);
    if (!updated) return false;

    // KV has no compare-and-swap. Re-read the claim so a concurrent request
    // that overwrote it is detected before provider merge work starts.
    const claimedSession = await readUploadSession(db, uploadId);
    return claimedSession?.status === 'merging'
        && claimedSession?.mergeJobId === leasePatch.mergeJobId
        && classifyMergeSession(claimedSession, now()).kind === 'active';
}
