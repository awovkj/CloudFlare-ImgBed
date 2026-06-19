# 2.7.4 指定改进稳妥融合设计

日期：2026-06-19

## 背景

目标项目 `CloudFlare-ImgBed` 是基于 2.6.3 的定制分支，已经包含自定义 Workers 入口、Upload Durable Object、音乐/视频/聊天页面，以及 Telegram 多渠道上传调度。参考项目 `CloudFlare-ImgBed-2.7.4` 包含一批上传、WebDAV、元数据安全、鉴权与 Session 修复。直接整包覆盖会破坏目标项目的定制功能，因此本次采用“稳妥融合”：按功能点吸收新版精华，保留目标项目现有定制。

## 目标

- 吸收新版 HuggingFace 直传与 multipart completion 相关优化。
- 吸收上传主逻辑中对 `publicUrl`、空 MIME 类型、chunk merge 的修复。
- WebDAV 相关读、删、移动、重命名、公开 URL、配置解析完全按新版优化方向改造。
- 引入新版 channel config / credential resolver / metadata security / metadata view 工具，减少持久化敏感字段并动态补全管理端展示字段。
- 管理端列表、详情、批量列表、元数据写入、移动、重命名、恢复等路径统一脱敏与清理配置派生字段。
- 吸收新版鉴权与 Session max-age 后端标准化修复，避免异常配置导致 KV `expirationTtl` 错误。
- 保持目标项目现有音乐、视频、聊天、自定义 Worker、DO 代理、TG lane 调度可用。

## 非目标

- 不将目标项目整体升级或覆盖为 2.7.4。
- 不删除目标项目已有音乐、视频、聊天功能。
- 不重写前端构建体系，只做本次功能需要的局部补丁。
- 不改变现有数据库 schema，除非新版兼容逻辑已有惰性/兼容处理。
- 不改变现有用户可见 API 路径，新增路径需兼容 Pages 与 Workers 两种部署方式。

## 架构

本次融合分为四层：

1. **共享配置与凭据层**
   - 新增 `functions/utils/metadata/channelConfig.js`：从当前上传配置中查找 channel，并支持基于旧元数据唯一身份字段做 fallback 匹配。
   - 新增 `functions/utils/metadata/channelCredentials.js`：统一解析 S3/R2、Telegram、Discord、HuggingFace、WebDAV 凭据。
   - 新增 `functions/utils/storage/webdavAPI.js`：提供 WebDAV API、base URL normalization、公开 URL 构建、headers normalization。

2. **元数据安全与展示层**
   - 新增 `metadataSecurity.js`：集中定义敏感字段与配置派生字段的清理逻辑。
   - 新增 `metadataView.js`：管理端返回前动态补全 `S3Location`、`S3CdnFileUrl`、`HfFileUrl`、`WebDAVPublicUrl` 等展示字段。
   - 写入数据库前使用 clean persisted metadata；返回管理端前使用 strip/enrich view metadata。

3. **上传与 HuggingFace 层**
   - 保留目标项目已有增强版 `functions/utils/huggingfaceAPI.js` 的 retry、rate-limit、repo cache、multipart 能力。
   - 补齐 `/upload/huggingface/completeMultipart`，并在 Worker 路由注册。
   - `getUploadUrl` 将 HuggingFace LFS multipart completion URL 改写到内部代理 endpoint。
   - `fileType` 或 `originalFileType` 为空时统一回退 `application/octet-stream`。
   - 基础上传与 chunk merge 成功响应增加 `publicUrl`。

4. **操作路径层**
   - `file/[[path]].js`：读取文件时优先从当前 channel 配置解析凭据；HuggingFace HEAD 使用 `FileSizeBytes` 返回真实 `Content-Length`；WebDAV fallback 保持原始 403/404。
   - `delete/move/rename`：远端操作成功后再移动数据库记录；WebDAV 按新版完整支持；所有路径写回前清理敏感/配置派生字段。
   - `list/batch/metadata/cusConfig files`：返回前脱敏并动态补全展示字段。

## 数据流

### 上传成功响应

1. 上传请求进入 `/upload` 或 chunk merge。
2. 业务逻辑完成远端存储与索引写入。
3. 根据页面/上传配置计算默认 URL 前缀。
4. 响应中保留原有字段，并额外返回 `publicUrl`。
5. 如无默认 URL 前缀，`publicUrl` 可为空或省略，避免改变旧客户端必需字段。

### HuggingFace 大文件直传

1. 前端计算 SHA256 与文件样本。
2. 调用 `/api/huggingface/getUploadUrl` 或兼容的 `/upload/huggingface/getUploadUrl`。
3. 后端选择 HuggingFace channel，生成 LFS 上传动作。
4. 如果返回 multipart completion URL，则改写为 `/upload/huggingface/completeMultipart?target=...`。
5. 前端直接上传到 HuggingFace S3。
6. multipart 完成时经内部代理提交 completion 请求。
7. 前端调用 commit API，后端写入索引前清理敏感元数据，并返回公开链接。

