import { fetchOthersConfig, fetchUploadConfig } from '../../utils/sysConfig.js';
import { userAuthCheck, UnauthorizedResponse } from '../../utils/userAuth.js';
import { CHAT_DIRECTORY, CHAT_DIRECTORY_PREFIX, CHAT_RECORD_TYPE, CHAT_SOURCE_APP, CHAT_TEXT_PREFIX, createChatTextRecordId, isChatTransferRecord, listAllKeysByPrefix } from '../../utils/chat.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { addFileToIndex, readIndex, batchRemoveFilesFromIndex } from '../../utils/indexManager.js';
import { deleteStoredFile } from '../../utils/deleteFile.js';
import { TelegramAPI } from '../../utils/telegramAPI.js';

export const chatCorsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, authCode',
    'Access-Control-Max-Age': '86400',
};

export function jsonResponse(payload, status = 200, headers = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...chatCorsHeaders,
            ...headers,
        },
    });
}

export function getChannelLabel(uploadChannel = {}) {
    return uploadChannel.name || 'default';
}

export async function ensureChatAccess(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return { response: new Response(null, { status: 204, headers: chatCorsHeaders }) };
    }

    if (!await userAuthCheck(env, url, request, 'upload')) {
        return { response: UnauthorizedResponse('Unauthorized') };
    }

    const othersConfig = await fetchOthersConfig(env);
    if (!othersConfig.chatPage?.enabled) {
        return { response: jsonResponse({ error: 'Chat page is disabled', enabled: false }, 403) };
    }

    return { url, othersConfig };
}

export async function getChatTelegramChannels(env, context) {
    const uploadConfig = await fetchUploadConfig(env, context);
    return uploadConfig.telegram?.channels || [];
}

export function resolveTelegramChannel(channels, channelName = '') {
    if (!channels.length) {
        throw new Error('No Telegram channel configured');
    }

    if (channelName) {
        const matched = channels.find(channel => channel.name === channelName);
        if (!matched) {
            throw new Error('Telegram channel not found');
        }
        return matched;
    }

    return channels[0];
}

export function buildChatTextMetadata(text, channel) {
    const timestamp = Date.now();
    return {
        SourceApp: CHAT_SOURCE_APP,
        RecordType: CHAT_RECORD_TYPE,
        MessageType: 'text',
        MessageText: text,
        FileType: 'text/plain',
        FileName: `message_${timestamp}.txt`,
        FileSize: '0',
        FileSizeBytes: 0,
        ListType: 'None',
        TimeStamp: timestamp,
        Label: 'None',
        Directory: CHAT_DIRECTORY_PREFIX,
        Tags: [],
        Channel: 'TelegramNew',
        ChannelName: getChannelLabel(channel),
        TgChatId: channel.chatId,
        TgBotToken: channel.botToken,
        ...(channel.proxyUrl ? { TgProxyUrl: channel.proxyUrl } : {}),
    };
}

export async function storeChatTextRecord(env, context, metadata) {
    const db = getDatabase(env);
    const recordId = createChatTextRecordId();
    await db.put(recordId, '', { metadata });
    await addFileToIndex(context, recordId, metadata);
    return recordId;
}

export async function listChatHistory(context) {
    let indexResult = { files: [] };

    try {
        indexResult = await readIndex(context, {
            directory: CHAT_DIRECTORY,
            count: -1,
            includeSubdirFiles: true,
        });
    } catch (error) {
        const message = String(error?.message || '');
        if (!message.includes('Index metadata not found') && !message.includes('Failed to get index')) {
            throw error;
        }
    }

    const files = (indexResult.files || []).filter(file => isChatTransferRecord(file.metadata));

    return files.map(file => ({
        id: file.id,
        type: file.metadata?.MessageType || 'file',
        text: file.metadata?.MessageText || '',
        fileName: file.metadata?.FileName || file.id,
        fileType: file.metadata?.FileType || '',
        fileSize: file.metadata?.FileSize || '0',
        timestamp: file.metadata?.TimeStamp || 0,
        channel: file.metadata?.ChannelName || '',
        url: file.metadata?.MessageType === 'file' ? `/file/${file.id}` : null,
        isChunked: file.metadata?.IsChunked === true,
    }));
}

export async function clearChatHistory(context) {
    const { env, request } = context;
    const url = new URL(request.url);
    const db = getDatabase(env);

    const history = await listChatHistory(context);
    const deletedIds = [];
    const failedIds = [];

    for (const item of history) {
        try {
            if (item.type === 'file') {
                const cdnUrl = `https://${url.hostname}/file/${item.id}`;
                const success = await deleteStoredFile(env, item.id, cdnUrl, url);
                if (!success) {
                    failedIds.push(item.id);
                    continue;
                }
            } else {
                await db.delete(item.id);
            }
            deletedIds.push(item.id);
        } catch (error) {
            console.error('Failed to clear chat item:', item.id, error);
            failedIds.push(item.id);
        }
    }

    if (deletedIds.length > 0) {
        await batchRemoveFilesFromIndex(context, deletedIds);
    }

    const strayTextKeys = await listAllKeysByPrefix(db, CHAT_TEXT_PREFIX);
    for (const key of strayTextKeys) {
        if (!deletedIds.includes(key.name)) {
            try {
                await db.delete(key.name);
            } catch (error) {
                console.warn('Failed to delete stray chat text key:', key.name, error.message);
            }
        }
    }

    return { deletedIds, failedIds };
}

export async function sendTelegramText(channel, text) {
    const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    return telegramAPI.sendMessage(channel.chatId, text);
}
