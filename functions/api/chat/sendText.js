import {
    ensureChatAccess,
    getChatTelegramChannels,
    resolveTelegramChannel,
    buildChatTextMetadata,
    storeChatTextRecord,
    sendTelegramText,
    jsonResponse,
} from './shared.js';

export async function onRequest(context) {
    const access = await ensureChatAccess(context);
    if (access.response) {
        return access.response;
    }

    if (context.request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
        const body = await context.request.json();
        const text = String(body?.text || '').trim();
        const channelName = String(body?.channelName || '').trim();

        if (!text) {
            return jsonResponse({ error: 'Message text is required' }, 400);
        }

        const channels = await getChatTelegramChannels(context.env, context);
        const channel = resolveTelegramChannel(channels, channelName);

        await sendTelegramText(channel, text);

        const metadata = buildChatTextMetadata(text, channel);
        const id = await storeChatTextRecord(context.env, context, metadata);

        return jsonResponse({
            success: true,
            id,
            channel: metadata.ChannelName,
            timestamp: metadata.TimeStamp,
        });
    } catch (error) {
        const status = Number(error?.status || 0);
        return jsonResponse({ error: error.message || 'Failed to send text message' }, status >= 400 && status < 600 ? status : 500);
    }
}
