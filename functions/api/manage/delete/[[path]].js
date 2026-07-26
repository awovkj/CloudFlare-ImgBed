import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from "../../../utils/purgeCache";
import { removeFileFromIndex, batchRemoveFilesFromIndex } from "../../../utils/indexManager.js";
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { DiscordAPI } from '../../../utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../../../utils/storage/huggingfaceAPI.js';
import { WebDAVAPI } from '../../../utils/storage/webdavAPI.js';
import {
    resolveDiscordCredentials,
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveWebDAVCredentials,
} from '../../../utils/metadata/channelCredentials.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    const url = new URL(request.url);

    // 读取folder参数，判断是否为文件夹删除请求
    const folder = url.searchParams.get('folder');
    if (folder === 'true') {
        try {
            params.path = decodeURIComponent(params.path);
            // 使用队列存储需要处理的文件夹
            const folderQueue = [{
                path: params.path.split(',').join('/')
            }];

            const deletedFiles = [];
            const failedFiles = [];

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();

                // 获取指定目录下的所有文件
                const listUrl = new URL(`${url.origin}/api/manage/list?count=-1&dir=${currentFolder.path}`);
                const listRequest = new Request(listUrl, {
                    headers: request.headers,
                });
                const listResponse = await fetch(listRequest);
                if (!listResponse.ok) {
                    throw new Error(`Failed to list folder contents: ${listResponse.status}`);
                }
                const listData = await listResponse.json();

                const files = Array.isArray(listData.files) ? listData.files : [];

                // 处理当前文件夹下的所有文件
                for (const file of files) {
                    const fileId = file.name;
                    const cdnUrl = `https://${url.hostname}/file/${fileId}`;

                    const success = await deleteFile(env, fileId, cdnUrl, url);
                    if (success) {
                        deletedFiles.push(fileId);
                    } else {
                        failedFiles.push(fileId);
                    }
                }

                // 将子文件夹添加到队列
                const directories = Array.isArray(listData.directories) ? listData.directories : [];
                for (const dir of directories) {
                    folderQueue.push({
                        path: dir
                    });
                }
            }

            // 批量从索引中删除文件
            if (deletedFiles.length > 0) {
                waitUntil(batchRemoveFilesFromIndex(context, deletedFiles));
            }

            return new Response(JSON.stringify({
                success: true,
                deleted: deletedFiles,
                failed: failedFiles
            }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });

        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                error: e.message
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }
    }

    // 单个文件删除处理
    try {
        // 解码params.path
        params.path = decodeURIComponent(params.path);
        const fileId = params.path.split(',').join('/');
        const cdnUrl = `https://${url.hostname}/file/${fileId}`;

        const success = await deleteFile(env, fileId, cdnUrl, url);
        if (!success) {
            throw new Error('Delete file failed');
        } else {
            // 从索引中删除文件
            waitUntil(removeFileFromIndex(context, fileId));
        }

        return new Response(JSON.stringify({
            success: true,
            fileId: fileId
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    } catch (e) {
        return new Response(JSON.stringify({
            success: false,
            error: e.message
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

// 删除单个文件的核心函数
export async function deleteFile(env, fileId, cdnUrl, url) {
    try {
        // 读取图片信息
        const db = getDatabase(env);
        const img = await db.getWithMetadata(fileId);

        // 如果文件记录不存在，直接返回成功（幂等删除）
        if (!img) {
            console.warn(`File ${fileId} not found in database, skipping delete`);
            return true;
        }

        // 远端删除：任一渠道删除失败则中止，保留数据库记录以便重试，
        // 避免"远端文件残留 + 数据库引用丢失"导致无法回收的存储泄漏。
        let remoteDeleted = true;
        if (img.metadata?.Channel === 'CloudflareR2') {
            const R2DataBase = env.img_r2;
            await R2DataBase.delete(fileId);
        } else if (img.metadata?.Channel === 'S3') {
            remoteDeleted = await deleteS3File(env, img);
        } else if (img.metadata?.Channel === 'Discord') {
            remoteDeleted = await deleteDiscordFile(env, img);
        } else if (img.metadata?.Channel === 'HuggingFace') {
            remoteDeleted = await deleteHuggingFaceFile(env, img);
        } else if (img.metadata?.Channel === 'WebDAV') {
            remoteDeleted = await deleteWebDAVFile(env, img);
        }

        if (remoteDeleted === false) {
            console.error(`Remote delete failed for ${fileId} (channel ${img.metadata?.Channel}); keeping DB record for retry`);
            return false;
        }

        // 删除数据库中的记录
        // 注意：容量统计现在由索引自动维护，删除文件后索引更新时会自动重新计算
        await db.delete(fileId);

        // 清除CDN缓存
        await purgeCFCache(env, cdnUrl);

        // 清除 api/randomFileList 等API缓存
        const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
        await purgeRandomFileListCache(url.origin, normalizedFolder);
        await purgePublicFileListCache(url.origin, normalizedFolder);

        return true;
    } catch (e) {
        console.error('Delete file failed:', e);
        return false;
    }
}

// 删除 S3 渠道的图片
async function deleteS3File(env, img) {
    const db = getDatabase(env);
    const s3Credentials = await resolveS3Credentials(db, env, img.metadata);
    const s3Client = new S3Client({
        region: s3Credentials.region || "auto",
        endpoint: s3Credentials.endpoint,
        credentials: {
            accessKeyId: s3Credentials.accessKeyId,
            secretAccessKey: s3Credentials.secretAccessKey
        },
        forcePathStyle: s3Credentials.pathStyle || false // 是否启用路径风格
    });

    const bucketName = s3Credentials.bucketName;
    const key = s3Credentials.key;

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        }));
        return true;
    } catch (error) {
        console.error("S3 Delete Failed:", error);
        return false;
    }
}

// 删除 Discord 渠道的图片（删除 Discord 消息）
async function deleteDiscordFile(env, img) {
    const db = getDatabase(env);
    const discordCredentials = await resolveDiscordCredentials(db, env, img.metadata);
    const botToken = discordCredentials.botToken;
    const channelId = discordCredentials.channelId;
    const messageId = discordCredentials.messageId;

    if (!botToken || !channelId || !messageId) {
        console.warn('Discord file missing required metadata for deletion');
        return false;
    }

    try {
        const discordAPI = new DiscordAPI(botToken);
        const success = await discordAPI.deleteMessage(channelId, messageId);
        if (!success) {
            console.error('Discord Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error("Discord Delete Failed:", error);
        return false;
    }
}


// 删除 HuggingFace 渠道的图片
async function deleteHuggingFaceFile(env, img) {
    const db = getDatabase(env);
    const hfCredentials = await resolveHuggingFaceCredentials(db, env, img.metadata);
    const token = hfCredentials.token;
    const repo = hfCredentials.repo;
    const filePath = hfCredentials.filePath;
    const isPrivate = hfCredentials.isPrivate || false;

    if (!token || !repo || !filePath) {
        console.warn('HuggingFace file missing required metadata for deletion');
        return false;
    }

    try {
        const huggingfaceAPI = new HuggingFaceAPI(token, repo, isPrivate);
        const success = await huggingfaceAPI.deleteFile(filePath, `Delete ${filePath}`);
        if (!success) {
            console.error('HuggingFace Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error("HuggingFace Delete Failed:", error);
        return false;
    }
}


// 删除 WebDAV 渠道的图片
async function deleteWebDAVFile(env, img) {
    const filePath = img.metadata?.WebDAVFilePath;

    if (!filePath) {
        console.warn('WebDAV file missing required metadata for deletion');
        return false;
    }

    try {
        const db = getDatabase(env);
        const webdavCredentials = await resolveWebDAVCredentials(db, env, img.metadata);
        if (!webdavCredentials.baseUrl) {
            console.warn('WebDAV channel config not found for deletion');
            return false;
        }

        const webdavAPI = new WebDAVAPI(webdavCredentials);
        return await webdavAPI.deleteFile(filePath);
    } catch (error) {
        console.error("WebDAV Delete Failed:", error);
        return false;
    }
}
