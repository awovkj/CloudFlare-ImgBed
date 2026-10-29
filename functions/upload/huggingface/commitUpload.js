/**
 * HuggingFace 大文件提交 API
 *
 * 在前端直接上传文件到 S3 后，调用此 API 提交 LFS 文件引用
 */

import { HuggingFaceAPI } from '../../utils/huggingfaceAPI.js';
import { fetchPageConfig, fetchUploadConfig } from '../../utils/sysConfig.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { moderateContent, endUpload, getUploadIp, getIPAddress, sanitizeUploadFolder, createResponse } from '../uploadTools.js';
import { userAuthCheck, UnauthorizedResponse } from '../../utils/auth/userAuth.js';
import { cleanPersistedMetadataInPlace } from '../../utils/metadata/metadataSecurity.js';
import { createUploadPolicyResponse, validateUploadFile } from '../uploadPolicy.js';
import { createJsonResponse, createServerErrorResponse } from '../../utils/response.js';
import { isRequestBodyTooLargeError, createRequestBodyTooLargeResponse } from '../../utils/requestLimits.js';
import { getDirectUploadSession, validateDirectUploadSession, validateDirectUploadChannel, completeDirectUploadSession, ensureDirectMultipartCompletion } from './directUploadSession.js';
import { MultipartProtocolError, readHfJsonBody, validateMultipartOid, validateMultipartParts } from './multipartProtocol.js';

export async function onRequestPost(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    try {
        // 鉴权
        const requiredPermission = 'upload';
        if (!await userAuthCheck(env, url, request, requiredPermission)) {
            return UnauthorizedResponse('Unauthorized');
        }

        const body = await readHfJsonBody(request);
        const { fullId, filePath, sha256, fileSize, fileName, fileType, channelName } = body;
        const policy = validateUploadFile({ fileName, fileType, fileSize }, env, { chunked: true });
        if (!policy.ok) return createUploadPolicyResponse(policy);

        if (!fullId || !filePath || !sha256 || !fileSize) {
            return createResponse(JSON.stringify({
                error: 'Missing required fields: fullId, filePath, sha256, fileSize'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 路径安全处理：使用统一的路径安全函数
        const sanitizedFullId = sanitizeUploadFolder(fullId);
        if (sanitizedFullId !== fullId) {
            return createResponse(JSON.stringify({
                error: 'Invalid fullId: contains illegal path characters'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const issued = await getDirectUploadSession(env, fullId);
        const binding = validateDirectUploadSession(issued, body);
        if (!binding.ok) return createUploadPolicyResponse(binding);
        if (body.oid !== undefined) validateMultipartOid(body.oid, issued.sha256);
        if (!issued.multipart && (body.multipartParts !== undefined || body.uploadAction?.header?.chunk_size)) {
            return createUploadPolicyResponse({ code: 'DIRECT_UPLOAD_SESSION_REQUIRED', status: 409,
                message: 'Request a new upload URL before completing this multipart upload' });
        }
        if (issued.response) {
            if (issued.multipart && body.multipartParts !== undefined) {
                validateMultipartParts(issued.sha256, body.multipartParts, { expectedCount: issued.multipart.partCount });
            }
            return createJsonResponse(issued.response, { headers: { 'Cache-Control': 'no-store' } });
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
            return createJsonResponse({ success: false, error: 'The issued upload channel is no longer available' }, {
                status: 409, headers: { 'Cache-Control': 'no-store' },
            });
        }

        if (!hfChannel || !hfChannel.token || !hfChannel.repo) {
            return createResponse(JSON.stringify({ error: 'HuggingFace channel not properly configured' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const huggingfaceAPI = new HuggingFaceAPI(hfChannel.token, hfChannel.repo, hfChannel.isPrivate || false);

        // 提交 LFS 文件引用
        const channelBinding = validateDirectUploadChannel(issued, hfChannel);
        if (!channelBinding.ok) return createUploadPolicyResponse(channelBinding);
        await ensureDirectMultipartCompletion(env, issued, body.multipartParts, huggingfaceAPI, body.uploadAction);
        console.log('Committing LFS file...');
        await huggingfaceAPI.commitLfsFile(
            filePath,
            sha256,
            Number(fileSize),
            `Upload ${fileName || fullId}`
        );
        console.log('LFS commit completed');

        // 构建文件 URL
        const fileUrl = `https://huggingface.co/datasets/${hfChannel.repo}/resolve/main/${filePath}`;

        // 从 fullId 中提取目录信息
        const dirParts = fullId.split('/').slice(0, -1).join('/');
        const normalizedDirectory = dirParts === '' ? '' : dirParts + '/';

        // 获取上传IP和地址
        const uploadIp = getUploadIp(request) || '';
        const uploadAddress = await getIPAddress(env, uploadIp);

        // 构建 metadata
        const metadata = {
            FileName: fileName || fullId,
            FileType: policy.fileType,
            Channel: "HuggingFace",
            ChannelName: hfChannel.name || "HuggingFace_env",
            FileSize: (fileSize / 1024 / 1024).toFixed(2),
            FileSizeBytes: Number(fileSize),
            UploadIP: uploadIp,
            UploadAddress: uploadAddress,
            ListType: "None",
            HfFilePath: filePath,
            HfObjectRepo: issued.repo,
            HfObjectPrivate: issued.isPrivate,
            TimeStamp: Date.now(),
            Label: "None",
            Directory: normalizedDirectory,
            Tags: []
        };

        // 图像审查（公开仓库）
        if (!hfChannel.isPrivate) {
            try {
                metadata.Label = await moderateContent(env, fileUrl);
            } catch (e) {
                console.warn('Content moderation failed:', e.message);
            }
        }

        // 写入数据库
        const db = getDatabase(env);
        cleanPersistedMetadataInPlace(metadata);
        await db.put(fullId, "", { metadata });

        // 结束上传（更新索引等）
        const uploadContext = {
            env,
            waitUntil,
            uploadConfig,
            url
        };
        waitUntil(endUpload(uploadContext, fullId, metadata));

        // 返回成功响应
        const returnLink = `/file/${fullId}`;
        const responseBody = {
            success: true,
            src: returnLink,
            fileUrl,
            fullId
        };

        // 构建公开访问链接（使用 urlPrefix 配置）
        const pageConfig = await fetchPageConfig(env);
        const urlPrefixConfig = pageConfig.config?.find(c => c.id === 'urlPrefix');
        const urlPrefix = urlPrefixConfig?.value || '';
        if (urlPrefix) {
            responseBody.publicUrl = `${urlPrefix.replace(/\/+$/, '')}/${fullId}`;
        }

        await completeDirectUploadSession(env, issued, responseBody);
        return createResponse(JSON.stringify(responseBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });

    } catch (error) {
        if (isRequestBodyTooLargeError(error)) return createRequestBodyTooLargeResponse();
        if (error instanceof MultipartProtocolError) return createUploadPolicyResponse(error);
        return createServerErrorResponse(env, error, { pathname: '/upload/huggingface/commitUpload' });
    }
}
