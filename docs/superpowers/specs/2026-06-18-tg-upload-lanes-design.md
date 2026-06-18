# TG 多渠道上传调度设计

日期：2026-06-18

## 背景

当前前端上传组件 `UploadForm` 使用固定并发上限（现有值为 6）调度文件上传。服务端 `/upload` 已支持通过 `channelName` 指定具体 Telegram 渠道，`/api/channels` 也已返回启用的 Telegram 渠道列表。因此，本次优化应优先在前端调度层完成：上传大量文件时，根据可用 Telegram 渠道数同时上传多个文件，但保证每个 Telegram 渠道同一时间只上传一个文件。

## 目标

- 未指定 Telegram 渠道时：使用所有可用 Telegram 渠道并行上传，并发数等于可用 TG 渠道数。
- 每个 Telegram 渠道同一时间最多上传 1 个文件。
- 指定某个 Telegram 渠道时：所有 TG 文件串行上传，并发数为 1。
- 其他上传渠道保持现有并发调度行为。
- 取消、删除、失败、自动重试不破坏队列与渠道占用状态。

## 非目标

- 不实现跨浏览器、跨用户、跨 Worker 实例的全局 Telegram 渠道锁。
- 不改变后端 Telegram 上传接口、Bot API 调用方式或存储元数据格式。
- 不改变非 Telegram 渠道的并发策略。

## 架构

在 `UploadForm` 内新增 Telegram 专用调度器，与现有通用上传队列并存：

- 通用队列继续服务非 TG 渠道，沿用 `activeUploads` / `maxConcurrentUploads`。
- TG 队列只服务 `uploadChannel === 'telegram'` 的文件。
- TG 调度器根据当前选择构建 lane：
  - `channelName` 非空：lane 只有该渠道。
  - `channelName` 为空：lane 来自 `currentChannelList` 中所有可用 TG 渠道。
- 每个 lane 记录 busy 状态；只有空闲 lane 能启动一个等待文件。
- 启动 TG 文件前，将分配到的渠道名写入对应 `fileItem.channelName`。

`UploadHome` 已持有 `currentChannelList`，需要传入 `UploadForm`，使上传组件知道当前 TG 可用渠道。

## 数据流

1. 用户选择或拖拽多个文件。
2. `beforeUpload` 将文件加入 `fileList`，初始状态保持与现有逻辑一致。
3. `uploadFile(file)` 判断文件渠道：
   - 非 TG：走现有通用并发逻辑。
   - TG：进入 TG 队列，状态为 `waiting`，由 TG 调度器分配 lane。
4. TG 调度器查找空闲 lane：
   - 找到后将文件状态改为 `uploading`。
   - 写入 `fileItem.channelName = lane.name`。
   - 调用现有上传流程（小文件直传、大文件分块）。
5. `uploadSingleFile`、`uploadFileInChunks` 构建 `/upload` URL 时优先使用 `fileItem.channelName`，保证直传、初始化分块、上传分块、合并请求都使用同一个 TG 渠道。
6. 上传成功、失败或取消后释放 lane，并继续调度队列中的下一个文件。

## 错误处理与边界

- 如果没有可用 TG 渠道，则保留现有行为：不传 `channelName`，由后端默认选择；同时 TG 并发退化为 1，避免无界并发。
- 删除等待中的文件时，从 TG 队列移除。
- 删除正在上传的文件时，调用已有 `AbortController.abort()`，并在 finally 阶段释放 lane。
- 分块上传失败后沿用现有清理逻辑，释放 lane 后继续处理等待文件。
- 自动重试再次进入上传时，重新参与 TG lane 分配，避免占用已释放渠道。

## 测试计划

新增前端调度逻辑的单元测试或等价脚本测试，覆盖：

1. 3 个 TG 渠道、10 个文件：首次只启动 3 个文件。
2. 任意时刻同一 TG 渠道最多 1 个文件处于上传中。
3. 指定单个 TG 渠道时，只启动 1 个文件，其余等待。
4. 一个 TG 文件完成后，释放对应 lane 并启动下一个等待文件。
5. 取消/删除等待文件不会启动该文件。
6. 非 TG 渠道仍按现有 `maxConcurrentUploads` 行为调度。

完成后运行项目测试与构建检查，确认前端产物和 Worker 路由不被破坏。
