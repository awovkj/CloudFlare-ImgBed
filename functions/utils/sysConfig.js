import { getUploadConfig } from '../api/manage/sysConfig/upload.js';
import { getSecurityConfig } from '../api/manage/sysConfig/security.js';
import { getPageConfig } from '../api/manage/sysConfig/page.js';
import { getOthersConfig } from '../api/manage/sysConfig/others.js';
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

function markConfigFallback(defaultValue) {
    const cloned = cloneDefaultValue(defaultValue);

    if (cloned && typeof cloned === 'object' && !Array.isArray(cloned)) {
        cloned.__configSource = 'fallback';
    }

    return cloned;
}

async function fetchConfigWithFallback(env, configName, loader, defaultValue, options = {}) {
    const { failClosed = false } = options;

    try {
        const db = getDatabase(env);
        return await loader(db, env);
    } catch (error) {
        console.error(`Failed to fetch ${configName} config:`, error);

        if (failClosed) {
            throw new Error(`Failed to fetch ${configName} config`);
        }

        return markConfigFallback(defaultValue);
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
    access: { allowedDomains: "", whiteListMode: false, sessionSecure: false, userSessionMaxAge: 14, adminSessionMaxAge: 14 }
};

const DEFAULT_PAGE_CONFIG = { config: [] };

const DEFAULT_OTHERS_CONFIG = {
    showStats: { enabled: true },
    chatPage: { enabled: false },
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

    // 根据容量限制过滤渠道（R2、S3、HuggingFace）
    // 需要 context 来调用 getIndexMeta
    if (context) {
        settings.cfr2.channels = await filterChannelsByQuota(context, settings.cfr2.channels);
        settings.s3.channels = await filterChannelsByQuota(context, settings.s3.channels);
        settings.huggingface.channels = await filterChannelsByQuota(context, settings.huggingface.channels);
    }

    return settings;
}

export async function fetchSecurityConfig(env) {
    return fetchConfigWithFallback(env, 'security', getSecurityConfig, DEFAULT_SECURITY_CONFIG, {
        failClosed: true
    });
}

export async function fetchPageConfig(env) {
    return fetchConfigWithFallback(env, 'page', getPageConfig, DEFAULT_PAGE_CONFIG);
}

export async function fetchOthersConfig(env) {
    const config = await fetchConfigWithFallback(env, 'others', getOthersConfig, DEFAULT_OTHERS_CONFIG);

    if (!config.__configSource) {
        config.__configSource = 'configured';
    }

    return config;
}

/**
 * 根据文件元数据解析 HuggingFace 渠道配置（token、repo 等）
 * 优先从系统配置中查找，避免依赖 KV metadata 中存储的 token
 * 兼容旧数据：如果配置中找不到，回退到 metadata 中的 HfToken
 * @param {Object} env - 环境变量
 * @param {Object} metadata - 文件元数据
 * @returns {Object} { token, repo, isPrivate }
 */
export async function resolveHfChannelConfig(env, metadata) {
    const channelName = metadata.ChannelName;
    const hfRepo = metadata.HfRepo;

    try {
        const uploadConfig = await fetchUploadConfig(env);
        const hfChannels = uploadConfig.huggingface?.channels || [];

        // 1. 按渠道名称匹配
        if (channelName) {
            const match = hfChannels.find(c => c.name === channelName);
            if (match?.token) {
                return { token: match.token, repo: match.repo || hfRepo, isPrivate: match.isPrivate || false };
            }
        }

        // 2. 按仓库名称匹配
        if (hfRepo) {
            const match = hfChannels.find(c => c.repo === hfRepo);
            if (match?.token) {
                return { token: match.token, repo: match.repo, isPrivate: match.isPrivate || false };
            }
        }

        // 3. 如果只有一个渠道，直接使用
        if (hfChannels.length === 1 && hfChannels[0].token) {
            return { token: hfChannels[0].token, repo: hfChannels[0].repo || hfRepo, isPrivate: hfChannels[0].isPrivate || false };
        }
    } catch (error) {
        console.warn('resolveHfChannelConfig: failed to fetch config, falling back to metadata:', error.message);
    }

    // 4. 兼容旧数据：回退到 metadata 中的 HfToken
    if (metadata.HfToken) {
        return { token: metadata.HfToken, repo: hfRepo, isPrivate: metadata.HfIsPrivate || false };
    }

    return null;
}
