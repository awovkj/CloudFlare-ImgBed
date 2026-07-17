// ── Durable Object re-export（Wrangler 要求入口文件导出 DO 类）─────────────────
export { UploadDurableObject } from './uploadDurableObject.js';

// ── 业务模块导入（直接复用 functions/ 目录，路径相对于本文件）──────────────────

// upload
import { onRequest as onUploadRequest }        from '../functions/upload/index.js';
import { onRequest as onChunkStatusRequest }    from '../functions/upload/chunkStatus.js';
import {
    createRouteUploadIdMismatchResponse,
    dispatchUploadToDurableObject,
    extractUploadId,
    isRouteUploadIdMismatchError,
    resolveUploadDurableObject,
} from './uploadRequestRouting.js';
// chunkUpload.js / chunkMerge.js 是工具函数库，无 onRequest，
// 已被 upload/index.js 内部调用，不在此单独注册路由。
import { checkDatabaseConfig } from '../functions/utils/middleware.js';

// file
import { onRequest as onFileRequest }           from '../functions/file/[[path]].js';

// api 顶层
// login.js / huggingface/*.js 只导出 onRequestPost（Pages Functions HTTP 方法约定）
import { onRequestPost as onLoginPost }         from '../functions/api/login.js';
import { matchGeneratedAuthRoute }              from './generatedAuthRoutes.js';
import { onRequest as onUserConfigRequest }     from '../functions/api/userConfig.js';
import { onRequest as onChannelsRequest }       from '../functions/api/channels.js';
import { onRequest as onFetchResRequest }       from '../functions/api/fetchRes.js';
import { onRequest as onPublicListRequest }     from '../functions/api/public/list.js';
import { onRequest as onBingWallpaperRequest }  from '../functions/api/bing/wallpaper/index.js';
import { onRequestPost as onHfGetUploadUrlPost }from '../functions/api/huggingface/getUploadUrl.js';
import { onRequestPost as onHfCommitPost }      from '../functions/api/huggingface/commitUpload.js';
import { onRequestPost as onUploadHfGetUploadUrlPost } from '../functions/upload/huggingface/getUploadUrl.js';
import { onRequestPost as onUploadHfCommitPost } from '../functions/upload/huggingface/commitUpload.js';
import { onRequestPost as onUploadHfCompleteMultipartPost } from '../functions/upload/huggingface/completeMultipart.js';
import { onRequestGet as onDirectoryTreeGet }    from '../functions/api/directoryTree.js';

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
import { onRequest as onManageCusConfigFiles }     from '../functions/api/manage/cusConfig/files.js';
import { onRequest as onManageBatchList }          from '../functions/api/manage/batch/list.js';
import { onRequest as onManageBatchSettings }      from '../functions/api/manage/batch/settings.js';
import { onRequest as onManageBatchIndexChunk }    from '../functions/api/manage/batch/index/chunk.js';
import { onRequest as onManageBatchIndexConfig }   from '../functions/api/manage/batch/index/config.js';
import { onRequest as onManageBatchIndexFinalize } from '../functions/api/manage/batch/index/finalize.js';
import { onRequest as onManageBatchRestoreChunk }  from '../functions/api/manage/batch/restore/chunk.js';

// music
import { onRequest as onMusicListRequest }         from '../functions/api/music/list.js';
import { onRequestPost as onMusicLoginPost }       from '../functions/api/music/login.js';
import { onRequestPost as onMusicLogoutPost }      from '../functions/api/music/logout.js';
import { onRequestGet as onMusicSessionGet }       from '../functions/api/music/session.js';
import { onRequest as onMusicPageRequest }          from '../functions/music/index.js';

// video
import { onRequest as onVideoListRequest }         from '../functions/api/video/list.js';

// chat
import { onRequest as onChatPageRequest }          from '../functions/chat/index.js';
import { onRequest as onChatConfigRequest }        from '../functions/api/chat/config.js';
import { onRequest as onChatSendTextRequest }      from '../functions/api/chat/sendText.js';
import { onRequest as onChatHistoryRequest }       from '../functions/api/chat/history.js';
import { onRequest as onChatClearRequest }         from '../functions/api/chat/clear.js';

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

