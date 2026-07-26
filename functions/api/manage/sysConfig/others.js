import { getDatabase } from '../../../utils/databaseAdapter.js';
import { hashPassword } from '../../../utils/auth/passwordHash.js';
import { destroySessionsByAuthType } from '../../../utils/auth/sessionManager.js';
import { createApiToken, deleteApiToken } from '../apiTokens.js';

function sanitizeManagementSettings(settings) {
    const sanitized = JSON.parse(JSON.stringify(settings));
    const musicPlayer = sanitized.musicPlayer || {};
    const passwordConfigured = Boolean(musicPlayer.passwordHash);

    delete musicPlayer.password;
    delete musicPlayer.passwordHash;
    delete musicPlayer.clearPassword;
    musicPlayer.passwordConfigured = passwordConfigured;
    sanitized.musicPlayer = musicPlayer;

    // WebDAV internal token 不下发到前端
    if (sanitized.webDAV) {
        delete sanitized.webDAV.internalToken;
        delete sanitized.webDAV.internalTokenId;
    }

    return sanitized;
}

export async function onRequest(context) {
    // 其他设置相关，GET方法读取设置，POST方法保存设置
    const {
      request, // same as existing Worker API
      env, // same as existing Worker API
      params, // if filename includes [id] or [[path]]
      waitUntil, // same as ctx.waitUntil in existing Worker API
      next, // used for middleware or to fetch assets
      data, // arbitrary space for passing data between middlewares
    } = context;

    const db = getDatabase(env);

    // GET读取设置
    if (request.method === 'GET') {
        const settings = await getOthersConfig(db, env)

        return new Response(JSON.stringify(sanitizeManagementSettings(settings)), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    // POST保存设置
    if (request.method === 'POST') {
        const settings = await getOthersConfig(db, env)
        const body = await request.json()
        const newMusicPlayer = body.musicPlayer || {}
        const oldMusicPlayer = settings.musicPlayer || {}
        const oldPasswordHash = settings.musicPlayer?.passwordHash
        const oldWebDAV = settings.webDAV || {}
        let musicPasswordChanged = false

        Object.assign(settings, body)

        // WebDAV internal token 管理：token 不经前端往返，从旧配置继承并按开关维护生命周期
        settings.webDAV = {
            ...(body.webDAV || {}),
            internalToken: oldWebDAV.internalToken || '',
            internalTokenId: oldWebDAV.internalTokenId || '',
        }
        if (settings.webDAV.enabled && !settings.webDAV.internalToken) {
            // 启用 WebDAV 且没有 token，创建一个 internal 类型的 API Token
            const tokenResult = await createApiToken(
                db,
                'WebDAV Internal Token',
                ['list', 'upload', 'delete'],
                'system',
                null,   // 不过期
                false,  // 不自动删除
                'internal'
            )
            settings.webDAV.internalToken = tokenResult.token
            settings.webDAV.internalTokenId = tokenResult.id
        } else if (!settings.webDAV.enabled && oldWebDAV.internalTokenId) {
            // 禁用 WebDAV，删除 internal token
            await deleteApiToken(db, oldWebDAV.internalTokenId)
            settings.webDAV.internalToken = ''
            settings.webDAV.internalTokenId = ''
        }
        settings.musicPlayer = {
            ...oldMusicPlayer,
            ...newMusicPlayer,
        }

        delete settings.musicPlayer.password
        delete settings.musicPlayer.clearPassword
        delete settings.musicPlayer.passwordConfigured

        if (newMusicPlayer.clearPassword === true) {
            delete settings.musicPlayer.passwordHash
            musicPasswordChanged = true
        } else if (typeof newMusicPlayer.password === 'string' && newMusicPlayer.password !== '') {
            settings.musicPlayer.passwordHash = await hashPassword(newMusicPlayer.password)
            musicPasswordChanged = true
        } else if (oldPasswordHash) {
            settings.musicPlayer.passwordHash = oldPasswordHash
        } else {
            delete settings.musicPlayer.passwordHash
        }

        // 写入数据库
        await db.put('manage@sysConfig@others', JSON.stringify(settings))

        if (musicPasswordChanged) {
            await destroySessionsByAuthType(env, 'music')
        }

        return new Response(JSON.stringify(sanitizeManagementSettings(settings)), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

}

export async function getOthersConfig(db, env) {
    const settings = {}
    // 读取数据库中的设置
    const settingsStr = await db.get('manage@sysConfig@others')
    const settingsKV = settingsStr ? JSON.parse(settingsStr) : {}

    // 随机图API
    const kvRandomImageAPI = settingsKV.randomImageAPI || {}
    settings.randomImageAPI = {
        enabled: kvRandomImageAPI.enabled ?? env.AllowRandom === 'true',
        allowedDir: kvRandomImageAPI.allowedDir ?? '',
        fixed: false,
    }

    // CloudFlare API Token
    const kvCloudflareApiToken = settingsKV.cloudflareApiToken || {}
    settings.cloudflareApiToken = {
        CF_ZONE_ID: kvCloudflareApiToken.CF_ZONE_ID || env.CF_ZONE_ID,
        CF_EMAIL: kvCloudflareApiToken.CF_EMAIL || env.CF_EMAIL,
        CF_API_KEY: kvCloudflareApiToken.CF_API_KEY || env.CF_API_KEY,
        fixed: false,
    }

    // WebDAV
    const kvWebDAV = settingsKV.webDAV || {}
    settings.webDAV = {
        enabled: kvWebDAV.enabled ?? false,
        username: kvWebDAV.username || '',
        password: kvWebDAV.password || '',
        uploadChannel: kvWebDAV.uploadChannel || '',
        channelName: kvWebDAV.channelName || '',
        internalToken: kvWebDAV.internalToken || '',
        internalTokenId: kvWebDAV.internalTokenId || '',
        fixed: false,
    }

    // 公开浏览
    const kvPublicBrowse = settingsKV.publicBrowse || {}
    settings.publicBrowse = {
        enabled: kvPublicBrowse.enabled ?? false,
        allowedDir: kvPublicBrowse.allowedDir || '',
        fixed: false,
    }

    // 首页统计图显示
    const kvShowStats = settingsKV.showStats || {}
    settings.showStats = {
        enabled: kvShowStats.enabled ?? true,
        fixed: false,
    }

    // Chat 页面
    const kvChatPage = settingsKV.chatPage || {}
    settings.chatPage = {
        enabled: kvChatPage.enabled ?? false,
        fixed: false,
    }

    // 音乐播放器
    const kvMusicPlayer = settingsKV.musicPlayer || {}
    settings.musicPlayer = {
        enabled: kvMusicPlayer.enabled ?? false,
        musicDir: kvMusicPlayer.musicDir || '',
        passwordHash: kvMusicPlayer.passwordHash || '',
        fixed: false,
    }

    // 视频播放器
    const kvVideoPlayer = settingsKV.videoPlayer || {}
    settings.videoPlayer = {
        enabled: kvVideoPlayer.enabled ?? false,
        videoDir: kvVideoPlayer.videoDir || '',
        fixed: false,
    }

    return settings;
}
