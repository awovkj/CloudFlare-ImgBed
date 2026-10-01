/**
 * 路由表（Workers 形态）
 *
 * 背景：项目已从 Pages Functions 迁到 Workers + Static Assets，路由不再由
 * 文件系统约定推导，而是集中在本文件。此前它内联在 src/worker.js 里，
 * 与适配层、分发逻辑混在一起，导致入口文件 486 行、路由信息散落在
 * import 语句 + Map 字面量 + 数组字面量三处。
 *
 * 本文件的职责：声明「路径 → 中间件链」的映射，并提供匹配函数。
 * 执行逻辑在 src/pagesAdapter.js，入口在 src/worker.js。
 *
 * 新增接口的流程：
 *   1. 在 functions/ 下写 handler（导出 onRequest / onRequestPost）
 *   2. 在本文件 import 并登记到 STATIC_ROUTES 或 DYNAMIC_ROUTES
 *   3. 跑 npm test —— test/route-registration.test.js 会校验「有 handler 但未登记」
 *
 * 关于自动生成：本项目不采用全量自动生成路由。原因是存在无法由文件路径
 * 推导的路由（见下方 ALIAS 注释），以及需要函数式参数提取的动态路由。
 * 取而代之的是全量契约校验（deploy/worker/generate-routes.js --check），
 * 保证「登记表」与「文件系统」不会漂移。
 */

import { checkDatabaseConfig } from '../functions/utils/middleware.js';
import { postOnly, getOnly } from './pagesAdapter.js';
import { forwardToUploadDO } from './uploadDispatcher.js';
import { matchGeneratedAuthRoute } from './generatedAuthRoutes.js';

// ── upload ────────────────────────────────────────────────────────────────────
// 注意：/upload 的 handler 不在此 import —— 它由 src/uploadDispatcher.js 内部
// 引用（forwardToUploadDO 负责决定走 Durable Object 还是 Worker 本地处理），
// 本文件只需挂载 forwardToUploadDO 作为中间件。
import { onRequest as onChunkStatusRequest }    from '../functions/upload/chunkStatus.js';

// ── file / temp ───────────────────────────────────────────────────────────────
import { onRequest as onFileRequest }           from '../functions/file/[[path]].js';
import { onRequest as onTempLinkAccessRequest } from '../functions/temp/[[path]].js';

// ── api 顶层 ──────────────────────────────────────────────────────────────────
// login.js / huggingface/*.js 只导出 onRequestPost（Pages Functions HTTP 方法约定）
import { onRequestPost as onLoginPost }         from '../functions/api/login.js';
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

// ── api/manage ────────────────────────────────────────────────────────────────
import { onRequest as onManageMiddleware }     from '../functions/api/manage/_middleware.js';
import { onRequest as onManageLoginRequest }   from '../functions/api/manage/login.js';
import { onRequest as onManageLogoutRequest }  from '../functions/api/manage/logout.js';
import { onRequest as onManageListRequest }    from '../functions/api/manage/list.js';
import { onRequest as onManageStatsRequest }   from '../functions/api/manage/stats.js';
import { onRequest as onManageQuotaRequest }   from '../functions/api/manage/quota.js';
import { onRequest as onManageCheckRequest }   from '../functions/api/manage/check.js';
import { onRequest as onManageApiTokens }      from '../functions/api/manage/apiTokens.js';
import { onRequest as onManageDeleteRequest }  from '../functions/api/manage/delete/[[path]].js';
import { onRequest as onManageDeleteBatch }     from '../functions/api/manage/delete/batch.js';
import { onRequest as onManageBlockRequest }   from '../functions/api/manage/block/[[path]].js';
import { onRequest as onManageWhiteRequest }   from '../functions/api/manage/white/[[path]].js';
import { onRequest as onManageMetadataRequest }from '../functions/api/manage/metadata/[[path]].js';
import { onRequest as onManageMoveRequest }    from '../functions/api/manage/move/[[path]].js';
import { onRequest as onManageRenameRequest }  from '../functions/api/manage/rename/[[path]].js';
import { onRequest as onManageTagsRequest }    from '../functions/api/manage/tags/[[path]].js';
import { onRequest as onManageTagsAutoRequest }from '../functions/api/manage/tags/autocomplete.js';
import { onRequest as onManageTagsBatchRequest}from '../functions/api/manage/tags/batch.js';
import { onRequest as onManageTempLinkRequest } from '../functions/api/manage/temp-link/[[path]].js';
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

// ── music ─────────────────────────────────────────────────────────────────────
import { onRequest as onMusicListRequest }         from '../functions/api/music/list.js';
import { onRequestPost as onMusicLoginPost }       from '../functions/api/music/login.js';
import { onRequestPost as onMusicLogoutPost }      from '../functions/api/music/logout.js';
import { onRequestGet as onMusicSessionGet }       from '../functions/api/music/session.js';
import { onRequest as onMusicPageRequest }          from '../functions/music/index.js';

// ── video ─────────────────────────────────────────────────────────────────────
import { onRequest as onVideoListRequest }         from '../functions/api/video/list.js';

