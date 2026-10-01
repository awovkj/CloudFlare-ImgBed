const JSON_HEADERS = {
    'Content-Type': 'application/json'
};

export function createJsonResponse(payload, options = {}) {
    return new Response(JSON.stringify(payload), {
        ...options,
        headers: {
            ...JSON_HEADERS,
            ...(options.headers || {})
        }
    });
}

export function createTextResponse(body, options = {}) {
    return new Response(body, {
        ...options,
        headers: {
            ...(options.headers || {})
        }
    });
}

export function createNoStoreTextResponse(body, status, statusText, headers = {}) {
    return createTextResponse(body, {
        status,
        statusText,
        headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(body.length),
            ...headers
        }
    });
}

/**
 * 统一的服务端错误响应。
 *
 * 背景：此前多处直接把 error.message 拼进响应体（src/worker.js、file/[[path]].js
 * 的 7 个渠道出口、dav/[[path]].js 等），会把上游存储服务的报错原文（可能含
 * endpoint、bucket 名、鉴权失败细节）和内部函数名回吐给客户端。
 *
 * 策略：响应体只回一个 requestId，完整错误只进 console。需要排查时用 requestId
 * 在 `wrangler tail` 里定位。本地调试（env.dev_mode === 'true'）才附带 message。
 *
 * @param {Object} env - Worker 环境变量
 * @param {Error|unknown} error - 捕获到的错误
 * @param {{pathname?: string, headers?: Object}} [options]
 */
export function createServerErrorResponse(env, error, { pathname = '', headers = {} } = {}) {
    const requestId = crypto.randomUUID();
    console.error(`[error] requestId=${requestId} path=${pathname}`, error);

    const payload = { error: 'Internal Server Error', requestId };
    if (env?.dev_mode === 'true') {
        payload.message = String(error?.message || error);
    }

    return createJsonResponse(payload, {
        status: 500,
        headers: {
            'Cache-Control': 'no-store',
            ...headers,
        },
    });
}
