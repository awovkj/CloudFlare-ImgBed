export const CHAT_SOURCE_APP = 'chat';
export const CHAT_RECORD_TYPE = 'chat_transfer';
export const CHAT_DIRECTORY = '__chat__';
export const CHAT_DIRECTORY_PREFIX = `${CHAT_DIRECTORY}/`;
export const CHAT_TEXT_PREFIX = '__chat_text__/';

export function isChatRequestFromUrl(url) {
    if (!url) return false;
    return url.searchParams.get('sourceApp') === CHAT_SOURCE_APP ||
        url.searchParams.get('recordType') === CHAT_RECORD_TYPE;
}

export function isChatUploadChannel(uploadChannel) {
    if (!uploadChannel) return true;
    const normalized = String(uploadChannel).toLowerCase();
    return normalized === 'telegram' || normalized === 'telegramnew';
}

export function applyChatTransferMetadata(metadata, messageType = 'file') {
    metadata.SourceApp = CHAT_SOURCE_APP;
    metadata.RecordType = CHAT_RECORD_TYPE;
    metadata.MessageType = messageType;
    if (!metadata.Directory) {
        metadata.Directory = CHAT_DIRECTORY_PREFIX;
    }
    return metadata;
}

export function isChatTransferRecord(metadata = {}) {
    return metadata.SourceApp === CHAT_SOURCE_APP && metadata.RecordType === CHAT_RECORD_TYPE;
}

export function createChatTextRecordId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 10);
    return `${CHAT_TEXT_PREFIX}${timestamp}_${random}.txt`;
}

export async function listAllKeysByPrefix(db, prefix) {
    const keys = [];
    let cursor = undefined;

    while (true) {
        const response = await db.list({ prefix, limit: 1000, cursor });
        keys.push(...(response?.keys || []));
        if (response?.list_complete !== false || !response?.cursor) {
            break;
        }
        cursor = response.cursor;
    }

    return keys;
}
