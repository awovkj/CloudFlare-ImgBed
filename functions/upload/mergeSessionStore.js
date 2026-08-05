import {
    canApplyMergeSessionPatch,
    classifyMergeSession
} from './chunkMergeState.js';

export async function readUploadSession(db, uploadId) {
    const sessionData = await db.get(`upload_session_${uploadId}`);
    return sessionData ? JSON.parse(sessionData) : null;
}

function buildUpdatedUploadSession(sessionInfo, patch = {}, options = {}, now = Date.now) {
    if (!sessionInfo || !canApplyMergeSessionPatch(sessionInfo, patch, options)) {
        return null;
    }

    return {
        ...sessionInfo,
        ...patch,
        lastUpdatedAt: now(),
        revision: Number(sessionInfo.revision || 0) + 1
    };
}

async function persistUploadSession(db, uploadId, sessionInfo) {
    const sessionKey = `upload_session_${uploadId}`;
    await db.put(sessionKey, JSON.stringify(sessionInfo), {
        expirationTtl: 3600
    });
}

export function createUploadSessionCoordinator(db, uploadId, initialSession, now = Date.now) {
    let currentSession = initialSession;

    const update = async (patch = {}, options = {}) => {
        const updatedSession = buildUpdatedUploadSession(currentSession, patch, options, now);
        if (!updatedSession) {
            return false;
        }

        await persistUploadSession(db, uploadId, updatedSession);
        currentSession = updatedSession;
        return true;
    };

    const claim = async (leasePatch, options = {}) => {
        if (!await update(leasePatch, options)) {
            return false;
        }

        return currentSession?.status === 'merging'
            && currentSession?.mergeJobId === leasePatch.mergeJobId
            && classifyMergeSession(currentSession, now()).kind === 'active';
    };

    return {
        getCurrentSession: () => currentSession,
        update,
        claim
    };
}

export async function updateUploadSession(db, uploadId, patch = {}, options = {}, now = Date.now) {
    const sessionInfo = await readUploadSession(db, uploadId);
    const coordinator = createUploadSessionCoordinator(db, uploadId, sessionInfo, now);
    return coordinator.update(patch, options);
}

export async function claimUploadMerge(db, uploadId, leasePatch, options = {}, now = Date.now) {
    const sessionInfo = await readUploadSession(db, uploadId);
    const coordinator = createUploadSessionCoordinator(db, uploadId, sessionInfo, now);
    return coordinator.claim(leasePatch, options);
}