function getOnly(handler) {
    return async function(context) {
        if (context.request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization, authCode',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }
        if (context.request.method !== 'GET') {
            return new Response('Method Not Allowed', { status: 405 });
        }
        return handler(context);
    };
}

function collectModuleMiddlewares(middlewareModules) {
    const handlers = [];

    for (const mod of middlewareModules ?? []) {
        if (!mod?.onRequest) {
            continue;
        }

        if (Array.isArray(mod.onRequest)) {
            handlers.push(...mod.onRequest);
        } else {
            handlers.push(mod.onRequest);
        }
    }

    return handlers;
}

function resolveModuleHandler(mod, method) {
    const normalizedMethod = method.toUpperCase();
    const methodHandlerName = `onRequest${normalizedMethod.charAt(0)}${normalizedMethod.slice(1).toLowerCase()}`;

    if (typeof mod[methodHandlerName] === 'function') {
        return mod[methodHandlerName];
    }

    if (typeof mod.onRequest === 'function') {
        return mod.onRequest;
    }

    if (Array.isArray(mod.onRequest) && mod.onRequest.length > 0) {
        return mod.onRequest[mod.onRequest.length - 1];
    }

    return null;
}

function collectAllowedMethods(mod) {
    const allowedMethods = [];
    const methodMap = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

    for (const method of methodMap) {
        const handlerName = `onRequest${method.charAt(0)}${method.slice(1).toLowerCase()}`;
        if (typeof mod[handlerName] === 'function') {
            allowedMethods.push(method);
        }
    }

    if (allowedMethods.length === 0 && typeof mod.onRequest === 'function') {
        allowedMethods.push('GET', 'POST', 'PUT', 'PATCH', 'DELETE');
    }

    return allowedMethods;
}

function buildGeneratedOptionsResponse(mod) {
    const allowedMethods = collectAllowedMethods(mod);
    const allowHeaders = new Set(['Content-Type', 'Authorization']);

    if (allowedMethods.includes('GET')) {
        allowHeaders.add('authCode');
    }

    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': [...allowedMethods, 'OPTIONS'].join(', '),
            'Access-Control-Allow-Headers': [...allowHeaders].join(', '),
            'Access-Control-Max-Age': '86400',
        },
    });
}

