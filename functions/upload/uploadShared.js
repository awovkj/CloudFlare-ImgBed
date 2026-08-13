import { createJsonResponse } from '../utils/response.js';
import { sanitizeUploadFolder } from './uploadTools.js';
import { issueTempLinkReceipt, extractFileIdFromLink } from './tempLinkReceipt.js';

const CHANNEL_MAP = {
    telegram: 'TelegramNew',
    cfr2: 'CloudflareR2',
    s3: 'S3',
    discord: 'Discord',
    huggingface: 'HuggingFace',
    external: 'External',
    webdav: 'WebDAV',
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

export async function buildUploadResults(context, returnLink) {
    const result = buildUploadResult(context, returnLink);
    // 为刚上传的文件签发临时链接凭证，前端可凭此在不登录的情况下生成临时链接
    const fileId = extractFileIdFromLink(returnLink);
    if (fileId) {
        const receipt = await issueTempLinkReceipt(context, fileId);
        if (receipt) {
            result.tempLinkReceipt = receipt;
        }
    }
    return [result];
}
