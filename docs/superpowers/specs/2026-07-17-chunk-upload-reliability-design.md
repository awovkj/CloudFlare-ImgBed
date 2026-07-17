# 分片上传与合并可靠性优化设计

## 目标

在不破坏现有上传接口、前端调用方式、存储渠道和旧上传会话的前提下，重构分片上传与合并链路，使其具备可验证的输入约束、分片幂等、可恢复状态、可靠合并锁、明确错误语义和完整清理能力。

本轮聚焦 `CloudFlare-ImgBed` 的上传主链路；参考仓库只吸收原生 multipart、确定性渠道选择和多后端差异化处理，不直接覆盖目标仓库已有的 manifest、聊天上传、后台合并和安全增强。

## 兼容边界

- 保留现有接口：
  - `POST /upload?initChunked=true`
  - `POST /upload?chunked=true`
  - `POST /upload?chunked=true&merge=true`
  - `GET|POST /upload?cleanup=true&uploadId=...`
  - `GET /upload/chunkStatus?uploadId=...`
- 旧前端未发送 `fileSize`、`chunkSize`、`fileFingerprint`、`chunkChecksum` 时仍可上传。
- 旧版 `upload_session_*`、`upload_manifest_*`、`chunk_*` 和 `multipart_*` 数据可读；新写入数据增加 `schemaVersion: 2`，读取时归一化。
- 保留 Telegram、Discord、Cloudflare R2、S3 和聊天上传行为；HuggingFace 大文件继续使用已有直传 multipart 流程，不接入通用分片合并。
- 响应继续包含旧前端依赖的字段，同时增加机器可读的 `code`、`retryable`、`retryAfterMs`、`uploadedChunks` 和 `failedChunks`。

## 总体架构

### 1. 协议与状态规则

新增纯函数模块 `functions/upload/chunkProtocol.js`，集中负责：

- 初始化参数校验；
- 分片索引、分片数量、文件大小和分片大小校验；
- 旧会话到 v2 会话的归一化；
- 分片状态分类；
- 重复分片是否可直接复用的判断；
- 合并结果与错误响应字段生成。

该模块不依赖 Cloudflare 运行时，使用 Mocha 直接进行行为测试。

### 2. 会话与 Manifest

会话记录继续使用 `upload_session_${uploadId}`，新增：

```js
{
  schemaVersion: 2,
  uploadId,
  originalFileName,
  originalFileType,
  fileSize: null | number,
  chunkSize: null | number,
  totalChunks,
  fileFingerprint: null | string,
  uploadChannel,
  channelName,
  status,
  revision,
  createdAt,
  updatedAt,
  expiresAt,
  mergeLeaseUntil,
  mergeResult
}
```

Manifest 继续使用 `upload_manifest_${uploadId}`，每片记录至少包含：

```js
{
  index,
  status,
  size,
  checksum,
  partNumber,
  etag,
  storageRef,
  attempt,
  error,
  updatedAt
}
```

状态以 manifest 为主、旧 chunk metadata 为兼容回退。已完成分片只有在索引、大小以及可用 checksum 均一致时才能作为重复请求直接复用。

### 3. 状态机

上传会话使用以下状态：

```text
initialized -> uploading -> waiting_chunks -> merging -> merge_success
                    |              |             |
                    +-> failed_retryable         +-> merge_failed
initialized/uploading/waiting_chunks/merge_failed -> aborted
```

- `waiting_chunks` 不是合并锁，补齐分片后可再次进入合并。
- `merging` 必须带有限时租约；租约未过期时重复请求返回 `409 MERGE_IN_PROGRESS`。
- `merge_success` 保存最终结果，重复合并返回同一结果。
- 可恢复失败不自动删除会话和 multipart；显式取消、会话过期或成功持久化后才清理。

### 4. Durable Object 协调

修复当前每个请求使用 `newUniqueId()` 导致无法互斥的问题：

- init 请求没有 `uploadId`，仍使用独立 DO 或直接处理；
- chunk、merge、cleanup 请求从 URL/FormData 克隆中提取 `uploadId`，使用 `idFromName(uploadId)`；
- 同一上传的请求进入同一个 DO 实例，从运行时层面串行化关键状态变更；
- DO 接受 `GET`、`POST`、`OPTIONS`，修复现有 cleanup GET 在启用 DO 时返回 405；
- 没有 DO 或显式禁用时，数据库中的 `mergeLeaseUntil` 继续提供降级保护。

### 5. R2/S3 Multipart

- 在初始化阶段创建 multipart 并保存 `multipart_${uploadId}`，不再依赖第 0 片。
- `finalFileId`、后端 upload ID、渠道名和创建时间一次性确定。
- 分片上传仅恢复既有 multipart 并上传对应 part number。
- 重复 completed 分片不再次上传。
- complete 前按 part number 排序并校验数量、范围和 ETag。
- complete 成功后先持久化最终文件 metadata 和 `merge_success`，再异步清理临时记录。
- complete 网络状态不确定时保留会话，不立即 abort；重复调用通过最终记录/会话结果判定幂等。

### 6. Telegram/Discord

- 继续采用逻辑合并，最终记录有序远端分片引用。
- Manifest 只保存恢复读取所需的非敏感引用；token、密钥不写入分片 value 或最终持久化 metadata。
- 重复分片先检查 manifest，避免客户端重试产生重复远端消息。
- 明确失败返回非 2xx，使前端执行已有 HTTP 重试，而不是把失败伪装成成功留到合并阶段。

