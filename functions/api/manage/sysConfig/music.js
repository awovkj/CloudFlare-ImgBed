import { getDatabase } from '../../../utils/databaseAdapter.js';

export async function onRequest(context) {
    const { request, env } = context;
    const db = getDatabase(env);

    // GET 读取音乐配置
    if (request.method === 'GET') {
        const settings = await getMusicConfig(db, env);
        return new Response(JSON.stringify(settings), {
            headers: { 'content-type': 'application/json' },
        });
    }

    // POST 保存音乐配置
    if (request.method === 'POST') {
        const body = await request.json();
        await db.put('manage@sysConfig@music', JSON.stringify(body));
        return new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
        });
    }
}

export async function getMusicConfig(db, env) {
    const settingsStr = await db.get('manage@sysConfig@music');
    const settingsKV = settingsStr ? JSON.parse(settingsStr) : {};

    return {
        enabled: settingsKV.enabled ?? false,
        musicDir: settingsKV.musicDir || '',
    };
}