// ── chat ──────────────────────────────────────────────────────────────────────
import { onRequest as onChatPageRequest }          from '../functions/chat/index.js';
import { onRequest as onChatConfigRequest }        from '../functions/api/chat/config.js';
import { onRequest as onChatSendTextRequest }      from '../functions/api/chat/sendText.js';
import { onRequest as onChatHistoryRequest }       from '../functions/api/chat/history.js';
import { onRequest as onChatClearRequest }         from '../functions/api/chat/clear.js';

// ── random / dav ──────────────────────────────────────────────────────────────
import { onRequest as onRandomRequest }        from '../functions/random/index.js';
import { onRequest as onDavRequest }           from '../functions/dav/[[path]].js';

// ── 中间件链 ──────────────────────────────────────────────────────────────────

// /upload 路由中间件链
const uploadMiddleware = [checkDatabaseConfig, forwardToUploadDO];

// /file 路由中间件链
const fileMiddleware = [checkDatabaseConfig, onFileRequest];

// /temp 路由中间件链（公开临时链接访问端点，无需鉴权）
const tempAccessMiddleware = [checkDatabaseConfig, onTempLinkAccessRequest];

// /dav 路由中间件链
const davMiddleware = [checkDatabaseConfig, onDavRequest];

// /random 路由中间件链
const randomMiddleware = [checkDatabaseConfig, onRandomRequest];

// /api/manage 路由中间件链：manage 中间件自带鉴权（session / Basic / API Token）
function apiManageChain(handler) {
    return [...(Array.isArray(onManageMiddleware) ? onManageMiddleware : [onManageMiddleware]), handler];
}

// ── 精确匹配的静态路由（Map O(1) 查找，覆盖约 75% 的请求）──────────────────────
//
// 鉴权级别说明：
//   apiManageChain(...) → 管理员鉴权（session / Basic / API Token）
//   [checkDatabaseConfig, ...] → 无鉴权，handler 内部自行判定
//
const STATIC_ROUTES = new Map([
    // ── /api/manage 子路由（管理员鉴权）──
    ['/api/manage/login',                  apiManageChain(onManageLoginRequest)],
    ['/api/manage/logout',                 apiManageChain(onManageLogoutRequest)],
    ['/api/manage/stats',                  apiManageChain(onManageStatsRequest)],
    ['/api/manage/quota',                  apiManageChain(onManageQuotaRequest)],
    ['/api/manage/check',                  apiManageChain(onManageCheckRequest)],
    ['/api/manage/list',                   apiManageChain(onManageListRequest)],
    ['/api/manage/delete/batch',           apiManageChain(onManageDeleteBatch)],
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

    // ── /api 顶层（无路由级鉴权，handler 内部判定）──
    ['/api/login',                         [checkDatabaseConfig, postOnly(onLoginPost)]],
    ['/api/userConfig',                    [checkDatabaseConfig, onUserConfigRequest]],
    ['/api/channels',                      [checkDatabaseConfig, onChannelsRequest]],
    ['/api/fetchRes',                      [checkDatabaseConfig, onFetchResRequest]],
    ['/api/public/list',                   [checkDatabaseConfig, onPublicListRequest]],
    ['/api/directoryTree',                 [checkDatabaseConfig, getOnly(onDirectoryTreeGet)]],
    ['/api/bing/wallpaper',                [checkDatabaseConfig, onBingWallpaperRequest]],
    ['/api/huggingface/getUploadUrl',      [checkDatabaseConfig, postOnly(onHfGetUploadUrlPost)]],
    ['/api/huggingface/commitUpload',      [checkDatabaseConfig, postOnly(onHfCommitPost)]],
    ['/upload/huggingface/getUploadUrl',   [checkDatabaseConfig, postOnly(onUploadHfGetUploadUrlPost)]],
    ['/upload/huggingface/commitUpload',    [checkDatabaseConfig, postOnly(onUploadHfCommitPost)]],
    ['/upload/huggingface/completeMultipart', [checkDatabaseConfig, postOnly(onUploadHfCompleteMultipartPost)]],
    ['/upload/chunkStatus',                [checkDatabaseConfig, onChunkStatusRequest]],

    // ── music ──
    ['/api/music/list',                    [checkDatabaseConfig, onMusicListRequest]],
    ['/api/music/login',                   [checkDatabaseConfig, postOnly(onMusicLoginPost)]],
    ['/api/music/logout',                  [checkDatabaseConfig, postOnly(onMusicLogoutPost)]],
    ['/api/music/session',                 [checkDatabaseConfig, getOnly(onMusicSessionGet)]],

    // ALIAS: /music、/music/、/music.html 三条路径指向同一个页面 handler。
    // 无法由文件路径自动推导，因此必须显式登记（这也是不做全量自动生成的原因之一）。
    ['/music',                             [checkDatabaseConfig, onMusicPageRequest]],
    ['/music/',                            [checkDatabaseConfig, onMusicPageRequest]],
    ['/music.html',                        [checkDatabaseConfig, onMusicPageRequest]],

    // ── video ──
    ['/api/video/list',                    [checkDatabaseConfig, onVideoListRequest]],

    // ALIAS: 同 music，三条路径指向 chat 页面 handler
    ['/chat',                              [checkDatabaseConfig, onChatPageRequest]],
    ['/chat/',                             [checkDatabaseConfig, onChatPageRequest]],
    ['/chat.html',                         [checkDatabaseConfig, onChatPageRequest]],
    ['/api/chat/config',                   [checkDatabaseConfig, onChatConfigRequest]],
    ['/api/chat/sendText',                 [checkDatabaseConfig, onChatSendTextRequest]],
    ['/api/chat/history',                  [checkDatabaseConfig, onChatHistoryRequest]],
    ['/api/chat/clear',                    [checkDatabaseConfig, onChatClearRequest]],

    // ── /api/site：有意设计的公开端点，不是漏挂鉴权 ──
    //
    // 依赖方：
    //   - stats.html:508            （公开统计展示页，未登录访客可见）
    //   - js/file-stats-widget.js:358-359（管理端存储面板 widget）
    //
    // 因此这两条路由不挂 apiManageChain。暴露面由 othersConfig.showStats.enabled
    // 控制（stats.js 内部检查），默认值为 true（见 functions/utils/sysConfig.js）。
    // 若要收窄暴露面，应改默认值或在前端加登录门槛，而不是在此处加鉴权
    // —— 加鉴权会直接打断 stats.html。
    ['/api/site/storage-overview',         [checkDatabaseConfig, getOnly(onManageStatsRequest)]],
    ['/api/site/storage-panel',            [checkDatabaseConfig, getOnly(onManageSysConfigShowStats)]],
]);