async function runGeneratedRoute(request, env, ctx, route) {
    if (request.method === 'OPTIONS') {
        return buildGeneratedOptionsResponse(route.module);
    }

    const handler = resolveModuleHandler(route.module, request.method);
    if (!handler) {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const middlewares = collectModuleMiddlewares(route.middlewares);

    if (Array.isArray(route.module.onRequest) && route.module.onRequest.length > 1 && handler === route.module.onRequest[route.module.onRequest.length - 1]) {
        middlewares.push(...route.module.onRequest.slice(0, -1));
    }

    return runMiddlewareChain(request, env, ctx, {}, [...middlewares, handler]);
}

function matchDynamicRoute(pathname) {
    for (const route of DYNAMIC_ROUTES) {
        const match = pathname.match(route.pattern);
        if (match) {
            return {
                params: route.params(match),
                middlewares: route.middlewares,
            };
        }
    }

    return null;
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

    let stub;
    try {
        const uploadId = await extractUploadId(request);

        // 旧客户端把 uploadId 和二进制分片放在同一个 multipart body 中。
        // 不解析/复制大分片，直接交给 Worker 保持兼容。
        stub = resolveUploadDurableObject(env.UPLOAD_DO, request, uploadId);
    } catch (error) {
        if (isRouteUploadIdMismatchError(error)) {
            return createRouteUploadIdMismatchResponse(error);
        }
        // 仅 dispatch 前的解析/namespace 错误可安全回退，原始 body 尚未发送。
        console.error('[worker] DO routing failed, falling back to Worker:', error.message);
        return onUploadRequest(context);
    }

    if (!stub) {
        return onUploadRequest(context);
    }

    // 一旦向 DO 发起 fetch，请求 body 可能已被消费，失败时绝不再次本地执行。
    return dispatchUploadToDurableObject(stub, request);
}
// ── 路由表 ────────────────────────────────────────────────────────────────────
//
// 优化：二级路由查找
//   1. STATIC_ROUTES (Map)：精确匹配的静态路径 → O(1) 查找
//   2. DYNAMIC_ROUTES (Array)：含参数捕获的动态路径 → 线性正则匹配（仅 ~10 条）
//
// 收益：40+ 条路由中 ~30 条为精确匹配，直接 Map 命中，避免逐条正则扫描。
// Workers 冷启动时 Map 查找比遍历 40 条正则快约 10 倍。

// /upload 路由中间件链
const uploadMiddleware = [checkDatabaseConfig, forwardToUploadDO];

// /api/manage 路由中间件链
function apiManageChain(handler) {
    return [...(Array.isArray(onManageMiddleware) ? onManageMiddleware : [onManageMiddleware]), handler];
}

// /file 路由中间件链
const fileMiddleware = [checkDatabaseConfig, onFileRequest];

// /dav 路由中间件链
const davMiddleware = [checkDatabaseConfig, onDavRequest];

// /random 路由中间件链
const randomMiddleware = [checkDatabaseConfig, onRandomRequest];

// ── 精确匹配的静态路由（Map O(1) 查找）──────────────────────────────────────
const STATIC_ROUTES = new Map([
    // /api/manage 子路由
    ['/api/manage/login',                  apiManageChain(onManageLoginRequest)],
    ['/api/manage/logout',                 apiManageChain(onManageLogoutRequest)],
    ['/api/manage/stats',                  apiManageChain(onManageStatsRequest)],
    ['/api/manage/quota',                  apiManageChain(onManageQuotaRequest)],
    ['/api/manage/check',                  apiManageChain(onManageCheckRequest)],
    ['/api/manage/list',                   apiManageChain(onManageListRequest)],
    ['/api/manage/apiTokens',              apiManageChain(onManageApiTokens)],
    ['/api/manage/tags/autocomplete',      apiManageChain(onManageTagsAutoRequest)],
    ['/api/manage/tags/batch',             apiManageChain(onManageTagsBatchRequest)],
    ['/api/manage/sysConfig/security',     apiManageChain(onManageSysConfigSecurity)],
    ['/api/manage/sysConfig/upload',       apiManageChain(onManageSysConfigUpload)],
    ['/api/manage/sysConfig/others',       apiManageChain(onManageSysConfigOthers)],
    ['/api/manage/sysConfig/page',         apiManageChain(onManageSysConfigPage)],
    ['/api/manage/sysConfig/showStats',    apiManageChain(onManageSysConfigShowStats)],
    ['/api/manage/cusConfig/list',         apiManageChain(onManageCusConfigList)],
    ['/api/manage/cusConfig/blockip',      apiManageChain(onManageCusConfigBlockIp)],
    ['/api/manage/cusConfig/blockipList',  apiManageChain(onManageCusConfigBlockIpList)],
    ['/api/manage/cusConfig/whiteip',      apiManageChain(onManageCusConfigWhiteIp)],
    ['/api/manage/cusConfig/files',        apiManageChain(onManageCusConfigFiles)],
    ['/api/manage/batch/list',             apiManageChain(onManageBatchList)],
    ['/api/manage/batch/settings',         apiManageChain(onManageBatchSettings)],
    ['/api/manage/batch/index/chunk',      apiManageChain(onManageBatchIndexChunk)],
    ['/api/manage/batch/index/config',     apiManageChain(onManageBatchIndexConfig)],
    ['/api/manage/batch/index/finalize',   apiManageChain(onManageBatchIndexFinalize)],
    ['/api/manage/batch/restore/chunk',    apiManageChain(onManageBatchRestoreChunk)],
    // /api 顶层路由
    ['/api/login',                         [checkDatabaseConfig, postOnly(onLoginPost)]],
    ['/api/userConfig',                    [checkDatabaseConfig, onUserConfigRequest]],
    ['/api/channels',                      [checkDatabaseConfig, onChannelsRequest]],
    ['/api/fetchRes',                      [checkDatabaseConfig, onFetchResRequest]],
    ['/api/public/list',                   [checkDatabaseConfig, onPublicListRequest]],
    ['/api/music/list',                    [checkDatabaseConfig, onMusicListRequest]],
    ['/api/music/login',                   [checkDatabaseConfig, postOnly(onMusicLoginPost)]],
    ['/api/music/logout',                  [checkDatabaseConfig, postOnly(onMusicLogoutPost)]],
    ['/api/music/session',                 [checkDatabaseConfig, getOnly(onMusicSessionGet)]],
    ['/music',                             [checkDatabaseConfig, onMusicPageRequest]],
    ['/music/',                            [checkDatabaseConfig, onMusicPageRequest]],
    ['/music.html',                        [checkDatabaseConfig, onMusicPageRequest]],
    ['/api/video/list',                    [checkDatabaseConfig, onVideoListRequest]],
    ['/chat',                              [checkDatabaseConfig, onChatPageRequest]],
    ['/chat/',                             [checkDatabaseConfig, onChatPageRequest]],
    ['/chat.html',                         [checkDatabaseConfig, onChatPageRequest]],
    ['/api/chat/config',                   [checkDatabaseConfig, onChatConfigRequest]],
    ['/api/chat/sendText',                 [checkDatabaseConfig, onChatSendTextRequest]],
    ['/api/chat/history',                  [checkDatabaseConfig, onChatHistoryRequest]],
    ['/api/chat/clear',                    [checkDatabaseConfig, onChatClearRequest]],
    ['/api/bing/wallpaper',                [checkDatabaseConfig, onBingWallpaperRequest]],
    ['/api/huggingface/getUploadUrl',      [checkDatabaseConfig, postOnly(onHfGetUploadUrlPost)]],
    ['/api/huggingface/commitUpload',      [checkDatabaseConfig, postOnly(onHfCommitPost)]],
    ['/upload/huggingface/getUploadUrl',   [checkDatabaseConfig, postOnly(onUploadHfGetUploadUrlPost)]],
    ['/upload/huggingface/commitUpload',    [checkDatabaseConfig, postOnly(onUploadHfCommitPost)]],
    ['/upload/huggingface/completeMultipart', [checkDatabaseConfig, postOnly(onUploadHfCompleteMultipartPost)]],
    ['/api/directoryTree',                 [checkDatabaseConfig, getOnly(onDirectoryTreeGet)]],
    ['/api/site/storage-overview',         [checkDatabaseConfig, getOnly(onManageStatsRequest)]],
    ['/api/site/storage-panel',            [checkDatabaseConfig, getOnly(onManageSysConfigShowStats)]],
    ['/upload/chunkStatus',                [checkDatabaseConfig, onChunkStatusRequest]],
]);

// ── 动态路由（需要正则参数提取，仅 ~10 条）──────────────────────────────────
const DYNAMIC_ROUTES = [
    { pattern: /^\/upload(\/.*)?$/,               params: () => ({}),                          middlewares: uploadMiddleware },
    { pattern: /^\/file\/(.+)$/,                  params: (m) => ({ path: m[1] }),              middlewares: fileMiddleware },
    { pattern: /^\/random(\/.*)?$/,               params: () => ({}),                          middlewares: randomMiddleware },
    { pattern: /^\/dav(\/.*)?$/,                  params: (m) => ({ path: m[1]?.slice(1) ?? '' }), middlewares: davMiddleware },
    // 动态 manage 路由（含 path 参数）
    { pattern: /^\/api\/manage\/delete\/(.+)$/,   params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageDeleteRequest) },
    { pattern: /^\/api\/manage\/block\/(.+)$/,    params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageBlockRequest) },
    { pattern: /^\/api\/manage\/white\/(.+)$/,    params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageWhiteRequest) },
    { pattern: /^\/api\/manage\/metadata\/(.+)$/, params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageMetadataRequest) },
    { pattern: /^\/api\/manage\/move\/(.+)$/,     params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageMoveRequest) },
    { pattern: /^\/api\/manage\/rename\/(.+)$/,   params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageRenameRequest) },
    { pattern: /^\/api\/manage\/tags\/(.+)$/,     params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageTagsRequest) },
];

// ── Worker 主入口 ─────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        try {
            // 第一层：精确匹配 O(1)（覆盖 ~75% 的路由）
            const staticMiddlewares = STATIC_ROUTES.get(pathname);
            if (staticMiddlewares) {
                return await runMiddlewareChain(request, env, ctx, {}, staticMiddlewares);
            }

            // 第二层：动态路由正则匹配（仅 ~10 条）
            const dynamicRoute = matchDynamicRoute(pathname);
            if (dynamicRoute) {
                return await runMiddlewareChain(request, env, ctx, dynamicRoute.params, dynamicRoute.middlewares);
            }

            const generatedAuthRoute = matchGeneratedAuthRoute(pathname);
            if (generatedAuthRoute) {
                return await runGeneratedRoute(request, env, ctx, generatedAuthRoute);
            }
        } catch (err) {
            console.error(`[worker] Error handling ${pathname}:`, err);
            return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
        }

        // 未匹配路由 → 静态资源
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    },
};
