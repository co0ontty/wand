# 服务端与 API / WebSocket 运行逻辑

`src/server.ts` 是 wand 的服务端装配中心。虽然项目有很多模块，但最终都是在这里被串起来的：配置、鉴权、文件浏览、会话控制、更新检查、WebSocket 推送、PWA 入口、浏览器 UI 输出，都从这里对外暴露。

## 1. `startServer()` 的初始化顺序

`startServer(config, configPath)` 的开头做了几件决定全局行为的事：

1. 创建 `express()` 应用实例
2. 创建 `WandStorage(resolveDatabasePath(configPath))`
3. 调用 `setAuthStorage(storage)`，把鉴权模块和数据库接起来
4. 计算 `configDir`
5. 调用 `ensureAvatarSeed(configDir)` 生成/读取头像种子
6. 创建 `ProcessManager(config, storage, configDir)`
7. 根据 `config.https` 决定协议
8. 暴露 `xterm` 和 `@xterm/addon-fit` 的静态目录

也就是说，server 层有三种核心依赖：

- **状态层**：`WandStorage`
- **运行层**：`ProcessManager`
- **表示层**：`renderApp()` + `WsBroadcastManager`

## 2. 根页面与 PWA 不是静态文件，而是运行时生成

### 2.1 `/`
访问根路径时，server 直接返回：

- `renderApp(configPath)` 生成的 HTML
- 禁止缓存的响应头

因此浏览器端拿到的是一份包含：

- 内联 CSS
- 内联主脚本
- 外链 xterm vendor 脚本

的完整 HTML 文档。

### 2.2 `/manifest.json`, `/sw.js`, `/icon.*`
这些也不是预构建静态资源，而是：

- `generatePwaManifest()` 动态生成 manifest
- `generateServiceWorker()` 动态生成 Service Worker 代码
- `getAvatarSvg()` 根据种子生成图标 SVG

因此 PWA 行为依赖的并不是 `public/` 目录，而是服务端代码。

## 3. 登录与认证链路

认证逻辑跨越 `server.ts` 与 `auth.ts` 两个模块。

### 3.1 登录过程
`POST /api/login` 的处理流程：

1. 读取 `req.ip` / `req.socket.remoteAddress`
2. 调用 `checkRateLimit(clientIp)` 检查登录限流
3. 读取请求体 `password`
4. 优先从数据库 `storage.getPassword()` 取密码
5. 如果数据库没有自定义密码，则回退到 `config.password`
6. 密码正确时：
   - `resetRateLimit(clientIp)`
   - `createSession()` 生成 token
   - 通过 cookie `wand_session` 写回浏览器
7. 密码错误时：
   - `recordFailedLogin(clientIp)`
   - 返回 401

### 3.2 `auth.ts` 的职责
`src/auth.ts` 使用两层存储保存登录态：

- 进程内 `Map<string, number>` 保存 token 与过期时间
- `WandStorage` 持久化到 SQLite 的 `auth_sessions`

验证时先查内存，再查数据库并回填到内存。这让服务重启后，部分登录态仍可恢复。

### 3.3 限流与认证的边界
- 认证 token：可持久化
- 登录失败计数：只存在内存 `Map`

因此 rate limit 在重启后会清空，而登录态可能继续有效。

## 4. `/api/config` 和 `/api/settings` 的区别

这两个接口都和配置有关，但语义不同。

### `/api/config`
给主界面初始化使用，返回：

- `host`, `port`
- `defaultMode`
- `defaultCwd`
- `commandPresets`
- `updateAvailable`, `latestVersion`, `currentVersion`

它是“运行界面所需的简化配置”。

### `/api/settings`
给设置页使用，返回：

- 版本信息
- 包信息
- Node 要求
- 仓库 URL
- `safeConfig`（去掉 password）
- 当前证书文件是否存在

它是“设置面板所需的完整配置视图”。

## 5. 设置更新链路

### 5.1 `/api/settings/config`
这个接口允许更新的字段很有限：

- `host`
- `port`
- `https`
- `defaultMode`
- `defaultCwd`
- `shell`

更新逻辑是：

1. 校验字段是否合法
2. 直接修改内存中的 `config` 对象
3. 调用 `saveConfig(configPath, config)` 写回磁盘
4. 返回 `restartRequired: true`

也就是说，设置页修改的是“进程当前持有的 config 对象 + config 文件”，但不会热重启 server。

### 5.2 `/api/settings/upload-cert`
直接把上传的 PEM 文本写入：

- `server.key`
- `server.crt`

也返回 `restartRequired: true`。

## 6. 文件系统相关 API

服务端暴露了几类和目录/文件有关的接口。

### 6.1 目录浏览 `/api/directory`
用途：项目目录内文件浏览。

关键约束：

- 基准目录是 `process.cwd()`
- `isPathWithinBase(targetPath, allowedBase)` 防止越界访问
- 可选带 `gitStatus=true` 附加 Git 状态

返回的是 `FileEntry[]`，并可附加 `gitStatus`。

### 6.2 文件预览 `/api/file-preview`
用途：读取文本文件内容。

关键限制：

- 路径必须在 `process.cwd()` 下
- 文件不能是目录
- 文件大小不能超过 512 KB
- 仅支持一组白名单文本扩展名

### 6.3 文件夹选择 `/api/folders`
用途：通用目录选择器，不局限于项目目录，但禁止访问系统敏感路径。

依赖 `src/middleware/path-safety.ts`：

- `normalizeFolderPath()`
- `isBlockedFolderPath()`