### WebDAV 文件操作

1. 读取/删除/移动/重命名拿到文件元数据。
2. 通过 `resolveWebDAVCredentials()` 从当前配置解析 WebDAV 凭据。
3. 若 ChannelName 缺失或 channel 重命名，使用 legacy metadata 的唯一身份字段 fallback 匹配。
4. 执行远端 WebDAV 操作。
5. 仅远端操作成功后更新索引/数据库。
6. 返回管理端数据时隐藏密码、headers、token、URL userinfo 等敏感内容。

## 错误处理与边界

- 安全配置加载失败时，admin login、user login、session check 返回 503，不回退到空认证配置。
- Session max age 后端统一限制到 1-3650 天，异常时间戳或越界值回退 14 天。
- HuggingFace get upload URL 不再要求 `fileType`，缺失时使用 `application/octet-stream`。
- multipart completion 的 target URL 与 parts/body 需要验证，非法请求返回 400。
- WebDAV public URL 读取失败时保留原始 403/404；只有真正内部异常才返回 500。
- S3/WebDAV 远端 move/rename/delete 失败时，不移动或删除数据库记录。
- 旧记录中没有 ChannelName 的 Telegram 文件回退到 `Telegram_env`。
- channel 名称应提示不可变，前端配置界面禁用 channel name 编辑，避免破坏文件与配置关联。

## 文件范围

优先修改或新增以下文件：

- `functions/utils/metadata/channelConfig.js`
- `functions/utils/metadata/channelCredentials.js`
- `functions/utils/metadata/metadataSecurity.js`
- `functions/utils/metadata/metadataView.js`
- `functions/utils/storage/webdavAPI.js`
- `functions/upload/huggingface/completeMultipart.js`
- `functions/api/huggingface/getUploadUrl.js`
- `functions/api/huggingface/commitUpload.js`
- `functions/upload/index.js`
- `functions/upload/chunkUpload.js`
- `functions/upload/chunkMerge.js`
- `functions/upload/uploadTools.js`
- `functions/file/[[path]].js`
- `functions/api/manage/delete/[[path]].js`
- `functions/api/manage/move/[[path]].js`
- `functions/api/manage/rename/[[path]].js`
- `functions/api/manage/metadata/[[path]].js`
- `functions/api/manage/list.js`
- `functions/api/manage/batch/list.js`
- `functions/api/manage/cusConfig/files.js`（若目标项目需要补齐路由）
- `functions/api/manage/sysConfig/upload.js`
- `functions/api/manage/sysConfig/security.js`
- `functions/utils/auth/sessionConfig.js`
- `functions/utils/auth/sessionManager.js`
- `functions/api/auth/adminLogin.js`
- `functions/api/auth/login.js`
- `functions/api/auth/sessionCheck.js`
- `src/worker.js`
- `deploy/worker/generate-routes.js` 或相关生成产物
- 前端系统设置/渠道设置对应的 compiled JS 补丁脚本与 gzip 产物（仅在需要实现 session max-age 校验和 channel name immutability UI 时修改）

## 测试计划

- `npm test`：保证现有 TG lane 测试继续通过。
- 新增单元测试覆盖：
  - metadata sensitive/config-derived field stripping。
  - WebDAV URL userinfo stripping 与 URL normalization。
  - session max-age normalization。
  - HuggingFace empty MIME type fallback。
  - multipart completion target/body validation。
- `npm run generate:worker-routes`：确认新增 HuggingFace / WebDAV / auth 路由可被 Worker 入口访问。
- `npm run build:frontend-dist`：确认静态产物复制与 gzip 未损坏。
- `npm run build:worker`：确认 Worker dry-run 构建通过。

## 实施顺序

1. 先引入共享工具和单元测试，不接业务路径。
2. 接入 WebDAV credential resolver 与 metadata security，优先处理读/删/移动/重命名。
3. 接入管理端列表/详情/批量/metadata 的脱敏与动态展示。
4. 接入 HuggingFace direct upload multipart completion 与空 MIME fallback。
5. 接入上传响应 `publicUrl` 和 chunk merge 修复。
6. 接入鉴权/Session max-age 后端修复。
7. 最后做前端 UI 提示/校验补丁与压缩产物更新。

## 风险控制

- 每阶段只做小批量改动，并运行对应测试。
- 不用 2.7.4 整文件覆盖目标项目中已有重度定制的上传、Worker、聊天相关文件。
- 对 import 路径提供兼容 wrapper 或局部改写，避免一次性迁移所有旧路径。
- 先保证 Pages Functions 路径，再同步 Worker 路由，避免部署模式不一致。
