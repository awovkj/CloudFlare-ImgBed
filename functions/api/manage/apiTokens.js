import { getDatabase } from '../../utils/databaseAdapter.js';
import { filterAutoDeleteTokens } from '../../utils/tokenExpiration.js';

// 安全配置（含 API Token）的写入串行化。
// KV 无原子 CAS，跨隔离实例的读-改-写竞态需 Durable Objects 才能彻底解决；
// 此处将同一隔离实例内对 security 配置的读改写排队，消除最常见的
// 并发场景（管理界面连续创建/删除 Token）导致的写丢失。
let securityConfigWriteChain = Promise.resolve();

function withSecurityConfigLock(task) {
    const run = securityConfigWriteChain.then(task, task);
    // 保证链不因单次任务失败而中断
    securityConfigWriteChain = run.then(() => undefined, () => undefined);
    return run;
}

export async function onRequest(context) {
    // API Token管理，支持创建、删除、列出Token
    const {
      request,
      env
    } = context;

    const db = getDatabase(env);
    const url = new URL(request.url)
    const method = request.method

    // GET - 获取所有Token列表
    if (method === 'GET') {
        const tokens = await getApiTokens(db)
        return new Response(JSON.stringify(tokens), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    // POST - 创建新Token
    if (method === 'POST') {
        const body = await request.json()
        const { name, permissions, owner, expiresAt = null, autoDelete = false } = body

        if (!name || !permissions || !owner) {
            return new Response(JSON.stringify({ error: '缺少必要参数' }), {
                status: 400,
                headers: {
                    'content-type': 'application/json',
                },
            })
        }

        const token = await createApiToken(db, name, permissions, owner, expiresAt, autoDelete)
        return new Response(JSON.stringify(token), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    // DELETE - 删除Token
    if (method === 'DELETE') {
        const tokenId = url.searchParams.get('id')
        
        if (!tokenId) {
            return new Response(JSON.stringify({ error: '缺少Token ID' }), {
                status: 400,
                headers: {
                    'content-type': 'application/json',
                },
            })
        }

        const result = await deleteApiToken(db, tokenId)
        return new Response(JSON.stringify(result), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    // PUT - 更新Token权限
    if (method === 'PUT') {
        const body = await request.json()
        const { tokenId, permissions, expiresAt = null, autoDelete = false } = body

        if (!tokenId || !permissions) {
            return new Response(JSON.stringify({ error: '缺少必要参数' }), {
                status: 400,
                headers: {
                    'content-type': 'application/json',
                },
            })
        }

        const result = await updateApiToken(db, tokenId, permissions, expiresAt, autoDelete)
        return new Response(JSON.stringify(result), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    return new Response('Method not allowed', { status: 405 })
}

// 获取所有API Token
async function getApiTokens(db) {
    const settingsStr = await db.get('manage@sysConfig@security')
    const settings = settingsStr ? JSON.parse(settingsStr) : {}
    const tokens = settings.apiTokens?.tokens || {}
    
    // 返回时不包含实际token值，只返回基本信息
    const tokenArray = Object.keys(tokens).map(id => {
        const token = tokens[id]
        return {
            id,
            name: token.name,
            owner: token.owner,
            permissions: token.permissions,
            createdAt: token.createdAt,
            updatedAt: token.updatedAt,
            token: token.token,
            expiresAt: token.expiresAt ?? null,
            autoDelete: token.autoDelete ?? false
        }
    })

    const { toDelete, toKeep } = filterAutoDeleteTokens(tokenArray)
    if (toDelete.length > 0) {
        await withSecurityConfigLock(async () => {
            // 锁内重新读取，避免覆盖并发写入
            const freshStr = await db.get('manage@sysConfig@security')
            const fresh = freshStr ? JSON.parse(freshStr) : {}
            if (fresh.apiTokens?.tokens) {
                for (const token of toDelete) {
                    delete fresh.apiTokens.tokens[token.id]
                }
                await db.put('manage@sysConfig@security', JSON.stringify(fresh))
            }
        })
    }

    const tokenList = toKeep.map(token => ({
        id: token.id,
        name: token.name,
        owner: token.owner,
        permissions: token.permissions,
        createdAt: token.createdAt,
        updatedAt: token.updatedAt,
        token: token.token.substr(0, 15) + '...',
        expiresAt: token.expiresAt,
        autoDelete: token.autoDelete
    }))

    return { tokens: tokenList }
}

export async function createApiToken(db, name, permissions, owner, expiresAt = null, autoDelete = false, type = 'user') {
    const tokenId = generateTokenId()
    const token = generateApiToken()
    const now = new Date().toISOString()

    const tokenData = {
        id: tokenId,
        name,
        token,
        owner,
        permissions,
        createdAt: now,
        updatedAt: now,
        expiresAt: expiresAt ?? null,
        autoDelete: autoDelete === true,
        type
    }

    // 串行化读-改-写，避免并发创建互相覆盖
    await withSecurityConfigLock(async () => {
        const settingsStr = await db.get('manage@sysConfig@security')
        const settings = settingsStr ? JSON.parse(settingsStr) : {}
        if (!settings.apiTokens) {
            settings.apiTokens = { tokens: {} }
        }
        settings.apiTokens.tokens[tokenId] = tokenData
        await db.put('manage@sysConfig@security', JSON.stringify(settings))
    })

    return {
        id: tokenId,
        name,
        token,
        owner,
        permissions,
        createdAt: now,
        updatedAt: now,
        expiresAt: tokenData.expiresAt,
        autoDelete: tokenData.autoDelete,
        type: tokenData.type
    }
}

// 删除API Token
async function deleteApiToken(db, tokenId) {
    return await withSecurityConfigLock(async () => {
        const settingsStr = await db.get('manage@sysConfig@security')
        const settings = settingsStr ? JSON.parse(settingsStr) : {}

        if (!settings.apiTokens?.tokens?.[tokenId]) {
            return { error: 'Token 不存在' }
        }

        delete settings.apiTokens.tokens[tokenId]

        // 保存到数据库
        await db.put('manage@sysConfig@security', JSON.stringify(settings))

        return { success: true, message: 'Token 已删除' }
    })
}

async function updateApiToken(db, tokenId, permissions, expiresAt = null, autoDelete = false) {
    return await withSecurityConfigLock(async () => {
        const settingsStr = await db.get('manage@sysConfig@security')
        const settings = settingsStr ? JSON.parse(settingsStr) : {}

        if (!settings.apiTokens?.tokens?.[tokenId]) {
            return { error: 'Token 不存在' }
        }

        settings.apiTokens.tokens[tokenId].permissions = permissions
        settings.apiTokens.tokens[tokenId].updatedAt = new Date().toISOString()
        settings.apiTokens.tokens[tokenId].expiresAt = expiresAt ?? null
        settings.apiTokens.tokens[tokenId].autoDelete = autoDelete === true

        // 保存到数据库
        await db.put('manage@sysConfig@security', JSON.stringify(settings))

        return {
            success: true,
            message: 'Token 权限已更新',
            token: settings.apiTokens.tokens[tokenId]
        }
    })
}

// 生成随机Token（使用 CSPRNG，Math.random 可预测、不能用于凭据）
function generateApiToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const randomValues = new Uint8Array(32)
    crypto.getRandomValues(randomValues)
    let result = 'imgbed_'
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(randomValues[i] % chars.length)
    }
    return result
}

// 生成Token ID
function generateTokenId() {
    const randomValues = new Uint8Array(8)
    crypto.getRandomValues(randomValues)
    const randomPart = Array.from(randomValues, b => b.toString(36)).join('').substring(0, 10)
    return Date.now().toString(36) + randomPart
}

export async function getTokenData(db, token) {
    const settingsStr = await db.get('manage@sysConfig@security')
    const settings = settingsStr ? JSON.parse(settingsStr) : {}
    const tokens = settings.apiTokens?.tokens || {}

    for (const tokenId in tokens) {
        if (tokens[tokenId].token === token) {
            const item = tokens[tokenId]
            return {
                id: item.id,
                name: item.name,
                token: item.token,
                owner: item.owner,
                permissions: item.permissions,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                expiresAt: item.expiresAt ?? null,
                autoDelete: item.autoDelete ?? false
            }
        }
    }

    return null
}
