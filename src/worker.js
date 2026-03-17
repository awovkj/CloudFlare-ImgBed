// ── Durable Object re-export（Wrangler 要求入口文件导出 DO 类）─────────────────
export { UploadDurableObject } from './uploadDurableObject.js';

// ── 业务模块导入（直接复用 functions/ 目录，路径相对于本文件）──────────────────

// upload
import { onRequest as onUploadRequest }        from '../functions/upload/index.js';
// chunkUpload.js / chunkMerge.js 是工具函数库，无 onRequest，
// 已被 upload/index.js 内部调用，不在此单独注册路由。
import { errorHandling, telemetryData, checkDatabaseConfig } from '../functions/utils/middleware.js';

// file
import { onRequest as onFileRequest }           from '../functions/file/[[path]].js';

// api 顶层
// login.js / huggingface/*.js 只导出 onRequestPost（Pages Functions HTTP 方法约定）
import { onRequestPost as onLoginPost }         from '../functions/api/login.js';
import { onRequest as onUserConfigRequest }     from '../functions/api/userConfig.js';
import { onRequest as onChannelsRequest }       from '../functions/api/channels.js';
import { onRequest as onFetchResRequest }       from '../functions/api/fetchRes.js';
import { onRequest as onPublicListRequest }     from '../functions/api/public/list.js';
import { onRequest as onBingWallpaperRequest }  from '../functions/api/bing/wallpaper/index.js';
import { onRequestPost as onHfGetUploadUrlPost }from '../functions/api/huggingface/getUploadUrl.js';
import { onRequestPost as onHfCommitPost }      from '../functions/api/huggingface/commitUpload.js';

// api/manage — 子路由
import { onRequest as onManageMiddleware }     from '../functions/api/manage/_middleware.js';
import { onRequest as onManageLoginRequest }   from '../functions/api/manage/login.js';
import { onRequest as onManageLogoutRequest }  from '../functions/api/manage/logout.js';
import { onRequest as onManageListRequest }    from '../functions/api/manage/list.js';
import { onRequest as onManageStatsRequest }   from '../functions/api/manage/stats.js';
import { onRequest as onManageQuotaRequest }   from '../functions/api/manage/quota.js';
import { onRequest as onManageCheckRequest }   from '../functions/api/manage/check.js';
import { onRequest as onManageApiTokens }      from '../functions/api/manage/apiTokens.js';
import { onRequest as onManageDeleteRequest }  from '../functions/api/manage/delete/[[path]].js';
import { onRequest as onManageBlockRequest }   from '../functions/api/manage/block/[[path]].js';
import { onRequest as onManageWhiteRequest }   from '../functions/api/manage/white/[[path]].js';
import { onRequest as onManageMetadataRequest }from '../functions/api/manage/metadata/[[path]].js';
import { onRequest as onManageMoveRequest }    from '../functions/api/manage/move/[[path]].js';
import { onRequest as onManageRenameRequest }  from '../functions/api/manage/rename/[[path]].js';
import { onRequest as onManageTagsRequest }    from '../functions/api/manage/tags/[[path]].js';
import { onRequest as onManageTagsAutoRequest }from '../functions/api/manage/tags/autocomplete.js';
import { onRequest as onManageTagsBatchRequest}from '../functions/api/manage/tags/batch.js';
import { onRequest as onManageSysConfigSecurity } from '../functions/api/manage/sysConfig/security.js';
import { onRequest as onManageSysConfigUpload }   from '../functions/api/manage/sysConfig/upload.js';
import { onRequest as onManageSysConfigOthers }   from '../functions/api/manage/sysConfig/others.js';
import { onRequest as onManageSysConfigPage }     from '../functions/api/manage/sysConfig/page.js';
import { onRequest as onManageSysConfigShowStats } from '../functions/api/manage/sysConfig/showStats.js';
import { onRequest as onManageCusConfigList }      from '../functions/api/manage/cusConfig/list.js';
import { onRequest as onManageCusConfigBlockIp }   from '../functions/api/manage/cusConfig/blockip.js';
import { onRequest as onManageCusConfigBlockIpList}from '../functions/api/manage/cusConfig/blockipList.js';
import { onRequest as onManageCusConfigWhiteIp }   from '../functions/api/manage/cusConfig/whiteip.js';
import { onRequest as onManageBatchList }          from '../functions/api/manage/batch/list.js';
import { onRequest as onManageBatchSettings }      from '../functions/api/manage/batch/settings.js';
import { onRequest as onManageBatchIndexChunk }    from '../functions/api/manage/batch/index/chunk.js';
import { onRequest as onManageBatchIndexConfig }   from '../functions/api/manage/batch/index/config.js';
import { onRequest as onManageBatchIndexFinalize } from '../functions/api/manage/batch/index/finalize.js';
import { onRequest as onManageBatchRestoreChunk }  from '../functions/api/manage/batch/restore/chunk.js';

