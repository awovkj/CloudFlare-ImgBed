/**
 * 上传凭证（upload receipt）
 *
 * 用途：让"刚上传完成"的文件可以在不登录管理员的情况下生成临时链接。
 *
 * 背景：
 *  - 上传接口（/upload）仅需 user 级别鉴权（甚至可匿名），而临时链接管理接口
 *    (/api/manage/temp-link/) 走 manage 中间件，要求管理员鉴权。
 *  - 因此非管理员上传者（或开放上传时的匿名用户）上传后无法生成临时链接。
 *
 * 方案：
 *  - 上传成功时为该文件签发一个绑定 fileId 的随机凭证，写入 KV/D1 并带 TTL。
 *  - 凭证随上传响应返回给上传者（仅上传者持有）。
 *  - manage 中间件对 /api/manage/temp-link/{fileId} 路由放行"凭证 + fileId 匹配"的请求，
 *    无需管理员登录。
 *
 * 安全性：
 *  - 凭证 128 位随机，不可猜测；绑定 fileId，不可跨文件使用。
 *  - 短 TTL（30 分钟），过期自动失效。
 *  - 仅返回给上传者，不公开。
 */

import { getDatabase } from '../utils/databaseAdapter.js';

const RECEIPT_PREFIX = 'temp_link_receipt:';
// 凭证有效期：30 分钟。仅覆盖"刚上传完成后"生成临时链接的场景。
const RECEIPT_TTL_SECONDS = 30 * 60;

function generateReceiptToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isValidToken(token) {
    return typeof token === 'string' && /^[a-f0-9]{16,128}$/i.test(token);
}

/**
 * 从返回链接（/file/{fileId} 或 https://host/file/{fileId}）中提取 fileId
 */
export function extractFileIdFromLink(returnLink) {
    if (!returnLink || typeof returnLink !== 'string') return null;
    const match = returnLink.match(/\/file\/(.+)$/);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]).split(',').join('/');
    } catch (e) {
        return null;
    }
}

/**
 * 为刚上传的文件签发临时链接凭证。
 * 同一请求内对相同 fileId 复用凭证，避免重复写入。
 *
 * @param {Object} context - 请求上下文（需含 env）
 * @param {string} fileId - 文件 ID
 * @returns {Promise<string|null>} 凭证 token，失败返回 null
 */
export async function issueTempLinkReceipt(context, fileId) {
    if (!fileId || !context?.env) return null;

    if (!context._tempLinkReceipts) {
        context._tempLinkReceipts = Object.create(null);
    }
    if (context._tempLinkReceipts[fileId]) {
        return context._tempLinkReceipts[fileId];
    }

    try {
        const token = generateReceiptToken();
        const db = getDatabase(context.env);
        await db.put(RECEIPT_PREFIX + token, JSON.stringify({
            fileId,
            issuedAt: Date.now(),
        }), { expirationTtl: RECEIPT_TTL_SECONDS });
        context._tempLinkReceipts[fileId] = token;
        return token;
    } catch (e) {
        console.warn('Failed to issue temp link receipt:', e?.message || e);
        return null;
    }
}

/**
 * 校验临时链接凭证是否对指定 fileId 有效。
 *
 * @param {Object} env - 环境变量
 * @param {string} receiptToken - 凭证 token
 * @param {string} fileId - 请求访问的文件 ID
 * @returns {Promise<boolean>}
 */
export async function verifyTempLinkReceipt(env, receiptToken, fileId) {
    if (!isValidToken(receiptToken) || !fileId) return false;
    try {
        const db = getDatabase(env);
        const raw = await db.get(RECEIPT_PREFIX + receiptToken);
        if (!raw) return false;
        const data = JSON.parse(raw);
        return data?.fileId === fileId;
    } catch (e) {
        return false;
    }
}
