import { getDatabase } from '../utils/databaseAdapter.js';
import { getChunkUploadStatusesWithManifest } from './chunkUpload.js';

export async function onRequest(context) {
    const { request, env } = context;
    
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    try {
        const url = new URL(request.url);
        const uploadId = url.searchParams.get('uploadId');
        const totalChunks = parseInt(url.searchParams.get('totalChunks')) || 0;

        if (!uploadId) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: 'Missing uploadId' 
            }), { 
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const db = getDatabase(env);
        
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        
        if (!sessionData) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: 'Upload session not found or expired',
                uploadedChunks: []
            }), { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const sessionInfo = JSON.parse(sessionData);
        const chunks = totalChunks || sessionInfo.totalChunks || 0;

        if (chunks === 0) {
            return new Response(JSON.stringify({ 
                success: true, 
                uploadedChunks: [],
                sessionInfo
            }), { 
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const chunkStatuses = await getChunkUploadStatusesWithManifest(env, uploadId, chunks);
        
        const uploadedChunks = chunkStatuses
            .filter(chunk => chunk.status === 'completed')
            .map(chunk => chunk.index);

        const failedChunks = chunkStatuses
            .filter(chunk => ['failed', 'timeout', 'retry_failed'].includes(chunk.status))
            .map(chunk => chunk.index);

        return new Response(JSON.stringify({
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
        }), {
            status: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });

    } catch (error) {
        console.error('Failed to get chunk status:', error);
        return new Response(JSON.stringify({ 
            success: false, 
            error: error.message,
            uploadedChunks: []
        }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
