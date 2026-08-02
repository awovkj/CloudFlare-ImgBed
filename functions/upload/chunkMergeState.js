export const MERGE_LEASE_MS = 45 * 1000;
export const MERGE_HEARTBEAT_INTERVAL_MS = 10 * 1000;
export const MERGE_CLEANUP_PROTECTION_MS = 10 * 60 * 1000;
export const MERGE_BACKGROUND_RECOVERY_GRACE_MS = 10 * 1000;

const TERMINAL_MERGE_STATUSES = new Set(['merge_success', 'merge_failed']);

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

export function getEffectiveMergeLeaseUntil(session = {}) {
    const explicitLeaseUntil = toFiniteNumber(session.mergeLeaseUntil);
    if (explicitLeaseUntil) {
        return explicitLeaseUntil;
    }

    // Compatibility for sessions created before short leases existed. The old
    // ten-minute cleanup protection is deliberately not treated as a lock.
    const lastActivityAt = toFiniteNumber(
        session.mergeHeartbeatAt
        || session.lastUpdatedAt
        || session.updatedAt
        || session.mergeStartedAt,
    );
    return lastActivityAt ? lastActivityAt + MERGE_LEASE_MS : 0;
}

export function classifyMergeSession(session = {}, now = Date.now()) {
    if (session.status === 'merge_success') {
        return { kind: 'success' };
    }
    if (session.status === 'merge_failed') {
        return { kind: 'failed' };
    }
    if (session.status === 'merging') {
        const leaseUntil = getEffectiveMergeLeaseUntil(session);
        return {
            kind: leaseUntil > now ? 'active' : 'stale',
            leaseUntil,
        };
    }
    if (session.status === 'waiting_chunks') {
        const resumeAfter = toFiniteNumber(session.mergeResumeAfter);
        return {
            kind: resumeAfter > now ? 'waiting' : 'resumable',
            resumeAfter,
        };
    }
    return { kind: 'resumable' };
}

export function buildMergeLeasePatch(jobId, now = Date.now(), extra = {}) {
    return {
        ...extra,
        status: 'merging',
        mergeJobId: jobId,
        mergeHeartbeatAt: now,
        mergeLeaseUntil: now + MERGE_LEASE_MS,
        mergeProtectedUntil: now + MERGE_CLEANUP_PROTECTION_MS,
    };
}

export function buildWaitingForChunksPatch(jobId, now = Date.now(), retryAfterMs = 1000, extra = {}) {
    const safeRetryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    const mergeNextAttemptAt = now + safeRetryAfterMs;
    return {
        ...extra,
        status: 'waiting_chunks',
        mergeJobId: jobId,
        mergeLeaseUntil: 0,
        mergeNextAttemptAt,
        mergeResumeAfter: mergeNextAttemptAt + MERGE_BACKGROUND_RECOVERY_GRACE_MS,
        mergeProtectedUntil: now + MERGE_CLEANUP_PROTECTION_MS,
    };
}

export function isCleanupProtectedByMerge(session = {}, now = Date.now()) {
    if (session.status === 'merging') {
        return getEffectiveMergeLeaseUntil(session) > now;
    }
    if (session.status === 'waiting_chunks') {
        return toFiniteNumber(session.mergeResumeAfter) > now;
    }
    return false;
}

export function canApplyMergeSessionPatch(session = {}, patch = {}, options = {}) {
    const { expectedJobId, allowedStatuses, expectedRevision } = options;

    if (TERMINAL_MERGE_STATUSES.has(session.status) && patch.status !== session.status) {
        return false;
    }
    if (expectedRevision !== undefined && Number(session.revision || 0) !== Number(expectedRevision)) {
        return false;
    }
    if (expectedJobId && session.mergeJobId !== expectedJobId) {
        return false;
    }
    if (Array.isArray(allowedStatuses) && !allowedStatuses.includes(session.status)) {
        return false;
    }
    return true;
}
