import { ensureChatAccess, listChatHistory, jsonResponse } from './shared.js';

export async function onRequest(context) {
    const access = await ensureChatAccess(context);
    if (access.response) {
        return access.response;
    }

    if (context.request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const items = await listChatHistory(context);
    return jsonResponse({
        items,
        totalCount: items.length,
    });
}
