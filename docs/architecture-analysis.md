# Wand 架构总览

wand 是一个通过浏览器管理本地 CLI 会话的 Node.js 应用。它不是“前后端分离 + API 网关 + 独立前端构建”的形态，而是一个由 CLI 启动的单体进程：同一个 Node 进程负责配置初始化、SQLite 持久化、Express HTTP 服务、WebSocket 广播、PTY 子进程管理、Claude 输出解析，以及服务端拼装出来的浏览器界面。

## 1. 一条主链路看全局

```text
wand init / wand web
        │
        ▼
src/cli.ts
  ├─ resolveConfigPath()
  ├─ ensureConfig()
  ├─ ensureDatabaseFile()
  └─ startServer()
        │
        ▼
src/server.ts
  ├─ Express 路由
  ├─ Auth / 配置 / 文件浏览 / 会话控制 API
  ├─ Web UI HTML 输出
  ├─ WebSocketServer(/ws)
  ├─ ProcessManager
  └─ WandStorage
        │
        ▼
src/process-manager.ts
  ├─ node-pty 创建终端进程
  ├─ SessionLifecycleManager 管状态
  ├─ SessionLogger 落磁盘日志
  ├─ ClaudePtyBridge 解析 Claude 输出
  └─ WandStorage 持久化快照
        │
        ▼
src/ws-broadcast.ts
  └─ 向浏览器推送 started / output / status / task / notification
        │
        ▼
src/web-ui/index.ts + content/scripts.js + content/styles.css
  ├─ 拉取 /api/*
  ├─ 连接 /ws
  ├─ 渲染 terminal / chat 两种视图
  └─ 驱动文件浏览、设置、恢复会话、权限决策
```

## 2. 运行时的几个核心对象

### 2.1 `WandConfig`
配置来自 `src/config.ts`，默认保存在 `~/.wand/config.json`。CLI 启动时总会调用 `ensureConfig()`：

- 没有配置文件时创建默认值
- 有配置文件时读取、合并默认值、规范化后写回

因此 `config.json` 不是一次性初始化产物，而是每次启动都可能被“补齐默认字段”的活动配置文件。

### 2.2 `WandStorage`
`src/storage.ts` 用 SQLite 保存：

- 登录 session token
- 命令会话快照
- 额外配置值（如收藏路径、最近路径、隐藏的 Claude 历史会话）

数据库位置由 `resolveDatabasePath(configPath)` 决定，默认是 `~/.wand/wand.db`，与 config 文件放在同一目录。

### 2.3 `ProcessManager`
它是后端真正的“运行时内核”。`server.ts` 中几乎所有和命令执行相关的路由，最后都会落到 `ProcessManager`：

- 新建会话
- 发送输入
- 调整终端大小
- 恢复会话
- 审批权限
- 停止/删除会话
- 扫描 Claude 历史会话

### 2.4 `ClaudePtyBridge`
`ProcessManager` 只拿到 PTY 原始输出流；真正把 Claude 输出转换为“聊天消息、任务信息、权限提示、Claude session ID”的是 `src/claude-pty-bridge.ts`。

这意味着 wand 在浏览器中的 chat 视图，并不是 Claude 直接提供的结构化 API 响应，而是从 PTY 文本流中重新抽取出来的结果。

## 3. 后端不是纯 API 服务，而是“服务端拼 UI”

`src/server.ts` 直接返回 Web UI：

- `/` 返回 `renderApp(configPath)` 生成的 HTML
- `/manifest.json`、`/sw.js`、`/icon.*` 由 Node 运行时动态生成
- `/vendor/xterm/*` 从 `node_modules` 暴露静态资源

而 `src/web-ui/index.ts` 只是一个“HTML 拼装器”：

- `styles.ts` 读取 `src/web-ui/content/styles.css`
- `scripts.ts` 读取 `src/web-ui/content/scripts.js`
- `index.ts` 把它们拼成完整 HTML 文档

也就是说，这个项目的“前端构建”非常轻：

- TypeScript 只覆盖服务器代码
- 浏览器端脚本就是一份原始 `scripts.js`
- 构建时只需要把 `src/web-ui/content/` 复制到 `dist/web-ui/`

