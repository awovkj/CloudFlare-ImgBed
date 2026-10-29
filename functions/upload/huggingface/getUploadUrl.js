/**
 * HuggingFace 大文件直传 API
 *
 * 流程：
 * 1. 前端计算 SHA256 和文件样本
 * 2. 前端调用此 API 获取 LFS 上传 URL
 * 3. 前端直接上传到 HuggingFace S3
 * 4. 前端调用 commitUpload API 提交文件引用
 *
 * 这样可以绕过 CF Workers 的 100MB 请求体限制和 CPU 时间限制
 */

import { HuggingFaceAPI } from '../../utils/huggingfaceAPI.js';
import { fetchUploadConfig } from '../../utils/sysConfig.js';
import { userAuthCheck, UnauthorizedResponse } from '../../utils/auth/userAuth.js';
import { buildUniqueFileId, getUploadIp, isBlockedUploadIp, createResponse } from '../uploadTools.js';
import { createUploadPolicyResponse, validateUploadFile } from '../uploadPolicy.js';
import { createJsonResponse, createServerErrorResponse } from '../../utils/response.js';
import { isRequestBodyTooLargeError, createRequestBodyTooLargeResponse } from '../../utils/requestLimits.js';
import { issueDirectUploadSession } from './directUploadSession.js';
import { extractIssuedMultipartDescriptor, readHfJsonBody, MultipartProtocolError } from './multipartProtocol.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    context.url = url;  // 将 url 添加到 context 以便 buildUniqueFileId 使用

    try {
        // 鉴权
        const requiredPermission = 'upload';
        if (!await userAuthCheck(env, url, request, requiredPermission)) {
            return UnauthorizedResponse('Unauthorized');
        }

        // 检查上传IP是否被封禁
        const uploadIp = getUploadIp(request);
        if (await isBlockedUploadIp(env, uploadIp)) {
            return createResponse(JSON.stringify({ error: 'IP blocked' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const body = await readHfJsonBody(request, 64 * 1024);
        const { fileSize, fileName, fileType, sha256, fileSample, channelName, uploadNameType, uploadFolder } = body;
        const policy = validateUploadFile({ fileSize, fileName, fileType }, env, { chunked: true });
        if (!policy.ok) return createUploadPolicyResponse(policy);
        const normalizedFileType = policy.fileType;

        if (!fileSize || !fileName || !sha256 || !fileSample) {
            return createResponse(JSON.stringify({
                error: 'Missing required fields: fileSize, fileName, sha256, fileSample'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)
            || typeof fileSample !== 'string' || fileSample.length > 4096 || !/^[a-z0-9+/]+={0,2}$/i.test(fileSample)) {
            return createJsonResponse({ success: false, error: 'Invalid SHA256 or file sample' }, {
                status: 400, headers: { 'Cache-Control': 'no-store' },
            });
        }

        // 获取 HuggingFace 配置
        const uploadConfig = await fetchUploadConfig(env);
        const hfSettings = uploadConfig.huggingface;

        if (!hfSettings || !hfSettings.channels || hfSettings.channels.length === 0) {
            return createResponse(JSON.stringify({ error: 'No HuggingFace channel configured' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 选择渠道
        let hfChannel;
        if (channelName) {
            hfChannel = hfSettings.channels.find(c => c.name === channelName);
        }
        if (!hfChannel) {
            hfChannel = hfSettings.loadBalance?.enabled
                ? hfSettings.channels[Math.floor(Math.random() * hfSettings.channels.length)]
                : hfSettings.channels[0];
        }

        if (!hfChannel || !hfChannel.token || !hfChannel.repo) {
            return createResponse(JSON.stringify({ error: 'HuggingFace channel not properly configured' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 将命名参数添加到 URL 以便 buildUniqueFileId 使用
        if (uploadNameType) {
            url.searchParams.set('uploadNameType', uploadNameType);
        }
        if (uploadFolder) {
            url.searchParams.set('uploadFolder', uploadFolder);
        }

        // 使用统一的文件命名函数生成文件ID
        const candidateId = await buildUniqueFileId(context, fileName, normalizedFileType);

        // 生成唯一标识符前缀（UUID格式），加在文件名前面
        const uniquePrefix = crypto.randomUUID();
        const lastSlashIndex = candidateId.lastIndexOf('/');
        // Pending uploads do not occupy final KV keys. Randomize the public ID too,
        // so concurrent origin-name uploads cannot overwrite each other's session or file.
        const fullId = lastSlashIndex === -1
            ? `${uniquePrefix}_${candidateId}`
            : `${candidateId.substring(0, lastSlashIndex + 1)}${uniquePrefix}_${candidateId.substring(lastSlashIndex + 1)}`;
        const filePath = fullId;

        // 获取 LFS 上传信息
        const huggingfaceAPI = new HuggingFaceAPI(hfChannel.token, hfChannel.repo, hfChannel.isPrivate || false);
        const uploadInfo = await huggingfaceAPI.getLfsUploadInfo(Number(fileSize), filePath, sha256.toLowerCase(), fileSample);
        const multipart = extractIssuedMultipartDescriptor(uploadInfo, Number(fileSize), sha256.toLowerCase());
        await issueDirectUploadSession(env, {
            fullId, filePath, fileName, fileType: normalizedFileType,
            fileSize: Number(fileSize), sha256: sha256.toLowerCase(), channelName: hfChannel.name,
            repo: hfChannel.repo, isPrivate: Boolean(hfChannel.isPrivate),
            multipart, uploadMode: multipart ? 'multipart' : uploadInfo.alreadyExists ? 'already-exists' : 'basic',
        });
        rewriteMultipartCompletionUrl(url, uploadInfo, fullId);

        // 返回上传信息
        return createResponse(JSON.stringify({
            success: true,
            fullId,
            filePath,
            channelName: hfChannel.name,
            repo: hfChannel.repo,
            isPrivate: hfChannel.isPrivate || false,
            ...uploadInfo
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });

    } catch (error) {
        if (isRequestBodyTooLargeError(error)) return createRequestBodyTooLargeResponse();
        if (error instanceof MultipartProtocolError && error.code === 'INVALID_REQUEST_BODY') return createUploadPolicyResponse(error);
        return createServerErrorResponse(env, error, { pathname: '/upload/huggingface/getUploadUrl' });
    }
}

function rewriteMultipartCompletionUrl(requestUrl, uploadInfo, fullId) {
    const uploadAction = uploadInfo?.uploadAction;
    if (!uploadAction?.header?.chunk_size || !uploadAction.href) {
        return;
    }

    uploadAction.href = `${requestUrl.origin}/upload/huggingface/completeMultipart?fullId=${encodeURIComponent(fullId)}`;
}
