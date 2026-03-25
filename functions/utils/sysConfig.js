import { getUploadConfig } from '../api/manage/sysConfig/upload';
import { getSecurityConfig } from '../api/manage/sysConfig/security';
import { getPageConfig } from '../api/manage/sysConfig/page';
import { getOthersConfig } from '../api/manage/sysConfig/others';
import { getDatabase } from './databaseAdapter.js';
import { getIndexMeta } from './indexManager.js';

function cloneDefaultValue(defaultValue) {
    if (Array.isArray(defaultValue)) {
        return [...defaultValue];
    }

    if (defaultValue && typeof defaultValue === 'object') {
        return { ...defaultValue };
    }

    return defaultValue;
}

async function fetchConfigWithFallback(env, configName, loader, defaultValue) {
    try {
        const db = getDatabase(env);
        return await loader(db, env);
    } catch (error) {
        console.error(`Failed to fetch ${configName} config:`, error);
        return cloneDefaultValue(defaultValue);
    }
}

const DEFAULT_UPLOAD_CONFIG = {
    telegram: { channels: [] },
    cfr2: { channels: [] },
    s3: { channels: [] },
    discord: { channels: [] },
    huggingface: { channels: [] }
};

const DEFAULT_SECURITY_CONFIG = {
    auth: {
        user: { authCode: "" },
        admin: { adminUsername: "", adminPassword: "" }
    },
    upload: {
        moderate: { enabled: false, channel: "default", moderateContentApiKey: "", nsfwApiPath: "" }
    },
    access: { allowedDomains: "", whiteListMode: false }
};

const DEFAULT_PAGE_CONFIG = { config: [] };

const DEFAULT_OTHERS_CONFIG = {
    showStats: { enabled: true },
};

/**
 * 根据容量限制过滤渠道
 * @param {Object} context - 上下文对象（包含 env）
 * @param {Array} channels - 渠道列表
 * @returns {Array} 过滤后的渠道列表
 */
async function filterChannelsByQuota(context, channels) {
    // 先检查是否有任何渠道启用了容量限制，如果都没启用则跳过 KV 读取
    const hasQuotaEnabled = channels.some(ch => ch.quota?.enabled && ch.quota?.limitGB);
    if (!hasQuotaEnabled) {
        return channels; // 无需读取 KV，直接返回所有渠道
    }

    // 获取索引元数据（只需 1 次读取）
    const indexMeta = await getIndexMeta(context);
    const channelStats = indexMeta.channelStats || {};

    // 并行检查所有渠道的配额状态
    const results = await Promise.all(channels.map(async (channel) => {
        // 未启用容量限制，直接通过
        if (!channel.quota?.enabled || !channel.quota?.limitGB) {
            return channel;
        }

        try {
            const stats = channelStats[channel.name] || { usedMB: 0, fileCount: 0 };
            const usedGB = stats.usedMB / 1024;
            const limitGB = channel.quota.limitGB;
            const threshold = channel.quota.threshold || 95;

            if ((usedGB / limitGB) * 100 < threshold) {
                return channel;
            } else {
                console.log(`Channel ${channel.name} quota exceeded: ${usedGB.toFixed(2)}GB / ${limitGB}GB (${threshold}% threshold)`);
                return null; // 超过阈値时返回 null
            }
        } catch (error) {
            console.error(`Failed to check quota for channel ${channel.name}:`, error);
            return channel; // 检查失败时保守处理，允许使用该渠道
        }
    }));

    // 过滤掉 null（超额渠道）
    return results.filter(Boolean);
}

function filterEnabledChannels(settings, channelGroups) {
    for (const group of channelGroups) {
        settings[group].channels = settings[group].channels.filter((channel) => channel.enabled);
    }
}

export async function fetchUploadConfig(env, context = null) {
    const settings = await fetchConfigWithFallback(env, 'upload', getUploadConfig, DEFAULT_UPLOAD_CONFIG);
    filterEnabledChannels(settings, ['telegram', 'cfr2', 's3', 'discord', 'huggingface']);

    // 根据容量限制过滤渠道（仅 R2 和 S3）
    // 需要 context 来调用 getIndexMeta
    if (context) {
        settings.cfr2.channels = await filterChannelsByQuota(context, settings.cfr2.channels);
        settings.s3.channels = await filterChannelsByQuota(context, settings.s3.channels);
    }

    return settings;
}

export async function fetchSecurityConfig(env) {
    return fetchConfigWithFallback(env, 'security', getSecurityConfig, DEFAULT_SECURITY_CONFIG);
}

export async function fetchPageConfig(env) {
    return fetchConfigWithFallback(env, 'page', getPageConfig, DEFAULT_PAGE_CONFIG);
}

export async function fetchOthersConfig(env) {
    return fetchConfigWithFallback(env, 'others', getOthersConfig, DEFAULT_OTHERS_CONFIG);
}