阻止浏览：`/etc`, `/root`, `/boot`。

### 6.4 快捷路径 / 收藏 / 最近路径
这些接口把用户偏好保存在 SQLite `app_config` 中，而不是配置文件：

- `/api/quick-paths`
- `/api/favorite-paths`
- `/api/recent-paths`
- `/api/validate-path`

因此这里属于“应用运行态数据”，而不是 `config.json` 静态配置。

## 7. 会话控制 API 如何落到 `ProcessManager`

### 7.1 新建会话
`POST /api/commands`

- 读取 `CommandRequest`
- 通过 `normalizeMode()` 归一化 mode
- 调用 `processes.start(command, cwd, mode, initialInput)`

### 7.2 输入与终端交互
`POST /api/sessions/:id/input`

- 读取 `InputRequest`
- 把 `input`, `view`, `shortcutKey` 传给 `processes.sendInput()`
- 失败时统一走 `getInputErrorResponse()`

`POST /api/sessions/:id/resize`

- 调用 `processes.resize()`

### 7.3 权限审批
- `/api/sessions/:id/approve-permission`
- `/api/sessions/:id/deny-permission`
- `/api/sessions/:id/escalations/:requestId/resolve`

都只是把决策交给 `ProcessManager` 执行。

### 7.4 停止与删除
- `/api/sessions/:id/stop` -> `processes.stop()`
- `DELETE /api/sessions/:id` -> `processes.delete()`
- `/api/sessions/batch-delete` -> 多次调用 `delete()`

## 8. Claude 历史会话与恢复 API

这一块功能比普通会话复杂，因为它不只依赖 SQLite，也依赖 Claude 自己在磁盘上留下的历史数据。

### 8.1 历史会话
`/api/claude-history` 系列接口调用：

- `processes.listClaudeHistorySessions()`
- `processes.deleteClaudeHistoryFiles()`

同时还会读写“隐藏的 Claude session ID”到 `app_config`，用于把已经删除或隐藏的历史项从 UI 中排除。

### 8.2 恢复 wand session
`POST /api/sessions/:id/resume`

步骤：

1. 先从 `processes.get()` 或 `storage.getSession()` 找原会话
2. 检查 `claudeSessionId` 是否存在
3. 检查 command 是否以 `claude` 开头
4. 拼出 `command --resume <claudeSessionId>`
5. 调用 `processes.start(..., { resumedFromSessionId })`
6. 回写旧会话的 `resumedToSessionId`

### 8.3 按 Claude session ID 恢复
`POST /api/claude-sessions/:claudeSessionId/resume`

分两种情况：

- SQLite 里有对应最近会话：复用旧 command / cwd / mode
- SQLite 里没有：要求前端提供 `cwd`，直接执行 `claude --resume <id>`

这个接口说明恢复功能的真实主键是 Claude 自己的 session UUID，而不是 wand 的 session ID。

## 9. `/api/sessions/:id?format=chat` 的降级逻辑

读取会话详情时：

- 默认返回 `SessionSnapshot`
- 如果 query 带 `format=chat`，且 `snapshot.messages` 不存在，就调用 `parseMessages(snapshot.output)` 从终端文本回推聊天内容

这一步是 chat 视图的容错逻辑，但也说明：

- 数据源优先级是 `messages`
- raw output 只是降级兜底

## 10. WebSocket 层怎么工作

### 10.1 创建与绑定
在 `server.ts` 里：

1. 根据 `config.https` 创建 HTTP 或 HTTPS server
2. 创建 `new WebSocketServer({ server, path: "/ws" })`
3. 创建 `new WsBroadcastManager(wss)`
4. `wsManager.setup((id) => processes.get(id))`
5. `processes.on("process", (event) => wsManager.emitEvent(event))`

### 10.2 `WsBroadcastManager` 的职责
`src/ws-broadcast.ts` 处理：

- WebSocket 鉴权（校验 cookie 里的 `wand_session`）
- 客户端 subscribe
- 会话初始快照下发
- 事件广播
- output 事件 16ms debounce
- 背压控制（每客户端最多 500 条队列）

### 10.3 前端订阅方式
浏览器连接后会发送：

```json
{ "type": "subscribe", "sessionId": "..." }
```

服务端收到后，如果会话存在，就立即返回：

- `type: "init"`
- `data: { ...snapshot, messages, output }`

随后再持续推送增量事件。

## 11. 启动完成后的两个后台动作

服务监听成功后，`server.ts` 还会做两件事：

### 11.1 `processes.runStartupCommands()`
用于在服务已可访问后，再启动配置里的后台命令/恢复逻辑，避免抢占启动路径。

### 11.2 `checkNpmLatestVersion()`
后台检查 npm 最新版本：

- 更新 `cachedUpdateInfo`
- 如果发现新版本，写 stdout 提示
- 通过 WebSocket 发出 `notification` 事件给前端

所以版本提示既可以在服务端日志看到，也会进浏览器 UI。

## 12. 这个文件在项目中的角色

`src/server.ts` 的定位不是“若干小接口的集合”，而是应用的统一装配层。后续要加任何功能，基本都要先判断它属于下面哪一层：

- 纯路由拼装/输入输出：放 `server.ts`
- 会话运行逻辑：放 `ProcessManager`
- 持久化：放 `storage.ts`
- 浏览器展示：放 `web-ui/*`
- 通用支撑：放 `auth.ts` / `middleware/*` / `ws-broadcast.ts` / `pwa.ts`

如果不先分清层次，`server.ts` 很容易重新变成所有职责的汇集点。
