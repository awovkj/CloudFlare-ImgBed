import sentryPlugin from "@cloudflare/pages-plugin-sentry";
import '@sentry/tracing';
import { fetchOthersConfig } from "./sysConfig";
import { checkDatabaseConfig as checkDbConfig } from './databaseAdapter.js';

// 远程采样率缓存（模块生命周期内有效）
let _cachedSampleRate = null;
let _sampleRateFetchedAt = 0;
const SAMPLE_RATE_CACHE_MS = 5 * 60 * 1000; // 5 分钟内不重新请求

// telemetry 配置缓存
let _cachedTelemetryEnabled = null;
let _telemetryFetchedAt = 0;
const TELEMETRY_CACHE_MS = 60 * 1000; // 1 分钟内不重新读取

export async function errorHandling(context) {
  // 读取 telemetry 开关（带模块级缓存）
  const now = Date.now();
  if (_cachedTelemetryEnabled === null || now - _telemetryFetchedAt > TELEMETRY_CACHE_MS) {
    const othersConfig = await fetchOthersConfig(context.env);
    _cachedTelemetryEnabled = othersConfig.telemetry.enabled;
    _telemetryFetchedAt = now;
  }
  const disableTelemetry = !_cachedTelemetryEnabled;

  // 将结果写入 context.data 供后续中间件复用
  context.data.disableTelemetry = disableTelemetry;

  const env = context.env;
  if (!disableTelemetry) {
    context.data.telemetry = true;
    let remoteSampleRate = 0.001;
    try {
      remoteSampleRate = await fetchSampleRate(context);
    } catch (e) { console.error(e); }
    const sampleRate = env.sampleRate || remoteSampleRate;
    return sentryPlugin({
      dsn: "https://44b7b443108ec6d298044b125ff89d28@o4507644548022272.ingest.us.sentry.io/4507644555100160",
      tracesSampleRate: sampleRate,
    })(context);
  }

  return context.next();
}

export async function telemetryData(context) {
  // 直接使用 errorHandling 已计算并写入 context.data 的开关，避免重复读取
  const disableTelemetry = context.data.disableTelemetry !== undefined
    ? context.data.disableTelemetry
    : !_cachedTelemetryEnabled;

  if (!disableTelemetry) {
    try {
      const parsedHeaders = {};
      // 只收集有调试价值的请求头，避免遍历全部头部的开销
      const USEFUL_HEADERS = [
        'user-agent', 'referer', 'origin', 'content-type',
        'accept', 'accept-language', 'authorization',
        'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-for'
      ];
      for (const key of USEFUL_HEADERS) {
        const value = context.request.headers.get(key);
        if (value) {
          parsedHeaders[key] = value;
          context.data.sentry.setTag(key, value);
        }
      }

      // 直接遍历 request.cf，无需 JSON 深拷贝（request.cf 已是普通对象）
      const cf = context.request.cf;
      const parsedCF = {};
      if (cf) {
        for (const key in cf) {
          const val = cf[key];
          if (typeof val === "object") {
            parsedCF[key] = JSON.stringify(val);
          } else {
            parsedCF[key] = val;
            if (val && String(val).length > 0) {
              context.data.sentry.setTag(key, String(val));
            }
          }
        }
      }

      const requestUrl = new URL(context.request.url);
      const data = {
        headers: parsedHeaders,
        cf: parsedCF,
        url: context.request.url,
        method: context.request.method,
        redirect: context.request.redirect,
      };
      context.data.sentry.setTag("path", requestUrl.pathname);
      context.data.sentry.setTag("url", data.url);
      context.data.sentry.setTag("method", context.request.method);
      context.data.sentry.setTag("redirect", context.request.redirect);
      context.data.sentry.setContext("request", data);
      const transaction = context.data.sentry.startTransaction({ name: `${context.request.method} ${requestUrl.hostname}` });
      context.data.transaction = transaction;
      return await context.next();
    } catch (e) {
      console.error(e);
    } finally {
      context.data.transaction.finish();
    }
  }

  return context.next();
}

async function fetchSampleRate(context) {
  const data = context.data;
  if (!data.telemetry) return 0.001;

  const now = Date.now();
  if (_cachedSampleRate !== null && now - _sampleRateFetchedAt < SAMPLE_RATE_CACHE_MS) {
    return _cachedSampleRate;
  }

  const url = "https://frozen-sentinel.pages.dev/signal/sampleRate.json";
  const response = await fetch(url);
  const json = await response.json();
  _cachedSampleRate = json.rate;
  _sampleRateFetchedAt = now;
  return _cachedSampleRate;
}

// 检查数据库是否配置
// 优化：checkDbConfig 是纯同步操作，去掉不必要的 async/await，减少微任务调度开销
export function checkDatabaseConfig(context) {
  const dbConfig = checkDbConfig(context.env);

  if (!dbConfig.configured) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "数据库未配置 / Database not configured",
        message: "请配置 KV 存储 (env.img_url) 或 D1 数据库 (env.img_d1)。 / Please configure KV storage (env.img_url) or D1 database (env.img_d1)."
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  // 继续执行 — 直接返回 next() 的 Promise，无需 await
  return context.next();
}
