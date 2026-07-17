import { D1Database } from './d1Database.js';

// 模块级适配器缓存：Cloudflare Workers 在同一 isolate 内复用模块，但不同请求可能使用不同 env。
// 使用 WeakMap 以 env 对象为键，避免持有强引用导致内存泄漏。
const adapterCache = new WeakMap();

/**
 * 创建数据库适配器
 * @param {Object} env - 环境变量
 * @returns {Object} 数据库适配器实例
 */
function createDatabaseAdapter(env) {
    // 检查是否配置了数据库
    if (env.img_url && typeof env.img_url.get === 'function') {
        // 使用KV存储
        return new KVAdapter(env.img_url);
    } else if (env.img_d1 && typeof env.img_d1.prepare === 'function') {
        // 使用D1数据库
        return new D1Database(env.img_d1);
    } else {
        console.error('No database configured. Please configure either KV (env.img_url) or D1 (env.img_d1).');
        return null;
    }
}

/**
 * KV适配器类
 * 保持与原有KV接口的兼容性
 * 优化：直接返回 KV 的 Promise，避免不必要的 async/await 微任务开销
 */
class KVAdapter {
    constructor(kv) {
        this.kv = kv;
    }

    put(key, value, options) {
        return this.kv.put(key, value, options || {});
    }

    get(key, options) {
        return this.kv.get(key, options || {});
    }

    getWithMetadata(key, options) {
        return this.kv.getWithMetadata(key, options || {});
    }

    delete(key, options) {
        return this.kv.delete(key, options || {});
    }

    list(options) {
        return this.kv.list(options || {});
    }
}

/**
 * 获取数据库实例的便捷函数
 * 这个函数可以在整个应用中使用，确保一致的数据库访问
 * @param {Object} env - 环境变量
 * @returns {Object} 数据库实例
 */
export function getDatabase(env) {
    // 先查缓存
    const cached = adapterCache.get(env);
    if (cached) return cached;

    const adapter = createDatabaseAdapter(env);
    if (!adapter) {
        throw new Error('Database not configured. Please configure D1 database (env.img_d1) or KV storage (env.img_url).');
    }

    adapterCache.set(env, adapter);
    return adapter;
}

/**
 * 检查数据库配置
 * @param {Object} env - 环境变量
 * @returns {Object} 配置信息
 */
export function checkDatabaseConfig(env) {
    const hasD1 = !!(env.img_d1 && typeof env.img_d1.prepare === 'function');
    const hasKV = !!(env.img_url && typeof env.img_url.get === 'function');

    return {
        hasD1,
        hasKV,
        usingD1: !hasKV && hasD1,
        usingKV: hasKV,
        configured: hasD1 || hasKV
    };
}