### 7. D1 与过期处理

- 修正 `checkDatabaseConfig()` 与实际 adapter 选择不一致：KV 存在时 `usingKV=true`，只有实际选择 D1 时 `usingD1=true`。
- D1 的 KV 兼容层实现 `expirationTtl`：写入内部过期时间；读取到过期记录时删除并返回空。
- D1 不保存分片二进制正文。存储端失败直接返回可重试错误，由客户端重新发送正文。
- 清理会删除 session、manifest、chunk 记录，并按渠道 abort multipart；D1 即使没有原生 TTL 也不会无限保留已读取的过期会话。

## 请求流程

### 初始化

1. 兼容解析旧字段，并接受可选的 `fileSize`、`chunkSize`、`fileFingerprint`。
2. 校验 `totalChunks` 为 `1..10000` 的整数；若有大小信息，校验块数与大小关系。
3. 使用 `crypto.randomUUID()` 生成 upload ID。
4. 确定上传渠道和渠道名称。
5. R2/S3 立即初始化 multipart；其他渠道只建立会话。
6. 原子顺序写入 session、manifest 和 multipart 信息。
7. 返回 upload ID、session 版本、过期时间和空的 completed bitmap。

### 上传单片

1. 校验会话存在且未过期，URL 渠道不得覆盖会话中的已确定渠道。
2. 校验 `0 <= chunkIndex < totalChunks`，请求总片数必须与会话一致。
3. 校验分片非空；有 `chunkSize/fileSize` 时校验普通片和末片大小。
4. 若 manifest 已有相同 completed 片，返回幂等成功。
5. 将片状态写为 `uploading`，增加 attempt。
6. 上传存储端；超时必须能终止底层请求或至少返回明确的 `503 CHUNK_UPLOAD_RETRYABLE`，不得返回伪成功。
7. 成功后写入 completed 状态和后端 part 引用；失败写入 failed 状态并返回非 2xx。

### 状态与续传

状态接口返回：

- session 状态和过期时间；
- `uploadedChunks`、`failedChunks`、`inProgressChunks`；
- 每片必要的大小/checksum 信息；
- merge 状态、结果或错误。

前端 patch 在初始化时发送文件大小、块大小和稳定文件指纹；再次选择相同文件时可根据本地保存的 upload ID 查询状态并跳过 completed 分片。旧前端不使用该能力时行为不变。

### 合并

1. 在同 upload ID 的 DO/租约保护下读取 session 和 manifest。
2. `merge_success` 直接返回保存结果。
3. 有上传中分片时返回 `409 CHUNKS_INCOMPLETE`，不抢占最终合并锁。
4. 有失败或缺失分片时返回具体索引；保留会话供补传。
5. 全部分片完成后进入 `merging` 并设置租约。
6. 按渠道执行原生 complete 或逻辑合并。
7. 先保存最终文件和 merge result，再标记成功，最后异步清理临时状态。

## 错误处理

- `400 INVALID_CHUNK_REQUEST`：参数或范围不合法。
- `404 UPLOAD_SESSION_NOT_FOUND`：会话不存在。
- `409 CHUNK_IN_PROGRESS`：同一分片正在处理。
- `409 CHUNKS_INCOMPLETE`：尚有未完成分片。
- `409 MERGE_IN_PROGRESS`：已有有效合并租约。
- `410 UPLOAD_SESSION_EXPIRED`：会话过期。
- `422 CHUNK_SIZE_MISMATCH`：分片大小与会话约束不符。
- `503 CHUNK_UPLOAD_RETRYABLE`：存储端暂时失败，客户端应重传该片。
- `500 MERGE_FAILED`：合并失败但状态保留；响应指出是否可重试。

所有 JSON 错误保留可读 `message`，新增稳定 `code`。

## 前端改进

- 保留现有并发池，R2/S3 并发 6，Telegram/Discord 并发 3。
- 初始化发送 `fileSize/chunkSize/fileFingerprint`。
- 将 upload ID 与指纹存入 localStorage；成功、取消或确定不可恢复后删除。
- 上传前查询 `chunkStatus`，跳过已完成分片。
- 分片重试使用指数退避并加入随机抖动，尊重 `retryAfterMs`。
- cleanup 改用 POST；后端仍兼容 GET。
- 合并继续轮询 409/暂时性 5xx，但终态错误停止轮询。

## 测试策略

1. `chunkProtocol` 行为测试：输入校验、旧会话归一化、幂等判断、状态分类。
2. D1 兼容测试：实际 adapter 选择、`expirationTtl`、过期删除。
3. DO 路由测试：同 upload ID 使用 `idFromName`，cleanup GET/POST 均可达。
4. 上传源码契约测试：init 字段、状态恢复、非 2xx 重试语义、前端 cleanup POST。
5. 合并状态机测试：缺片、并发合并、成功幂等、租约过期、失败保留。
6. 全量 `npm test`。
7. `npm run build:frontend-dist` 与 `npm run build:worker`，确保 bundle patch、路由和 Worker 构建成功。

## 非目标

- 不升级整个项目到参考仓库的依赖版本。
- 不重写完整 Vue 前端工程；继续通过可重复执行的 patch 脚本维护已发布 bundle。
- 不新增与上传可靠性无关的 Docker、音乐、聊天或管理功能。
- 不将 HuggingFace 直传流程强行合并到通用分片协议。

