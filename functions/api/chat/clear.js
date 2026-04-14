import { ensureChatAccess, clearChatHistory, jsonResponse } from './shared.js';

export async function onRequest(context) {
    const access = await ensureChatAccess(context);
    if (access.response) {
        return access.response;
    }

    if (context.request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const result = await clearChatHistory(context);

    return jsonResponse({
        success: result.failedIds.length === 0,
        deletedIds: result.deletedIds,
        failedIds: result.failedIds,
        deletedCount: result.deletedIds.length,
        failedCount: result.failedIds.length,
    });
}
