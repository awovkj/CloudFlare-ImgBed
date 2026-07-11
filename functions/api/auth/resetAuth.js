import { getDatabase } from "../../utils/databaseAdapter.js";
import { destroySessionsByAuthType } from "../../utils/auth/sessionManager.js";

/**
 * 认证重置接口
 *
 * 使用方式（改为 POST + 请求头传递密钥，避免密钥进入浏览器历史、访问日志与 Referer）：
 * 1. 设置环境变量 RESET_KEY（任意字符串，建议足够复杂）
 * 2. 执行：curl -X POST https://你的域名/api/resetAuth -H "X-Reset-Key: 你设置的RESET_KEY"
 * 3. 成功后认证配置被清除，可直接进入管理端重新设置
 * 4. 用完后建议删除或更换 RESET_KEY 环境变量
 */

// 常量时间字符串比较，避免通过响应时间侧信道推断密钥
function timingSafeEqualStr(a, b) {
    const aStr = typeof a === 'string' ? a : '';
    const bStr = typeof b === 'string' ? b : '';
    const enc = new TextEncoder();
    const ab = enc.encode(aStr);
    const bb = enc.encode(bStr);
    let mismatch = ab.length === bb.length ? 0 : 1;
    const len = Math.max(ab.length, bb.length);
    for (let i = 0; i < len; i++) {
        mismatch |= (ab[i] || 0) ^ (bb[i] || 0);
    }
    return mismatch === 0;
}

const NO_STORE_JSON = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

export async function onRequestPost(context) {
    const { request, env } = context;

    // 检查是否配置了重置密钥
    const resetKey = env.RESET_KEY;
    if (!resetKey || resetKey.trim() === '') {
        return new Response(JSON.stringify({
            error: 'RESET_KEY not configured. Set the RESET_KEY environment variable first.'
        }), { status: 403, headers: NO_STORE_JSON });
    }

    // 从请求头获取密钥（不再使用 URL 查询参数）
    const key = request.headers.get('X-Reset-Key') || '';

    if (!timingSafeEqualStr(key, resetKey)) {
        return new Response(JSON.stringify({ error: 'Invalid reset key' }), {
            status: 403, headers: NO_STORE_JSON,
        });
    }

    try {
        const db = getDatabase(env);

        // 读取现有安全配置
        const settingsStr = await db.get('manage@sysConfig@security');
        if (settingsStr) {
            const settings = JSON.parse(settingsStr);
            // 只清除认证信息，保留其他安全设置（审核、域名白名单等）
            delete settings.auth;
            await db.put('manage@sysConfig@security', JSON.stringify(settings));
        }

        // 清除所有会话
        const adminDestroyed = await destroySessionsByAuthType(env, 'admin');
        const userDestroyed = await destroySessionsByAuthType(env, 'user');

        return new Response(JSON.stringify({
            success: true,
            message: 'Auth credentials reset. Other security settings preserved. All sessions cleared.',
            sessionsCleared: { admin: adminDestroyed, user: userDestroyed }
        }), { status: 200, headers: NO_STORE_JSON });
    } catch (err) {
        console.error('resetAuth failed:', err);
        return new Response(JSON.stringify({
            error: 'Reset failed'
        }), { status: 500, headers: NO_STORE_JSON });
    }
}
