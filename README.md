# CloudFlare ImgBed

[English](README_en.md) | [在线文档](https://cfbed.sanyue.de) | [演示站点](https://cfbed.1314883.xyz/)

基于 Cloudflare Workers 的开源文件托管服务，支持 Telegram、Discord、Cloudflare R2、S3、Hugging Face 和 WebDAV，提供上传、管理、目录浏览、鉴权、临时链接、随机图、音乐、视频与聊天页面。

![界面预览](static/readme/海报.png)

## 开发与部署

```bash
npm install
npm start
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm test` | 运行测试与 Worker 路由一致性检查 |
| `npm run build:worker` | 执行 Workers 部署预检 |
| `npm run worker:dev` | 启动本地开发服务，默认端口 `8788` |
| `npm run worker:deploy` | 部署生产环境 |
| `npm run worker:deploy:dev` | 部署 `dev` 环境 |
| `npm run worker:secret -- <NAME>` | 写入 Worker 密钥 |

Worker 入口、静态资源和绑定配置位于 [`wrangler.toml`](wrangler.toml)。首次部署前请确认 KV、R2、D1 与 Durable Object 配置符合实际使用场景。

完整部署说明、功能文档、更新日志与常见问题请查看[在线文档](https://cfbed.sanyue.de)。

## 项目结构

```text
functions/   Pages Functions 风格的业务处理器
src/         Worker 入口、路由适配与 Durable Object
js/ css/     前端构建产物与增强脚本
scripts/     部署资源准备与前端补丁脚本
database/    D1 初始化与迁移脚本
test/        自动化测试
```

前端源码位于 [MarSeventh/Sanyue-ImgHub](https://github.com/MarSeventh/Sanyue-ImgHub)。

## License

[MIT](LICENSE)
