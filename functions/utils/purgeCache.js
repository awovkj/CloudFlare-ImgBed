import { fetchOthersConfig } from "./sysConfig.js";

// 优化：
// 1. 移除模块级 let 变量，避免同一 isolate 处理多个请求时数据泄漏
// 2. purgeCFCache 改为接收或读取配置后全部局部变量，无跨请求污染
// 3. 缓存清理操作改为 Promise.all 并行执行

export async function purgeCFCache(env, cdnUrl) {
    // 读取配置（全部使用局部变量，避免跨请求数据泄漏）
    const othersConfig = await fetchOthersConfig(env);
    const cfZoneId = othersConfig.cloudflareApiToken.CF_ZONE_ID;
    const cfEmail = othersConfig.cloudflareApiToken.CF_EMAIL;
    const cfApiKey = othersConfig.cloudflareApiToken.CF_API_KEY;

    if (!cfZoneId || !cfApiKey) return; // 未配置则跳过

    // 清除CDN缓存
    await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/purge_cache`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Auth-Email': cfEmail,
            'X-Auth-Key': cfApiKey,
        },
        body: JSON.stringify({ files: [cdnUrl] }),
    });
}

export async function purgeRandomFileListCache(origin, ...dirs) {
    try {
        const cache = caches.default;
        // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
        // 优化：并行清理所有目录缓存
        await Promise.all(dirs.map(dir =>
            cache.put(
                `${origin}/api/randomFileList?dir=${dir}`,
                new Response(null, { headers: { 'Cache-Control': 'max-age=0' } })
            )
        ));
    } catch (error) {
        console.error('Failed to clear randomFileList cache:', error);
    }
}

export async function purgePublicFileListCache(origin, ...dirs) {
    try {
        const cache = caches.default;
        // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
        // 优化：并行清理所有目录的递归和非递归缓存
        const promises = [];
        for (const dir of dirs) {
            promises.push(
                cache.put(
                    `${origin}/api/publicFileList?dir=${dir}&recursive=false`,
                    new Response(null, { headers: { 'Cache-Control': 'max-age=0' } })
                ),
                cache.put(
                    `${origin}/api/publicFileList?dir=${dir}&recursive=true`,
                    new Response(null, { headers: { 'Cache-Control': 'max-age=0' } })
                )
            );
        }
        await Promise.all(promises);
    } catch (error) {
        console.error('Failed to clear publicFileList cache:', error);
    }
}
