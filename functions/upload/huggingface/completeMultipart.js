import { userAuthCheck, UnauthorizedResponse } from '../../utils/auth/userAuth.js';
import { sanitizeUploadFolder } from '../uploadTools.js';
import { createJsonResponse, createServerErrorResponse } from '../../utils/response.js';
import { isRequestBodyTooLargeError, createRequestBodyTooLargeResponse } from '../../utils/requestLimits.js';
import { createUploadPolicyResponse } from '../uploadPolicy.js';
import { fetchUploadConfig } from '../../utils/sysConfig.js';
import { HuggingFaceAPI } from '../../utils/huggingfaceAPI.js';
import { getDirectUploadSession, validateDirectUploadSession, validateDirectUploadChannel, ensureDirectMultipartCompletion } from './directUploadSession.js';
import { MultipartProtocolError, readHfJsonBody, isValidCompletionTarget, validateMultipartOid, validateMultipartParts } from './multipartProtocol.js';

export { isValidCompletionTarget } from './multipartProtocol.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    try {
        const requiredPermission = 'upload';
        if (!await userAuthCheck(env, url, request, requiredPermission)) {
            return UnauthorizedResponse('Unauthorized');
        }

        const fullId = url.searchParams.get('fullId');
        if (!fullId || fullId.length > 4096 || sanitizeUploadFolder(fullId) !== fullId) {
            throw new MultipartProtocolError('DIRECT_UPLOAD_SESSION_REQUIRED', 'An issued upload session is required', 409);
        }
        const issued = await getDirectUploadSession(env, fullId);
        const binding = validateDirectUploadSession(issued, { ...issued, fullId });
        if (!binding.ok) return createUploadPolicyResponse(binding);
        if (!issued.multipart) {
            throw new MultipartProtocolError('DIRECT_UPLOAD_SESSION_REQUIRED', 'Request a new multipart upload URL first', 409);
        }
        const target = url.searchParams.get('target');
        if (target !== null) {
            let parsed;
            try { parsed = new URL(target); } catch { /* Rejected below. */ }
            if (!isValidCompletionTarget(parsed) || parsed.href !== issued.multipart.completionUrl) {
                throw new MultipartProtocolError('MULTIPART_COMPLETION_MISMATCH', 'Completion target does not match the issued upload');
            }
        }

        const body = await readHfJsonBody(request);
        validateMultipartOid(body.oid, issued.sha256);
        for (const [key, value] of Object.entries(body)) {
            if (key === 'oid' || key === 'parts') continue;
            const expected = key === 'fullId' ? fullId : issued.multipart.metadata[key];
            if (expected === undefined || value !== expected) {
                throw new MultipartProtocolError('MULTIPART_COMPLETION_MISMATCH', 'Completion metadata does not match the issued upload');
            }
        }
        const uploadConfig = await fetchUploadConfig(env);
        const channel = uploadConfig.huggingface?.channels?.find(item => item.name === issued.channelName);
        const channelBinding = validateDirectUploadChannel(issued, channel);
        if (!channelBinding.ok) return createUploadPolicyResponse(channelBinding);
        if (!channel.token) throw new MultipartProtocolError('DIRECT_UPLOAD_CHANNEL_CHANGED', 'The issued upload channel is no longer available', 409);
        const provider = new HuggingFaceAPI(channel.token, channel.repo, channel.isPrivate || false);
        await ensureDirectMultipartCompletion(env, issued, body.parts, provider);
        return createJsonResponse({ success: true, fullId }, { headers: { 'Cache-Control': 'no-store' } });

    } catch (error) {
        if (isRequestBodyTooLargeError(error)) return createRequestBodyTooLargeResponse();
        if (error instanceof MultipartProtocolError) return createUploadPolicyResponse(error);
        return createServerErrorResponse(env, error, { pathname: '/upload/huggingface/completeMultipart' });
    }
}

export function validateMultipartBody(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error('Invalid multipart completion body');
    }

    return validateMultipartParts(parsed?.oid, parsed?.parts);
}
