import { getDatabase } from '../utils/databaseAdapter.js';
import { getChunkUploadStatusesWithManifest } from './chunkUpload.js';
import { userAuthCheck, UnauthorizedResponse } from '../utils/auth/userAuth.js';
import { validateChunkInitialization } from './chunkProtocol.js';
import { buildPreflightResponse } from '../utils/cors.js';
import { createJsonResponse, createServerErrorResponse } from '../utils/response.js';

const json = (body, status = 200) => createJsonResponse(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequest(context) {
    const { request, env } = context;
    
    if (request.method === 'OPTIONS') {
        return buildPreflightResponse({ request, env, methods: 'GET, OPTIONS' });
    }

    if (request.method !== 'GET') {
        return createJsonResponse({ error: 'Method Not Allowed' }, {
            status: 405, headers: { Allow: 'GET, OPTIONS', 'Cache-Control': 'no-store' },
        });
    }

    try {
        const url = new URL(request.url);
        if (!await userAuthCheck(env, url, request, 'upload')) return UnauthorizedResponse('Unauthorized');
        const uploadId = url.searchParams.get('uploadId');
        const requestedChunks = url.searchParams.get('totalChunks');

        if (!uploadId || !/^[A-Za-z0-9_-]{1,128}$/.test(uploadId)) {
            return json({ success: false, error: 'A valid uploadId is required' }, 400);
        }

        const db = getDatabase(env);
        
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        
        if (!sessionData) {
            return json({
                success: false, 
                error: 'Upload session not found or expired',
                uploadedChunks: []
            });
        }

        const sessionInfo = JSON.parse(sessionData);
        const layout = validateChunkInitialization({ totalChunks: sessionInfo.totalChunks });
        const incoming = requestedChunks === null ? layout : validateChunkInitialization({ totalChunks: requestedChunks });
        if (!layout.ok || !incoming.ok || incoming.totalChunks !== layout.totalChunks) {
            return json({ success: false, error: 'Invalid or mismatched totalChunks' }, 400);
        }
        if (!Number.isFinite(sessionInfo.expiresAt) || Date.now() >= sessionInfo.expiresAt) {
            return json({ success: false, error: 'Upload session expired', uploadedChunks: [] }, 410);
        }
        const chunks = layout.totalChunks;

        const chunkStatuses = await getChunkUploadStatusesWithManifest(env, uploadId, chunks);
        
        const uploadedChunks = chunkStatuses
            .filter(chunk => chunk.status === 'completed')
            .map(chunk => chunk.index);

        const failedChunks = chunkStatuses
            .filter(chunk => ['failed', 'timeout', 'retry_failed'].includes(chunk.status))
            .map(chunk => chunk.index);

        return json({
            success: true,
            uploadId,
            totalChunks: chunks,
            uploadedChunks,
            failedChunks,
            sessionInfo: {
                status: sessionInfo.status,
                originalFileName: sessionInfo.originalFileName,
                uploadChannel: sessionInfo.uploadChannel
            }
        });

    } catch (error) {
        return createServerErrorResponse(env, error, { pathname: '/upload/chunkStatus' });
    }
}
