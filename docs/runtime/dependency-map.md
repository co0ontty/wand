# 内部依赖关系与调用图

这一页把 wand 的主要模块按“谁调用谁、谁依赖谁、谁拥有状态”来重新梳理，适合在需要快速定位改动影响面时使用。

## 1. 总体依赖图

```text
src/cli.ts
  ├─ src/config.ts
  ├─ src/storage.ts
  ├─ src/types.ts
  └─ src/server.ts

src/server.ts
  ├─ src/auth.ts
  ├─ src/cert.ts
  ├─ src/config.ts
  ├─ src/message-parser.ts
  ├─ src/middleware/path-safety.ts
  ├─ src/middleware/rate-limit.ts
  ├─ src/process-manager.ts
  ├─ src/pwa.ts
  ├─ src/storage.ts
  ├─ src/types.ts
  ├─ src/web-ui/index.ts
  └─ src/ws-broadcast.ts

src/process-manager.ts
  ├─ node-pty
  ├─ src/claude-pty-bridge.ts
  ├─ src/session-lifecycle.ts
  ├─ src/session-logger.ts
  ├─ src/storage.ts
  ├─ src/pty-text-utils.ts
  └─ src/types.ts

src/claude-pty-bridge.ts
  ├─ src/pty-text-utils.ts
  └─ src/types.ts

src/web-ui/index.ts
  ├─ src/web-ui/styles.ts
  └─ src/web-ui/scripts.ts

src/web-ui/styles.ts
  └─ src/web-ui/content/styles.css

src/web-ui/scripts.ts
  └─ src/web-ui/content/scripts.js
```

## 2. 按职责划分的模块簇

### 2.1 启动与配置簇
- `src/cli.ts`
- `src/config.ts`
- `src/storage.ts`

职责：
- 决定运行根目录
- 初始化 config / db
- 提供 CLI 控制面

### 2.2 服务装配簇
- `src/server.ts`
- `src/auth.ts`
- `src/cert.ts`
- `src/middleware/path-safety.ts`
- `src/middleware/rate-limit.ts`
- `src/pwa.ts`
- `src/ws-broadcast.ts`

职责：
- 暴露 HTTP / WS / PWA
- 管理登录态
- 管理证书
- 控制目录访问与登录限流

### 2.3 会话运行簇
- `src/process-manager.ts`
- `src/claude-pty-bridge.ts`
- `src/session-lifecycle.ts`
- `src/session-logger.ts`
- `src/message-parser.ts`
- `src/pty-text-utils.ts`

职责：
- 启动子进程
- 解析 Claude 输出
- 管理生命周期
- 保存原始日志与结构化消息

### 2.4 浏览器表示簇
- `src/web-ui/index.ts`
- `src/web-ui/styles.ts`
- `src/web-ui/scripts.ts`
- `src/web-ui/content/styles.css`
- `src/web-ui/content/scripts.js`

职责：
- 服务端拼装 HTML
- 浏览器端维护单页状态
- 渲染 terminal / chat / settings / file browser / claude history

## 3. 谁拥有长期状态

### `config.ts`
拥有“默认配置规则”，不拥有运行态实例。

### `server.ts`
拥有：
- 当前进程内的 `config`
- `WandStorage`
- `ProcessManager`
- `WebSocketServer`

它是应用生命周期的顶层拥有者。

### `ProcessManager`
拥有：
- 当前所有会话内存态
- PTY 引用
- 会话与桥接器的绑定关系
- 生命周期管理器与日志器实例

它是“会话域”的状态中心。

### `scripts.js`
拥有：
- 浏览器端大部分 UI 状态
- 当前选中 session / view / modal / drafts / terminal 实例等

它是“前端显示域”的状态中心。

## 4. 关键跨文件调用链

### 4.1 新建会话
```text
浏览器 scripts.js
  └─ POST /api/commands
       └─ server.ts
            └─ ProcessManager.start()
                 ├─ node-pty 创建进程
                 ├─ ClaudePtyBridge 创建解析器
                 ├─ WandStorage.saveSession(...)
                 └─ emit started / output / status
       └─ ws-broadcast.ts
            └─ 推送给浏览器
```

