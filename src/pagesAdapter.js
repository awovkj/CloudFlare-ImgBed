/**
 * Pages Functions 兼容层
 *
 * 背景：functions/ 下的 handler 全部按 Cloudflare Pages Functions 约定编写
 * （导出 onRequest / onRequestPost，签名是 (context)），而项目运行时已经是
 * Workers（src/worker.js + [assets]）。本模块是两者之间唯一的适配层，
 * 负责把 Pages 的 context 语义翻译成 Workers 可直接调用的形式。
 *
 * 边界：本模块只做「上下文构造 + 中间件链调度 + 方法/预检处理 + 生成路由执行」，
 * 不含任何业务逻辑，也不感知具体路由。业务逻辑一律留在 functions/ 下。
 *
 * 为什么保留而不是删掉：删掉它意味着改写 80 个 handler 的函数签名，
 * 在没有测试网保护的前提下风险与收益不匹配。把它从入口文件里抽出来、
 * 给一个明确的位置和单一职责，是当前约束下的正确形态。
 */

import { buildPreflightResponse } from '../functions/utils/cors.js';

/** 构造 Pages Functions context 对象 */
export function makeContext(request, env, ctx, params = {}, data = {}, nextFn = null) {
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
export async function runMiddlewareChain(request, env, ctx, params, middlewares) {
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
export function postOnly(handler) {
    return async function(context) {
        if (context.request.method === 'OPTIONS') {
            return buildPreflightResponse({ methods: 'POST, OPTIONS' });
        }
        if (context.request.method !== 'POST') {
            return new Response('Method Not Allowed', { status: 405 });
        }
        return handler(context);
    };
}

export function getOnly(handler) {
    return async function(context) {
        if (context.request.method === 'OPTIONS') {
            return buildPreflightResponse({
                methods: 'GET, OPTIONS',
                headers: 'Content-Type, Authorization, authCode',
            });
        }
        if (context.request.method !== 'GET') {
            return new Response('Method Not Allowed', { status: 405 });
        }
        return handler(context);
    };
}

export function collectModuleMiddlewares(middlewareModules) {
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

export function resolveModuleHandler(mod, method) {
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

export function collectAllowedMethods(mod) {
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

export function buildGeneratedOptionsResponse(mod) {
    const allowedMethods = collectAllowedMethods(mod);
    const allowHeaders = new Set(['Content-Type', 'Authorization']);

    if (allowedMethods.includes('GET')) {
        allowHeaders.add('authCode');
    }

    return buildPreflightResponse({
        methods: [...allowedMethods, 'OPTIONS'].join(', '),
        headers: [...allowHeaders].join(', '),
    });
}

export async function runGeneratedRoute(request, env, ctx, route) {
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