## 4. 两种会话表示：终端视图 vs 聊天视图

wand 同时维护两条平行表示：

1. **raw terminal output**
   - 给原生终端视图使用
   - 来源是 PTY 原始输出缓冲

2. **structured conversation messages**
   - 给 chat 视图使用
   - 来源是 `ClaudePtyBridge` 从 PTY 文本中解析出的 `ConversationTurn[]`

`src/message-parser.ts` 还保留了一份降级解析器，用于某些接口按 `format=chat` 读取会话时，在没有结构化消息时从 raw output 回推 `ChatMessage[]`。

因此项目里存在三类“消息”概念：

- 终端原始输出
- `ConversationTurn[]`
- 降级用的 `ChatMessage[]`

理解这三者的边界，是排查“聊天视图为什么和终端显示不一致”的关键。

## 5. 权限、恢复、生命周期是跨模块功能

这三个功能都不是一个文件能单独解释清楚的。

### 5.1 权限审批
- `ClaudePtyBridge` 从输出中检测权限提示
- `ProcessManager` 把检测结果挂到会话状态里
- `server.ts` 暴露 approve / deny / resolve API
- 前端读取会话状态并展示审批 UI

### 5.2 会话恢复
- `ClaudePtyBridge` 从 Claude 输出中抓取 `claudeSessionId`
- `storage.ts` 持久化 `claude_session_id` 与 `messages`
- `ProcessManager` 负责扫描历史 Claude 项目文件、判断是否可恢复
- `server.ts` 暴露按 wand session / Claude session 两种恢复接口
- 前端显示 Resume 按钮和 Claude 历史侧栏

### 5.3 生命周期与归档
- `SessionLifecycleManager` 维护 initializing / running / thinking / waiting-input / idle / archived
- `ProcessManager` 在输入、输出、退出等时机调用 lifecycle 方法
- `storage.ts` 保存 `archived`、`archivedAt`
- `SessionLogger` 额外把文件级日志留在 `~/.wand/sessions/<sessionId>/`

## 6. 代码阅读优先级建议

如果第一次接触这个仓库，推荐按下面顺序阅读：

1. [`runtime/startup-and-cli.md`](./runtime/startup-and-cli.md)
2. [`runtime/server-and-api.md`](./runtime/server-and-api.md)
3. [`runtime/process-manager-and-pty.md`](./runtime/process-manager-and-pty.md)
4. [`runtime/persistence-and-lifecycle.md`](./runtime/persistence-and-lifecycle.md)
5. [`runtime/web-ui.md`](./runtime/web-ui.md)
6. [`runtime/dependency-map.md`](./runtime/dependency-map.md)

## 7. 当前仓库里哪些文件最值得优先关注

| 文件 | 作用 |
|------|------|
| `src/cli.ts` | CLI 命令入口与启动顺序 |
| `src/server.ts` | 应用装配根节点，所有 HTTP / WS 路由都在这里开始 |
| `src/process-manager.ts` | PTY 会话核心运行时 |
| `src/claude-pty-bridge.ts` | Claude 输出结构化解析器 |
| `src/storage.ts` | SQLite 持久化边界 |
| `src/config.ts` | 配置默认值与落盘规则 |
| `src/session-lifecycle.ts` | 会话状态机 |
| `src/session-logger.ts` | 磁盘日志系统 |
| `src/web-ui/content/scripts.js` | 浏览器端主体逻辑 |
| `src/ws-broadcast.ts` | 后端到前端的实时事件总线 |

## 8. 相关专题

- [启动与 CLI](./runtime/startup-and-cli.md)
- [服务端与 API / WebSocket](./runtime/server-and-api.md)
- [ProcessManager 与 PTY / Claude Bridge](./runtime/process-manager-and-pty.md)
- [持久化、日志与生命周期](./runtime/persistence-and-lifecycle.md)
- [Web UI 运行逻辑](./runtime/web-ui.md)
- [内部依赖图](./runtime/dependency-map.md)
- [发布与安装流程](./operations/release-flow.md)
- [清理候选审计](./cleanup/cleanup-candidates.md)
