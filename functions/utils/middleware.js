import { checkDatabaseConfig as checkDbConfig } from './databaseAdapter.js';

export function checkDatabaseConfig(context) {
  const dbConfig = checkDbConfig(context.env);

  if (!dbConfig.configured) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "数据库未配置 / Database not configured",
        message: "请配置 KV 存储 (env.img_url) 或 D1 数据库 (env.img_d1)。"
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  return context.next();
}
