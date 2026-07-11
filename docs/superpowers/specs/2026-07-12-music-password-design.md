# Music 独立密码保护设计

## 目标

为 `/music` 页面及其数据接口增加独立密码保护。密码由管理后台配置，验证成功后通过有效期七天的安全 Cookie 保持会话，避免密码出现在 URL 中，并阻止未授权客户端抓取歌曲列表。

## 范围

本次包含：

- 后台 Music 密码配置、修改和清除。
- Music 独立登录、登出和会话验证。
- `/music` 与 `/api/music/list` 的统一访问控制。
- Music 页面密码输入交互迁移至 Cookie 会话。
- 登录限流、禁止缓存和搜索引擎索引提示。

本次不包含 DRM、音频加密、一次性播放链接或阻止已获授权用户保存媒体内容。密码保护只能限制未授权访问，不能阻止持有正确密码的客户端抓取。

## 配置模型

`manage@sysConfig@others` 的 `musicPlayer` 增加：

```json
{
  "enabled": true,
  "musicDir": "music",
  "passwordHash": "pbkdf2$..."
}
```

- 管理 API 的 GET 响应只返回 `passwordConfigured: boolean`，绝不返回密码哈希。
- 管理 API 的 POST 接受临时字段 `password` 和 `clearPassword`。
- `password` 非空时使用现有 `hashPassword()` 保存，并清除所有旧 Music 会话。
- 密码留空且未设置 `clearPassword` 时保留原哈希。
- `clearPassword: true` 删除密码并清除所有旧 Music 会话。
- Music 开启但未配置密码时，页面和列表接口拒绝公开访问，返回配置错误。

## 会话模型

扩展现有会话管理器，增加 `music` 认证类型：

- Cookie 名称：`music_session`
- KV Key：沿用 `manage@session@<token>`
- 有效期：固定七天（604800 秒）
- Cookie 属性：`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`
- Session 数据中的 `authType` 为 `music`

密码修改或清除时调用按认证类型清理会话的现有能力，确保旧 Cookie 立即失效。管理员会话可以访问 Music 页面，普通全站用户会话不能替代 Music 独立密码。

## HTTP 接口

### `POST /api/music/login`

请求：

```json
{ "password": "..." }
```

行为：

1. 检查 Music 已启用且已配置密码。
2. 检查来源/IP 的失败次数限制。
3. 使用 `verifyPassword()` 验证。
4. 成功时创建七天 Music 会话并设置 Cookie。
5. 失败统一返回 `401 { "error": "Invalid password" }`。

### `POST /api/music/logout`

删除当前 Music 会话并清除 Cookie。

### `GET /api/music/session`

返回当前 Music 会话是否有效，供页面初始化登录状态。

### 受保护资源

- `GET /music`：需要有效 Music 会话或管理员会话。
- `GET /api/music/list`：使用相同检查，不能只保护 HTML 而暴露歌曲列表。
- `/music.html` 继续重定向至 `/music`，避免绕过鉴权直接访问静态资源。

所有认证响应和受保护页面响应设置 `Cache-Control: no-store`。

## 页面交互

- 未登录时显示 Music 页面内置密码框。
- 提交密码调用 `/api/music/login`；成功后刷新歌曲列表，不把密码写入 URL、LocalStorage 或日志。
- 页面初始化调用 `/api/music/session` 判断登录状态。
- 登录失败显示统一提示，并在 `429` 时提示稍后重试。
- 提供退出按钮，调用 `/api/music/logout`。
- 删除现有 `?authCode=` 读取和拼接逻辑。
- HTML 增加 `<meta name="robots" content="noindex,nofollow">`。

## 登录限流

按客户端 IP 记录 Music 登录失败次数：

- 十分钟窗口内最多五次失败。
- 超限返回 HTTP 429。
- 成功登录后清除该 IP 的失败记录。
- 限流记录使用带 TTL 的数据库键，不保存明文密码。

## 错误处理

- Music 未启用：403。
- Music 已启用但未配置密码：503，提示管理员完成配置。
- 未登录或会话失效：401。
- 密码错误：401，统一错误信息。
- 登录尝试过多：429。
- 配置或会话存储不可用：503，不降级为公开访问。

## 测试策略

- 配置 GET 不泄露密码哈希。
- 设置新密码时生成哈希，留空保持旧密码，清除操作删除密码。
- 修改密码后旧 Music 会话失效。
- 正确密码创建七天 `music_session`，错误密码不创建 Cookie。
- Cookie 包含 HttpOnly、Secure、SameSite、Path 和正确 Max-Age。
- `/music` 与 `/api/music/list` 对未登录请求均返回 401。
- 有效 Music 会话与管理员会话可访问。
- 全站普通用户会话不能绕过 Music 密码。
- 登录限流在阈值后返回 429，成功后清除失败计数。
- 前端不再使用 `authCode` URL 参数。
- Worker dry-run 构建包含 Music 页面和新增路由。

## 部署与兼容性

- 已启用 Music 但尚未设置独立密码的部署将在升级后返回 503；管理员必须先在后台设置 Music 密码。
- 不迁移或复用现有全站用户密码，避免意外扩大访问范围。
- 部署后通过修改一次 Music 密码验证旧会话撤销路径。
