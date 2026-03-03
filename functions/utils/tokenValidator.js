// API Token权限验证工具函数
import { getTokenPermissions } from '../api/manage/apiTokens.js';

/**
 * 验证API Token权限
 * @param {Request} request - 请求对象
 * @param {Object} db - 数据库适配器
 * @param {string} requiredPermission - 需要的权限 ('upload', 'delete', 'list')
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
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

    // 获取Token权限
    const permissions = await getTokenPermissions(db, token);
    
    if (!permissions) {
        return { valid: false, error: '无效的Token' };
    }

    // 检查权限，如果不需要特定权限（requiredPermission为null），则只要token有效就通过
    if (requiredPermission !== null && !permissions.includes(requiredPermission)) {
        return { valid: false, error: `缺少${requiredPermission}权限` };
    }

    return { valid: true };
}
