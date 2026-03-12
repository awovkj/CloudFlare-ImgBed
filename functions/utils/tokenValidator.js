import { getTokenData } from '../api/manage/apiTokens.js';
import { isExpired } from './tokenExpiration.js';

export async function validateApiToken(request, db, requiredPermission) {
    const authHeader = request.headers.get('Authorization');
    
    if (!authHeader) {
        return { valid: false, error: '缺少Authorization头' };
    }

    let token;
    
    // 支持两种格式: "Bearer token" 或 "token"
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else {
        token = authHeader;
    }

    if (!token) {
        return { valid: false, error: '无效的Token格式' };
    }

    const tokenData = await getTokenData(db, token);
    if (!tokenData) {
        return { valid: false, error: '无效的Token' };
    }

    if (isExpired(tokenData.expiresAt)) {
        return { valid: false, error: 'Token 已过期' };
    }

    if (requiredPermission !== null && !tokenData.permissions.includes(requiredPermission)) {
        return { valid: false, error: `缺少${requiredPermission}权限` };
    }

    return { valid: true };
}

export async function getTokenInfo(request, kv) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
        return null;
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    if (!token) {
        return null;
    }

    const settingsStr = await kv.get('manage@sysConfig@security');
    const settings = settingsStr ? JSON.parse(settingsStr) : {};
    const tokens = settings.apiTokens?.tokens || {};

    for (const tokenId in tokens) {
        if (tokens[tokenId].token === token) {
            const item = tokens[tokenId];
            return {
                ...item,
                expiresAt: item.expiresAt ?? null,
                autoDelete: item.autoDelete ?? false
            };
        }
    }

    return null;
}