// music
import { onRequest as onMusicListRequest }         from '../functions/api/music/list.js';

// random
import { onRequest as onRandomRequest }        from '../functions/random/index.js';

// dav
import { onRequest as onDavRequest }           from '../functions/dav/[[path]].js';

// ── Pages Functions 适配层 ────────────────────────────────────────────────────

/** 构造 Pages Functions context 对象 */
function makeContext(request, env, ctx, params = {}, data = {}, nextFn = null) {
    return {
        request,
        env,
        params,
        data,
        waitUntil: ctx.waitUntil.bind(ctx),
        passThroughOnException: ctx.passThroughOnException?.bind(ctx),
        next: nextFn ?? (() => new Response('Not Found', { status: 404 })),
    };
}

/** 执行 Pages Functions 风格的中间件链 */
async function runMiddlewareChain(request, env, ctx, params, middlewares) {
    const chain = Array.isArray(middlewares) ? middlewares : [middlewares];
    const data = {};
    let index = 0;

    async function dispatch() {
        if (index >= chain.length) {
            return new Response('Not Found', { status: 404 });
        }
        const current = chain[index++];
        const context = makeContext(request, env, ctx, params, data, dispatch);
        return current(context);
    }

    return dispatch();
}

/**
 * 将只导出 onRequestPost 的处理器包装为支持 OPTIONS 预检的通用处理器。
 * Pages Functions 中 onRequestPost 只处理 POST，Workers 里需要手动处理其他方法。
 */
function postOnly(handler) {
    return async function(context) {
        if (context.request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }
        if (context.request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }
        return handler(context);
    };
}
/**
 * 将上传请求转发到 Durable Object 处理。
 * DO 没有实际的 CPU 时间限制（每次 I/O 重置计时器），适合上传这类长任务。
 *
 * fallback 条件（自动退回 Worker 直接处理）：
 *   1. env.UPLOAD_DO 绑定不存在（未部署 DO）
 *   2. env.DISABLE_UPLOAD_DO === 'true'（紧急回滚开关）
 */
async function forwardToUploadDO(context) {
    const { request, env } = context;

    // fallback：绑定不存在 或 手动禁用
    if (!env.UPLOAD_DO || env.DISABLE_UPLOAD_DO === 'true') {
        return onUploadRequest(context);
    }

    try {
        // 每次上传请求分配独立的 DO 实例，最大化并行性
        const id = env.UPLOAD_DO.newUniqueId();
        const stub = env.UPLOAD_DO.get(id);
        return await stub.fetch(request);
    } catch (error) {
        // DO 调用失败，自动 fallback 到 Worker 直接处理
        console.error('[worker] DO forwarding failed, falling back to Worker:', error.message);
        return onUploadRequest(context);
    }
}
// ── 路由表 ────────────────────────────────────────────────────────────────────
//
// 格式：[pattern, params-extractor, middlewares]
//
//  pattern          : 用于匹配 pathname 的正则
//  params-extractor : (match) => object  — 从正则捕获组提取 context.params
//  middlewares      : 函数 or 数组（Pages Functions _middleware + handler）
//
// 注意：顺序即优先级，第一个匹配的路由生效。

// /upload 路由中间件链（对应 functions/upload/_middleware.js + index.js）
// 轻量中间件在 Worker 侧执行，上传逻辑卸载到 Durable Object
const uploadMiddleware = [checkDatabaseConfig, errorHandling, telemetryData, forwardToUploadDO];

