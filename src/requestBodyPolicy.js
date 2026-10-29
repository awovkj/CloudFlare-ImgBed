import { limitRequestBody } from '../functions/utils/requestLimits.js';
import { MAX_HF_COMPLETION_BODY_BYTES } from '../functions/upload/huggingface/multipartProtocol.js';

export const MAX_METADATA_BODY_BYTES = 64 * 1024;
const LOGIN_PATHS = new Set(['/api/login', '/api/manage/login', '/api/music/login', '/api/auth/login', '/api/auth/adminLogin', '/api/auth/resetAuth']);

/** Bound control metadata at both boundaries without capping file-upload bodies. */
export function enforceRequestBodyLimit(request, env) {
    if (!request.body && !request.headers.has('Content-Length')) return request;
    const url = new URL(request.url);
    if (url.pathname === '/api/fetchRes' || LOGIN_PATHS.has(url.pathname)) return limitRequestBody(request, 16 * 1024);
    if (/^\/(?:api|upload)\/huggingface\//.test(url.pathname)) {
        if (/\/(?:commitUpload|completeMultipart)$/.test(url.pathname)) {
            return limitRequestBody(request, MAX_HF_COMPLETION_BODY_BYTES);
        }
        return limitRequestBody(request, MAX_METADATA_BODY_BYTES);
    }
    if (!/^\/upload(?:\/|$)/.test(url.pathname)) return request;
    if (url.searchParams.get('initChunked') === 'true' || url.searchParams.get('merge') === 'true') {
        return limitRequestBody(request, MAX_METADATA_BODY_BYTES);
    }
    return request;
}
