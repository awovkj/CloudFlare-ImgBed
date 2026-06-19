import { createJsonResponse } from '../utils/response.js';
import { sanitizeUploadFolder } from './uploadTools.js';

const CHANNEL_MAP = {
    telegram: 'TelegramNew',
    cfr2: 'CloudflareR2',
    s3: 'S3',
    discord: 'Discord',
    huggingface: 'HuggingFace',
    external: 'External',
};

export function resolveUploadChannel(channel) {
    return CHANNEL_MAP[channel] || 'TelegramNew';
}

export function getNormalizedUploadFolder(url, fileName = '') {
    const requestedFolder = sanitizeUploadFolder(url.searchParams.get('uploadFolder') || '');
    if (requestedFolder) {
        return {
            uploadFolder: requestedFolder,
            fileName,
        };
    }

    return {
        uploadFolder: sanitizeUploadFolder(fileName.split('/').slice(0, -1).join('/')),
        fileName: fileName.split('/').pop(),
    };
}

export function createUploadJsonResponse(payload, status = 200, headers = {}) {
    return createJsonResponse(payload, {
        status,
        headers,
    });
}


export function buildUploadResult(context, returnLink) {
    const result = { src: returnLink };
    if (context?.publicUrl) {
        result.publicUrl = context.publicUrl;
    }
    return result;
}

export function buildUploadResults(context, returnLink) {
    return [buildUploadResult(context, returnLink)];
}
