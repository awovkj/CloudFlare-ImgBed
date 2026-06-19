import { getDatabase } from '../../utils/databaseAdapter.js';
import { filterAutoDeleteTokens } from '../../utils/tokenExpiration.js';

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
        for (const token of toDelete) {
            delete settings.apiTokens.tokens[token.id]
        }
        await db.put('manage@sysConfig@security', JSON.stringify(settings))
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
    const settingsStr = await db.get('manage@sysConfig@security')
    const settings = settingsStr ? JSON.parse(settingsStr) : {}
    
    if (!settings.apiTokens) {
        settings.apiTokens = { tokens: {} }
    }
    
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
    
    settings.apiTokens.tokens[tokenId] = tokenData
    
    // 保存到数据库
    await db.put('manage@sysConfig@security', JSON.stringify(settings))
    
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
    const settingsStr = await db.get('manage@sysConfig@security')
    const settings = settingsStr ? JSON.parse(settingsStr) : {}
    
    if (!settings.apiTokens?.tokens?.[tokenId]) {
        return { error: 'Token 不存在' }
    }
    
    delete settings.apiTokens.tokens[tokenId]
    
    // 保存到数据库
    await db.put('manage@sysConfig@security', JSON.stringify(settings))
    
    return { success: true, message: 'Token 已删除' }
}

async function updateApiToken(db, tokenId, permissions, expiresAt = null, autoDelete = false) {
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
}

// 生成随机Token
function generateApiToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = 'imgbed_'
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
}

// 生成Token ID
function generateTokenId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2)
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
