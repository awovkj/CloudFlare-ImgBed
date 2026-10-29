import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { purgeCFCache, purgeRandomFileListCache, purgePublicFileListCache } from './purgeCache.js';
import { getDatabase } from './databaseAdapter.js';
import { DiscordAPI } from './discordAPI.js';
import { HuggingFaceAPI } from './huggingfaceAPI.js';
import { WebDAVAPI } from './storage/webdavAPI.js';
import {
    resolveDiscordCredentials,
    resolveHuggingFaceCredentials,
    resolveS3Credentials,
    resolveWebDAVCredentials,
} from './metadata/channelCredentials.js';

const MAX_DISCORD_CHUNKS = 10000;
const MAX_DISCORD_MANIFEST_LENGTH = 4 * 1024 * 1024;

// A false result leaves metadata intact; callers must remove index entries only on true.
export async function deleteStoredFile(env, fileId, cdnUrl, url) {
    if (typeof fileId !== 'string' || !fileId || fileId.startsWith('manage@') || /^chunk_.+_\d+$/.test(fileId)) {
        return false;
    }
    try {
        const db = getDatabase(env);
        const img = await db.getWithMetadata(fileId);

        // KV returns an object containing nulls for a missing key, not just null.
        if (!img || (img.value === null && img.metadata == null)) {
            return true;
        }

        if (!await deleteRemoteFile(db, env, fileId, img)) {
            console.error(`Remote delete failed for ${fileId}; keeping metadata for retry`);
            return false;
        }

        await db.delete(fileId);

        // Cache outages cannot undo the committed delete or suppress its index update.
        const normalizedFolder = fileId.split('/').slice(0, -1).join('/');
        const invalidations = await Promise.allSettled([
            purgeCFCache(env, cdnUrl),
            purgeRandomFileListCache(url.origin, normalizedFolder),
            purgePublicFileListCache(url.origin, normalizedFolder),
        ]);
        for (const result of invalidations) {
            if (result.status === 'rejected') {
                console.error(`Cache invalidation failed after deleting ${fileId}:`, result.reason);
            }
        }

        return true;
    } catch (e) {
        console.error('Delete file failed:', e);
        return false;
    }
}

async function deleteRemoteFile(db, env, fileId, img) {
    switch (img.metadata?.Channel) {
        case 'CloudflareR2':
            await env.img_r2.delete(fileId);
            return true;
        case 'S3':
            return deleteS3File(db, env, img.metadata);
        case 'Discord':
            return deleteDiscordFile(db, env, img);
        case 'HuggingFace':
            return deleteHuggingFaceFile(db, env, img.metadata);
        case 'WebDAV':
            return deleteWebDAVFile(db, env, img.metadata);
        case 'Telegram':
        case 'TelegramNew':
        case 'External':
        case undefined:
        case null:
        case '':
            // These legacy channels expose no supported remote object-delete operation.
            return true;
        default:
            return false;
    }
}

async function deleteS3File(db, env, metadata) {
    const credentials = await resolveS3Credentials(db, env, metadata);
    if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.bucketName || !credentials.key ||
        !matchesStoredIdentity(metadata.S3BucketName, credentials.bucketName) ||
        !matchesStoredUrl(metadata.S3Endpoint, credentials.endpoint)) {
        return false;
    }

    const s3Client = new S3Client({
        region: credentials.region || 'auto',
        endpoint: credentials.endpoint || undefined,
        credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
        },
        forcePathStyle: credentials.pathStyle || false,
    });

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: credentials.bucketName,
            Key: credentials.key,
        }));
        return true;
    } finally {
        s3Client.destroy();
    }
}

async function deleteDiscordFile(db, env, img) {
    const credentials = await resolveDiscordCredentials(db, env, img.metadata);
    if (!credentials.botToken || !credentials.channelId ||
        !matchesStoredIdentity(img.metadata?.DiscordChannelId, credentials.channelId)) {
        return false;
    }

    const messageIds = discordMessageIds(img, credentials.messageId);
    if (!messageIds) return false;

    const discordAPI = new DiscordAPI(credentials.botToken);
    // Keep the complete manifest on failure. Retrying missing messages is idempotent.
    for (const messageId of messageIds) {
        if (await discordAPI.deleteMessage(credentials.channelId, messageId) !== true) {
            return false;
        }
    }
    return true;
}

function discordMessageIds(img, messageId) {
    if (img.metadata?.IsChunked !== true) {
        return typeof messageId === 'string' && messageId.trim() ? [messageId] : null;
    }

    if (typeof img.value !== 'string' || img.value.length > MAX_DISCORD_MANIFEST_LENGTH) return null;
    let chunks;
    try {
        chunks = JSON.parse(img.value);
    } catch {
        return null;
    }
    if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_DISCORD_CHUNKS) return null;
    if (img.metadata.TotalChunks !== undefined &&
        (!Number.isSafeInteger(img.metadata.TotalChunks) || img.metadata.TotalChunks !== chunks.length)) {
        return null;
    }

    const indexes = new Set();
    const messageIds = new Set();
    // Validate the entire manifest before the first irreversible provider operation.
    for (const chunk of chunks) {
        if (!chunk || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= chunks.length ||
            indexes.has(chunk.index) || typeof chunk.messageId !== 'string' || !chunk.messageId.trim() ||
            messageIds.has(chunk.messageId)) {
            return null;
        }
        indexes.add(chunk.index);
        messageIds.add(chunk.messageId);
    }
    return chunks.sort((left, right) => left.index - right.index).map(chunk => chunk.messageId);
}

async function deleteHuggingFaceFile(db, env, metadata) {
    const credentials = await resolveHuggingFaceCredentials(db, env, metadata);
    if (!credentials.token || !credentials.repo || !credentials.filePath) {
        return false;
    }

    const huggingfaceAPI = new HuggingFaceAPI(credentials.token, credentials.repo, credentials.isPrivate || false);
    return await huggingfaceAPI.deleteFile(credentials.filePath, `Delete ${credentials.filePath}`) === true;
}

async function deleteWebDAVFile(db, env, metadata) {
    const credentials = await resolveWebDAVCredentials(db, env, metadata);
    if (!credentials.baseUrl || !credentials.filePath ||
        !matchesStoredUrl(metadata.WebDAVBaseUrl, credentials.baseUrl)) {
        return false;
    }

    const webdavAPI = new WebDAVAPI(credentials);
    return await webdavAPI.deleteFile(credentials.filePath) === true;
}

function matchesStoredIdentity(stored, configured) {
    return stored === undefined || stored === null || stored === '' ||
        String(stored).trim() === String(configured ?? '').trim();
}

function matchesStoredUrl(stored, configured) {
    if (stored === undefined || stored === null || stored === '') return true;
    try {
        return normalizeObjectUrl(stored) === normalizeObjectUrl(configured);
    } catch {
        return false;
    }
}

function normalizeObjectUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error('Missing storage URL');
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Invalid storage URL');
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}
