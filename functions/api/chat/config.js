import { ensureChatAccess, getChatTelegramChannels, jsonResponse } from './shared.js';

const CHAT_CHUNK_SIZE_BYTES = 18 * 1024 * 1024;

export async function onRequest(context) {
    const access = await ensureChatAccess(context);
    if (access.response) {
        return access.response;
    }

    if (context.request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const channels = await getChatTelegramChannels(context.env, context);
    const channelItems = channels.map((channel) => ({
        name: channel.name || 'default'
    }));

    return jsonResponse({
        enabled: true,
        channels: channelItems,
        defaultChannel: channelItems[0]?.name || '',
        chunkSizeBytes: CHAT_CHUNK_SIZE_BYTES
    });
}
