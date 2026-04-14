import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from './purgeCache.js';
import { getDatabase } from './databaseAdapter.js';
import { DiscordAPI } from './discordAPI.js';
import { HuggingFaceAPI } from './huggingfaceAPI.js';
import { resolveHfChannelConfig } from './sysConfig.js';

export async function deleteStoredFile(env, fileId, cdnUrl, url) {
    try {
        const db = getDatabase(env);
        const img = await db.getWithMetadata(fileId);

        if (!img) {
            console.warn(`File ${fileId} not found in database, skipping delete`);
            return true;
        }

        if (img.metadata?.Channel === 'CloudflareR2') {
            const R2DataBase = env.img_r2;
            await R2DataBase.delete(fileId);
        }

        if (img.metadata?.Channel === 'S3') {
            await deleteS3File(img);
        }

        if (img.metadata?.Channel === 'Discord') {
            await deleteDiscordFile(img);
        }

        if (img.metadata?.Channel === 'HuggingFace') {
            await deleteHuggingFaceFile(env, img);
        }

        await db.delete(fileId);
        await purgeCFCache(env, cdnUrl);

        const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
        await purgeRandomFileListCache(url.origin, normalizedFolder);
        await purgePublicFileListCache(url.origin, normalizedFolder);

        return true;
    } catch (e) {
        console.error('Delete file failed:', e);
        return false;
    }
}

async function deleteS3File(img) {
    const s3Client = new S3Client({
        region: img.metadata?.S3Region || 'auto',
        endpoint: img.metadata?.S3Endpoint,
        credentials: {
            accessKeyId: img.metadata?.S3AccessKeyId,
            secretAccessKey: img.metadata?.S3SecretAccessKey
        },
        forcePathStyle: img.metadata?.S3PathStyle || false
    });

    const bucketName = img.metadata?.S3BucketName;
    const key = img.metadata?.S3FileKey;

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        }));
        return true;
    } catch (error) {
        console.error('S3 Delete Failed:', error);
        return false;
    }
}

async function deleteDiscordFile(img) {
    const botToken = img.metadata?.DiscordBotToken;
    const channelId = img.metadata?.DiscordChannelId;
    const messageId = img.metadata?.DiscordMessageId;

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
        console.error('Discord Delete Failed:', error);
        return false;
    }
}

async function deleteHuggingFaceFile(env, img) {
    const repo = img.metadata?.HfRepo;
    const filePath = img.metadata?.HfFilePath;

    if (!repo || !filePath) {
        console.warn('HuggingFace file missing required metadata for deletion');
        return false;
    }

    const channelConfig = await resolveHfChannelConfig(env, img.metadata);
    if (!channelConfig?.token) {
        console.warn('HuggingFace delete: no token found in config or metadata');
        return false;
    }

    try {
        const huggingfaceAPI = new HuggingFaceAPI(channelConfig.token, channelConfig.repo || repo, channelConfig.isPrivate || false);
        const success = await huggingfaceAPI.deleteFile(filePath, `Delete ${filePath}`);
        if (!success) {
            console.error('HuggingFace Delete Failed: API returned false');
        }
        return success;
    } catch (error) {
        console.error('HuggingFace Delete Failed:', error);
        return false;
    }
}