// /api/manage 路由中间件链（对应 functions/api/_middleware.js + manage/_middleware.js + handler）
function apiManageChain(handler) {
    // api/_middleware: checkDatabaseConfig
    // api/manage/_middleware: checkDatabaseConfig + errorHandling + authentication
    // handler 本身
    return [...(Array.isArray(onManageMiddleware) ? onManageMiddleware : [onManageMiddleware]), handler];
}

// /file 路由中间件链
const fileMiddleware = [checkDatabaseConfig, onFileRequest];

// /dav 路由中间件链
const davMiddleware = [checkDatabaseConfig, onDavRequest];

// /random 路由中间件链
const randomMiddleware = [checkDatabaseConfig, onRandomRequest];

const ROUTES = [
    // ── /music page ──────────────────────────────────────────────────────────
    {
        pattern: /^\/music\/?$/,
        params: () => ({}),
        middlewares: [async (context) => {
            const url = new URL(context.request.url);
            url.pathname = '/music.html';
            const newReq = new Request(url.toString(), context.request);
            if (context.env.ASSETS) {
                return context.env.ASSETS.fetch(newReq);
            }
            return new Response('Not Found', { status: 404 });
        }],
    },

    // ── /upload ──────────────────────────────────────────────────────────────
    {
        pattern: /^\/upload(\/.*)?$/,
        params: () => ({}),
        middlewares: uploadMiddleware,
    },

    // ── /file/<path> ─────────────────────────────────────────────────────────
    {
        pattern: /^\/file\/(.+)$/,
        params: (m) => ({ path: m[1] }),
        middlewares: fileMiddleware,
    },

    // ── /random ───────────────────────────────────────────────────────────────
    {
        pattern: /^\/random(\/.*)?$/,
        params: () => ({}),
        middlewares: randomMiddleware,
    },

    // ── /dav ─────────────────────────────────────────────────────────────────
    {
        pattern: /^\/dav(\/.*)?$/,
        params: (m) => ({ path: m[1]?.slice(1) ?? '' }),
        middlewares: davMiddleware,
    },

    // ── /api/manage — 具体路由（顺序敏感：长路径在前）───────────────────────
    { pattern: /^\/api\/manage\/login$/,                  params: () => ({}), middlewares: apiManageChain(onManageLoginRequest) },
    { pattern: /^\/api\/manage\/logout$/,                 params: () => ({}), middlewares: apiManageChain(onManageLogoutRequest) },
    { pattern: /^\/api\/manage\/stats$/,                  params: () => ({}), middlewares: apiManageChain(onManageStatsRequest) },
    { pattern: /^\/api\/manage\/quota$/,                  params: () => ({}), middlewares: apiManageChain(onManageQuotaRequest) },
    { pattern: /^\/api\/manage\/check$/,                  params: () => ({}), middlewares: apiManageChain(onManageCheckRequest) },
    { pattern: /^\/api\/manage\/list$/,                   params: () => ({}), middlewares: apiManageChain(onManageListRequest) },
    { pattern: /^\/api\/manage\/apiTokens$/,              params: () => ({}), middlewares: apiManageChain(onManageApiTokens) },
    { pattern: /^\/api\/manage\/delete\/(.*)$/,           params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageDeleteRequest) },
    { pattern: /^\/api\/manage\/block\/(.*)$/,            params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageBlockRequest) },
    { pattern: /^\/api\/manage\/white\/(.*)$/,            params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageWhiteRequest) },
    { pattern: /^\/api\/manage\/metadata\/(.*)$/,         params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageMetadataRequest) },
    { pattern: /^\/api\/manage\/move\/(.*)$/,             params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageMoveRequest) },
    { pattern: /^\/api\/manage\/rename\/(.*)$/,           params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageRenameRequest) },
    { pattern: /^\/api\/manage\/tags\/autocomplete$/,     params: () => ({}), middlewares: apiManageChain(onManageTagsAutoRequest) },
    { pattern: /^\/api\/manage\/tags\/batch$/,            params: () => ({}), middlewares: apiManageChain(onManageTagsBatchRequest) },
    { pattern: /^\/api\/manage\/tags\/(.*)$/,             params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageTagsRequest) },
    { pattern: /^\/api\/manage\/sysConfig\/security$/,    params: () => ({}), middlewares: apiManageChain(onManageSysConfigSecurity) },
    { pattern: /^\/api\/manage\/sysConfig\/upload$/,      params: () => ({}), middlewares: apiManageChain(onManageSysConfigUpload) },
    { pattern: /^\/api\/manage\/sysConfig\/others$/,      params: () => ({}), middlewares: apiManageChain(onManageSysConfigOthers) },
    { pattern: /^\/api\/manage\/sysConfig\/page$/,        params: () => ({}), middlewares: apiManageChain(onManageSysConfigPage) },
    { pattern: /^\/api\/manage\/sysConfig\/showStats$/,   params: () => ({}), middlewares: apiManageChain(onManageSysConfigShowStats) },
    { pattern: /^\/api\/manage\/cusConfig\/list$/,        params: () => ({}), middlewares: apiManageChain(onManageCusConfigList) },
    { pattern: /^\/api\/manage\/cusConfig\/blockip$/,     params: () => ({}), middlewares: apiManageChain(onManageCusConfigBlockIp) },
    { pattern: /^\/api\/manage\/cusConfig\/blockipList$/, params: () => ({}), middlewares: apiManageChain(onManageCusConfigBlockIpList) },
    { pattern: /^\/api\/manage\/cusConfig\/whiteip$/,     params: () => ({}), middlewares: apiManageChain(onManageCusConfigWhiteIp) },
    { pattern: /^\/api\/manage\/batch\/list$/,            params: () => ({}), middlewares: apiManageChain(onManageBatchList) },
    { pattern: /^\/api\/manage\/batch\/settings$/,        params: () => ({}), middlewares: apiManageChain(onManageBatchSettings) },
    { pattern: /^\/api\/manage\/batch\/index\/chunk$/,    params: () => ({}), middlewares: apiManageChain(onManageBatchIndexChunk) },
    { pattern: /^\/api\/manage\/batch\/index\/config$/,   params: () => ({}), middlewares: apiManageChain(onManageBatchIndexConfig) },
    { pattern: /^\/api\/manage\/batch\/index\/finalize$/, params: () => ({}), middlewares: apiManageChain(onManageBatchIndexFinalize) },
    { pattern: /^\/api\/manage\/batch\/restore\/chunk$/,  params: () => ({}), middlewares: apiManageChain(onManageBatchRestoreChunk) },

    // ── /api — 顶层路由 ──────────────────────────────────────────────────────
    // login / huggingface 只有 onRequestPost，用 postOnly() 包装
    { pattern: /^\/api\/login$/,                          params: () => ({}), middlewares: [checkDatabaseConfig, postOnly(onLoginPost)] },
    { pattern: /^\/api\/userConfig$/,                     params: () => ({}), middlewares: [checkDatabaseConfig, onUserConfigRequest] },
    { pattern: /^\/api\/channels$/,                       params: () => ({}), middlewares: [checkDatabaseConfig, onChannelsRequest] },
    { pattern: /^\/api\/fetchRes$/,                       params: () => ({}), middlewares: [checkDatabaseConfig, onFetchResRequest] },
    { pattern: /^\/api\/public\/list$/,                   params: () => ({}), middlewares: [checkDatabaseConfig, onPublicListRequest] },
    { pattern: /^\/api\/music\/list$/,                    params: () => ({}), middlewares: [checkDatabaseConfig, onMusicListRequest] },
    { pattern: /^\/api\/bing\/wallpaper$/,                params: () => ({}), middlewares: [checkDatabaseConfig, onBingWallpaperRequest] },
    { pattern: /^\/api\/huggingface\/getUploadUrl$/,      params: () => ({}), middlewares: [checkDatabaseConfig, postOnly(onHfGetUploadUrlPost)] },
    { pattern: /^\/api\/huggingface\/commitUpload$/,      params: () => ({}), middlewares: [checkDatabaseConfig, postOnly(onHfCommitPost)] },
];

// ── Worker 主入口 ─────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // 遍历路由表，找到第一个匹配的规则
        for (const route of ROUTES) {
            const match = pathname.match(route.pattern);
            if (match) {
                const params = route.params(match);
                try {
                    return await runMiddlewareChain(request, env, ctx, params, route.middlewares);
                } catch (err) {
                    console.error(`[worker] Error handling ${pathname}:`, err);
                    return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
                }
            }
        }

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    },
};