### 4.2 用户发送消息
```text
浏览器 scripts.js
  └─ POST /api/sessions/:id/input
       └─ server.ts
            └─ ProcessManager.sendInput()
                 ├─ lifecycle.touch()/startThinking()
                 ├─ bridge.onUserInput()
                 └─ pty.write(...)
                      └─ PTY 输出回流
                           ├─ raw output
                           ├─ chat parsing
                           └─ ws 推送
```

### 4.3 恢复会话
```text
浏览器 Resume
  └─ POST /api/sessions/:id/resume 或 /api/claude-sessions/:claudeSessionId/resume
       └─ server.ts
            ├─ storage.getSession() / getLatestSessionByClaudeSessionId()
            ├─ ProcessManager.start("claude --resume ...")
            └─ storage.saveSession(旧会话的 resumedToSessionId)
```

### 4.4 登录
```text
浏览器 scripts.js
  └─ POST /api/login
       └─ server.ts
            ├─ rate-limit.ts 检查与记录失败次数
            ├─ storage.getPassword() / config.password
            └─ auth.ts createSession()
                 ├─ 内存 Map
                 └─ SQLite auth_sessions
```

### 4.5 目录浏览
```text
浏览器 scripts.js
  └─ GET /api/directory / /api/folders / /api/file-search / /api/file-preview
       └─ server.ts
            ├─ path-safety.ts 路径约束
            ├─ fs/promises 读取目录/文件
            └─ storage.ts 保存收藏/最近路径（部分接口）
```

## 5. 哪些模块是“纯支撑”，哪些是“业务枢纽”

### 纯支撑模块
- `auth.ts`
- `cert.ts`
- `middleware/path-safety.ts`
- `middleware/rate-limit.ts`
- `pwa.ts`
- `styles.ts`
- `scripts.ts`

这些模块相对专一，依赖面清晰。

### 业务枢纽模块
- `server.ts`
- `process-manager.ts`
- `claude-pty-bridge.ts`
- `src/web-ui/content/scripts.js`

这些文件一旦改动，往往会影响多个功能面。

## 6. 修改某类功能时优先看哪些文件

### 改 CLI / 配置
- `src/cli.ts`
- `src/config.ts`
- `src/types.ts`

### 改 API / 服务启动
- `src/server.ts`
- `src/auth.ts`
- `src/ws-broadcast.ts`
- `src/pwa.ts`

### 改 Claude 输出解析 / 权限 / 恢复
- `src/process-manager.ts`
- `src/claude-pty-bridge.ts`
- `src/storage.ts`
- `src/message-parser.ts`

### 改前端展示
- `src/web-ui/content/scripts.js`
- `src/web-ui/content/styles.css`
- `src/web-ui/index.ts`

### 改持久化 / 归档 / 日志
- `src/storage.ts`
- `src/session-lifecycle.ts`
- `src/session-logger.ts`
- `src/process-manager.ts`

## 7. 影响面最大的几个边界

### 7.1 `SessionSnapshot`
定义在 `src/types.ts`，被以下多处共用：

- `storage.ts`
- `process-manager.ts`
- `server.ts`
- `ws-broadcast.ts`
- 前端 snapshot 消费逻辑

因此改这个接口时，要同步考虑数据库映射、WebSocket init、REST 返回与前端消费。

### 7.2 `ConversationTurn[]`
被以下多处使用：

- `ClaudePtyBridge`
- `storage.ts`
- `server.ts`
- 前端 chat 渲染

因此改消息块结构时，不只是 bridge 要改，持久化与 UI 也都要跟着变。

### 7.3 `configPath`
它从 CLI 一路影响：

- 配置读取
- 数据库路径
- 证书目录
- 会话日志目录
- HTML 中注入给前端的 configPath

所以它是一个全局根参数。

## 8. 一句话总结

如果把这个仓库看成几层：

- `cli.ts` 负责**启动入口**
- `server.ts` 负责**对外装配**
- `process-manager.ts` 负责**会话执行内核**
- `claude-pty-bridge.ts` 负责**Claude 文本语义化**
- `storage.ts` / `session-logger.ts` 负责**状态留痕**
- `web-ui/*` 负责**浏览器呈现**

绝大多数功能问题，都是这些层之间的接口契约没有对齐，而不是单一文件里的一个判断写错这么简单。