// ── 动态路由（需要正则参数提取，仅 13 条）──────────────────────────────────────
const DYNAMIC_ROUTES = [
    { pattern: /^\/upload(\/.*)?$/,               params: () => ({}),                          middlewares: uploadMiddleware },
    { pattern: /^\/file\/(.+)$/,                  params: (m) => ({ path: m[1] }),              middlewares: fileMiddleware },
    { pattern: /^\/temp\/(.+)$/,                  params: (m) => ({ path: m[1] }),              middlewares: tempAccessMiddleware },
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
    { pattern: /^\/api\/manage\/temp-link\/(.+)$/, params: (m) => ({ path: m[1] }), middlewares: apiManageChain(onManageTempLinkRequest) },
];

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
 * 把路径解析为可执行的描述。
 *
 * 匹配顺序：
 *   1. STATIC_ROUTES   —— 精确匹配，O(1)
 *   2. DYNAMIC_ROUTES  —— 正则匹配（13 条）
 *   3. generatedAuthRoutes —— /api/auth/*（由 deploy/worker/generate-routes.js 生成）
 *
 * @param {string} pathname
 * @returns {{kind: 'chain', chain: Function[], params: Object}
 *          | {kind: 'generated', route: Object}
 *          | null}
 */
export function resolveRoute(pathname) {
    const staticChain = STATIC_ROUTES.get(pathname);
    if (staticChain) {
        return { kind: 'chain', chain: staticChain, params: {} };
    }

    const dynamicRoute = matchDynamicRoute(pathname);
    if (dynamicRoute) {
        return { kind: 'chain', chain: dynamicRoute.middlewares, params: dynamicRoute.params };
    }

    const generatedAuthRoute = matchGeneratedAuthRoute(pathname);
    if (generatedAuthRoute) {
        return { kind: 'generated', route: generatedAuthRoute };
    }

    return null;
}

// ── Worker 负责路径的兜底 ──────────────────────────────────────────────────────
//
// 本清单与 wrangler.toml 的 run_worker_first 一一对应：这些路径下的请求应当
// 由本文件的路由表处理。若匹配失败，说明路由登记遗漏，必须显式报错而不是
// 回落到静态资源。
//
// 为什么重要：wrangler.toml 的 not_found_handling = "single-page-application"
// 会让所有未匹配路径返回 index.html。于是「路由漏登记」与「用户访问不存在的
// 前端路由」在行为上无法区分 —— 前端拿到 HTML 去 JSON.parse，报一个与真实
// 原因毫无关系的语法错误，排查成本极高。
//
// 注意精确匹配与前缀匹配必须分开：若把 '/music' 当纯前缀，'/musical' 会被
// 误判为 worker 路径，从而让正常的 SPA 路由变成 404。
//
export const WORKER_OWNED_EXACT = [
    '/upload', '/file', '/temp', '/api',
    '/chat', '/chat.html',
    '/music', '/music.html',
    '/random', '/dav',
];

export const WORKER_OWNED_PREFIXES = [
    '/upload/', '/file/', '/temp/', '/api/',
    '/chat/', '/music/', '/random/', '/dav/',
];

export function isWorkerOwnedPath(pathname) {
    if (WORKER_OWNED_EXACT.includes(pathname)) {
        return true;
    }
    return WORKER_OWNED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// 仅供测试与契约校验使用
export const ROUTE_TABLE_FOR_CHECK = {
    static: STATIC_ROUTES,
    dynamic: DYNAMIC_ROUTES,
};
