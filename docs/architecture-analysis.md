# Wand 模块运行逻辑梳理

## 整体架构

wand 是一个 Node.js Web 控制台，用于在浏览器中管理本地 PTY 会话（尤其是 Claude CLI）。项目采用**单体服务器 + 内联前端**的架构，所有模块围绕 `ProcessManager → ClaudePtyBridge → WebSocket` 这条数据流展开。

```
cli.ts
  │ 启动
  ▼
config.ts ─── 解析/加载/合并 ~/.wand/config.json
storage.ts ─── 初始化 ~/.wand/wand.db (SQLite)
  │
  ▼
server.ts ─── Express 服务器
  │
  ├── ProcessManager ── 管理所有 PTY 会话生命周期
  │     │
  │     ├── ClaudePtyBridge ── 解析 PTY 输出为结构化聊天事件
  │     ├── SessionLifecycleManager ── 会话状态机 (idle/thinking/archived)
  │     └── SessionLogger ── 磁盘日志 (~/.wand/sessions/<id>/)
  │
  ├── WandStorage ── SQLite 持久化 (sessions / auth / config)
  ├── WebSocketServer ── 向前端推送 ProcessEvent
  └── Web UI ── 内联 HTML/CSS/JS 单页应用
```

---

## 模块逐一分析

### 1. cli.ts — CLI 入口

**职责：** 解析子命令，确保配置文件和数据库存在，启动服务器。

**执行流：**
1. 读取 `process.argv` 解析子命令：`init` / `web` / `config:path` / `config:show` / `config:set`
2. 调用 `ensureConfig()` 合并默认配置并写入 `config.json`
3. 调用 `ensureDatabaseFile()` 创建/打开 SQLite 数据库
4. `web` 命令调用 `startServer()` 启动 HTTP/WebSocket 服务

**依赖：** config.ts, storage.ts, server.ts, types.ts

**问题：**
- ⚠️ `ensureRequiredFiles()` 调用 `ensureConfig()` 会**重写整个配置文件**（默认值 + 已有值），然后 `startServer()` 中不再重复调用 `ensureConfig()`。但如果用户直接 `wand web` 而没跑过 `wand init`，`ensureConfig()` 会在此时创建配置文件。逻辑上没问题，但两个入口（init 和 web）都创建文件，职责不够清晰。

---

### 2. server.ts — 服务器核心

**职责：** Express HTTP 服务 + WebSocket 广播 + 所有 REST API + 静态资源 + PWA。

**执行流：**
1. 创建 `express()`, `WandStorage`, `ProcessManager`
2. 注册中间件（JSON 解析、静态资源）
3. 注册路由：登录/鉴权 → 配置 → 文件浏览 → 会话控制 → PTY 输入
4. 注册 `ProcessManager` 事件监听，将 `ProcessEvent` 转发到 WebSocket
5. 执行 `runStartupCommands()` 自动恢复上次会话
6. 启动 HTTP/HTTPS 监听

**关键路由组：**
| 路径 | 功能 |
|------|------|
| `/` | 内联 Web UI HTML |
| `/manifest.json`, `/sw.js`, `/icon.*` | PWA 端点（含 Service Worker 内联生成） |
| `/api/login`, `/api/logout` | 认证 |
| `/api/config` | 读取配置 |
| `/api/sessions` | 会话列表/详情 |
| `/api/commands` | 启动新会话 |
| `/api/sessions/:id/input` | 发送 PTY 输入 |
| `/api/sessions/:id/resize` | 调整终端大小 |
| `/api/sessions/:id/resume` | 恢复会话 |
| `/api/sessions/:id/(approve|deny)-permission` | 权限审批 |
| `/api/sessions/:id/stop` | 停止会话 |
| `/api/directory`, `/api/file-preview`, `/api/folders` | 文件浏览器 |
| `/api/quick-paths`, `/api/favorites` | 路径快捷操作 |
| `/ws` | WebSocket 连接 |

**依赖：** express, ws, http/https, auth.ts, cert.ts, process-manager.ts, storage.ts, message-parser.ts, web-ui/index.ts

**问题：**
- ⚠️ **文件过于庞大（~900 行）**，集成了太多职责：路由定义、鉴权中间件、速率限制、路径安全检查、Git 状态查询、WebSocket 广播、PWA/Service Worker 内联生成、错误处理、离线页面。这些应该拆分为独立的中间件模块或路由模块。
- ⚠️ Service Worker 代码以模板字符串内联在 `server.ts` 中，而非作为独立文件。缓存版本号（`v4`）硬编码，更新缓存策略需要改服务器代码。
- ⚠️ 证书生成逻辑（`cert.ts`）在 `server.ts` 启动时被调用，首次生成可能阻塞启动数十秒，但没有任何进度提示。
- ⚠️ 速率限制使用全局 `Map` 存储在模块作用域，进程重启后丢失，与 session 持久化到 SQLite 的策略不一致。

---

### 3. process-manager.ts — PTY 会话管理

**职责：** 创建/管理/销毁 PTY 进程，处理输入输出流转，权限审批，会话持久化，自动恢复。

**执行流 — 启动会话：**
1. `start(command, cwd, mode, initialInput, opts)`
2. 验证命令是否在 `allowedCommandPrefixes` 白名单中
3. 解析工作目录，检测是否为 Claude 命令
4. 创建 `SessionRecord` 和 `ClaudePtyBridge`
5. 通过 `node-pty` 生成 PTY 进程
6. 注册 `onData` 回调：PTY 输出 → `bridge.processChunk()` → 更新 raw output → 写入日志 → 自动确认权限 → 持久化快照
7. 注册 `onExit` 回调：标记停止 → 归档会话 → 持久化
8. 向 WebSocket 广播 `started` 事件

**执行流 — 用户输入：**
1. `sendInput(id, input)` → 查找 SessionRecord
2. 调用 `lifecycle.touch()` + `startThinking()`
3. `bridge.onUserInput(input)` → 开始跟踪新回复
4. `ptyProcess.write(input + "\n")` → 写入 PTY
5. 持久化快照

**执行流 — 权限处理：**
1. Bridge 检测到权限提示 → `detectPermission()` → 自动审批或 emit `permission.prompt`
2. Manager 捕获后设置 `pendingEscalation`
3. 用户通过 API `/approve-permission` 或 `/deny-permission` 决策
4. Manager 调用 `bridge.resolvePermission()` → 向 PTY 写入 `\r` 或 `n\r`
5. emit `permission.resolved` → 清除 pending 状态

**执行流 — 启动恢复：**
1. 构造时从 `storage.loadSessions()` 加载所有历史会话
2. 标记所有 running 会话为 exited（PTY 已丢失）
3. 调用 `autoRecoverExitedSessions()`：找出最近一个有 Claude session ID 的已退出会话，自动 resume
4. 调用 `archiveExpiredSessions()`：归档过期的非活跃会话

**依赖：** node-pty, storage.ts, session-logger.ts, session-lifecycle.ts, claude-pty-bridge.ts, types.ts

**问题：**
- ⚠️ **`SessionRecord` 接口过于膨胀**（~25 个字段），同时持有 PTY 引用、Bridge 引用、权限状态、任务信息、Claude 任务发现定时器。一个类承担了会话数据、进程管理、权限状态、任务追踪四种职责。
- ⚠️ 自动恢复逻辑（`autoRecoverExitedSessions`）在构造时同步执行，如果上次会话的 Claude project JSONL 文件很大或磁盘慢，会**阻塞整个服务器启动**。
- ⚠️ `persist()` 方法在每次输出/输入后都调用，包含 bridge 消息快照、SQLite 写入、SessionLogger 磁盘写入。高频调用可能导致 I/O 压力，且没有任何批量或节流策略。
- ⚠️ Claude 任务发现定时器（`claudeTaskDiscoveryTimer`）用于轮询 Claude project JSONL 文件来发现真实的 Claude resumable task ID。这是一种**基于文件系统轮询的启发式方法**，不够可靠。

---

### 4. claude-pty-bridge.ts — PTY 输出解析

**职责：** 将原始 PTY 字节流转换为结构化的聊天事件、权限事件、会话 ID 事件。

**执行流 — 输出处理：**
1. `processChunk(chunk)` 被 Manager 的 `onData` 回调调用
2. 追加到 `rawOutput` 缓冲区（窗口化截断，最大 120KB）
3. emit `output.raw` 事件（终端视图用）
4. `captureSessionId(chunk)` — 从输出中正则匹配 Claude session UUID
5. `detectPermission(chunk)` — 滚动窗口检测权限提示
6. 如果在 `responding` 状态，`parseChatResponse()` → 清理 ANSI → 跳过用户回显 → 更新 assistant 消息内容 → emit `output.chat`

**执行流 — 聊天模式：**
1. `onUserInput(input)` → 添加 user turn + assistant 占位 turn → 切换到 `responding` 状态 → emit `output.chat`
2. 每次 `processChunk()` 追加到 chat buffer
3. `parseChatResponse()` 持续清理文本并更新 assistant 消息
4. `detectCompletion()` 检测到提示符 `❯` 返回时 → `finalizeResponse()` → emit `chat.turn` → 重置为 `idle`

**执行流 — 权限检测：**
1. 维护一个滚动窗口（800 字符）
2. `isPermissionPromptDetected()` 用正则匹配关键词
3. `inferScope()` 推断权限类型（write_file / network / run_command）
4. 如果 autoApprove 或已记住 → 自动发送 `\r` 到 PTY → emit `permission.resolved`
5. 否则 emit `permission.prompt` → 等待外部决策
6. `resolvePermission()` → 写入 PTY → 清除阻塞状态

**依赖：** types.ts

**问题：**
- ⚠️ **聊天解析完全依赖正则启发式**，没有使用 Claude API 的结构化输出。当 Claude CLI 版本更新输出格式时，`isStatusLine()`、`detectCompletion()`、`cleanForChat()` 中的硬编码模式可能失效。
- ⚠️ `isStatusLine()` 有 15+ 个硬编码的字符串匹配（`"Germinating"`, `"Doodling"`, `"Brewing"` 等），这是一个**维护陷阱**——Claude CLI 每次更新提示文案都可能导致解析错误。
- ⚠️ 用户输入过滤（`isRealChatInput()`）会过滤掉 `y`、`n`、单控制字符等输入。如果用户在非 Claude 会话中手动输入 `y` 确认某个提示，会被静默丢弃。
- ⚠️ 聊天解析和权限检测共用同一个 PTY 输出流，但**没有同步机制**。如果权限提示恰好出现在聊天响应的中间，两个检测器可能互相干扰。

---

### 5. config.ts — 配置管理

**职责：** 解析配置路径、加载/验证/合并/保存 JSON 配置。

**执行流：**
1. `resolveConfigPath()` → 支持 `--config` 自定义路径，默认 `~/.wand/config.json`
2. `ensureConfig()` → 读取已有配置 + 合并默认值 → 写回规范化 JSON
3. `saveConfig()` → 直接写入文件
4. `mergeWithDefaults()` → 处理布尔值归一化、数组合并、命令预设验证

**依赖：** types.ts

**问题：**
- ⚠️ `ensureConfig()` 在每次调用时都**无条件重写文件**。如果配置文件格式正确，它也会读取 → 合并 → 写回。这可能导致意外的配置变更（如注释丢失、字段顺序变化）。

---

### 6. storage.ts — SQLite 持久化

**职责：** 管理 SQLite 数据库，存储认证会话、应用配置、命令会话。

**执行流：**
1. 构造时打开数据库，运行 `ensureDatabaseFile()` 创建表结构
2. 表：`auth_sessions`, `config`, `sessions`
3. `saveSession()` → 写入/更新 `SessionSnapshot`（整个快照对象 JSON 序列化）
4. `loadSessions()` → 查询所有会话，按时间倒序
5. `getLatestSessionByClaudeSessionId()` → 按 Claude 会话 ID 查找最近会话（用于 resume）
6. 配置值存储在 `config` 表的 key-value 对中（密码、收藏路径、最近路径）

**依赖：** node:sqlite, types.ts

**问题：**
- ⚠️ Schema 迁移策略是**只加不删**（`ALTER TABLE ADD COLUMN IF NOT EXISTS`），但 `loadSessions()` 读取快照时假设所有字段都存在。如果旧会话缺少新字段（如 `resumedFromSessionId`），可能导致 `undefined` 值传播到下游。
- ⚠️ `SessionSnapshot` 包含 `messages: ConversationTurn[]`，这是一个可能很大的数组，每次 `persist()` 都完整写入 SQLite。对于长会话，这会造成**显著的写入放大**。

---

### 7. session-lifecycle.ts — 会话状态机

**职责：** 管理会话生命周期状态转换，自动超时检测。

**状态流转：**
```
initializing → running → thinking → idle → archived
                        ↓
                   waiting-input
```

**执行流：**
1. 构造时启动 60 秒周期的 `setInterval` 定时器
2. `register(sessionId)` → 注册会话，记录初始时间戳
3. `touch()` → 更新最后活动时间
4. `startThinking()` / `stopThinking()` → 标记思考状态
5. 定时检查：超过 `archiveTimeout` → `archive()`，超过 `idleTimeout` → `onIdle` 回调

**依赖：** types.ts

**问题：**
- ⚠️ 定时器是**全局的单一间隔**（每分钟检查所有会话），精度不够。如果 `idleTimeout` 设置为 5 分钟，实际触发时间可能在 5:00 到 5:59 之间。
- ⚠️ 定时器的错误处理被吞掉（`try/catch` 空实现），状态转换失败时**不会重试也不会记录**。

---

### 8. session-logger.ts — 会话日志

**职责：** 为每个会话创建独立目录，写入 PTY 日志和元数据。

**执行流：**
1. 构造时创建 `~/.wand/sessions/` 根目录
2. 首次访问某 session 时创建 `~/.wand/sessions/<id>/` 子目录
3. `appendPtyOutput()` → 追加到 `pty-output.log`
4. `appendStreamEvent()` → 追加 NDJSON 到 `stream-events.jsonl`
5. `saveMessages()` → 覆盖写入 `messages.json`
6. `saveMetadata()` → 覆盖写入 `metadata.json`

**依赖：** types.ts

**问题：**
- ⚠️ `pty-output.log` **无大小限制且持续追加**。长期运行的会话可能生成数百 MB 的日志文件，没有轮转或截断策略。
- ⚠️ `saveMessages()` 和 `saveMetadata()` 使用**覆盖写入**（`writeFileSync`），如果调用频率高，会产生大量磁盘写入。

---

### 9. message-parser.ts — 消息解析（降级方案）

**职责：** 从原始 PTY 输出中用正则重建 `ChatMessage[]`，作为 Bridge 结构化消息不可用时的降级方案。

**执行流：**
1. `parseMessages(output)` → 去除 ANSI → 按行分割
2. 过滤噪声行（状态行、分隔线）
3. 扫描 `❯` 提示符 → 提示符后的内容为用户输入
4. 用户输入之后的内容为 assistant 回复
5. 返回交替的 user/assistant 消息数组

**依赖：** types.ts

**问题：**
- ⚠️ 与 `claude-pty-bridge.ts` 中的聊天解析**完全独立实现**，使用不同的启发式规则。同一份 PTY 输出经过两个解析器可能产生**不同的消息结果**。这是项目中最大的数据一致性风险点。

---

### 10. types.ts — 类型定义

**职责：** 定义所有共享的 TypeScript 类型和接口。

**包含类型组：**
- 配置类型：`WandConfig`, `ExecutionMode`, `AutonomyPolicy`, `ApprovalPolicy`, `CommandPreset`
- 权限类型：`EscalationScope`, `EscalationRequest`, `EscalationResolution`, `EscalationDecisionRequest`
- 会话类型：`SessionSnapshot`, `CommandRequest`, `InputRequest`, `ResizeRequest`, `FileEntry`, `GitFileStatus`
- 生命周期类型：`SessionLifecycleState`, `SessionLifecycle`
- 聊天类型：`ConversationTurn`, `ContentBlock` 变体, `ChatMessage`
- 事件类型：`SessionEventType`, `SessionEvent` 及各 payload 类型

**问题：**
- ⚠️ `SessionSnapshot` 同时包含 PTY 原始输出、结构化消息、权限状态、生命周期元数据。**接口过大**，建议拆分为 `SessionCore`、`SessionRuntime`、`SessionPersistence`。
- ⚠️ `SessionEvent` 使用联合类型区分事件类型，但 `data` 字段的类型约束不够严格，存在 `data?: unknown` 的退路，**编译期类型安全不完整**。

---

### 11. Web UI 层（src/web-ui/）

**结构：**
- `index.ts` → 组装完整 HTML 文档（导入 CSS + JS → 拼接 HTML 字符串）
- `styles.ts` → 读取 `content/styles.css` 并缓存
- `scripts.ts` → 读取 `content/scripts.js`，替换配置路径占位符
- `content/styles.css` → 浏览器 CSS
- `content/scripts.js` → 浏览器 JavaScript（前端主体）

**执行流：**
1. 浏览器访问 `/`
2. `server.ts` 调用 `renderApp(configPath)`
3. `renderApp()` 读取 CSS + JS → 注入 configPath → 返回完整 HTML
4. 浏览器执行内联 JS，连接 WebSocket，渲染终端和聊天视图

**问题：**
- ⚠️ **前端不是独立构建**。CSS 和 JS 是原始文件，通过 `fs.readFileSync` 读取后嵌入 HTML。这意味着：
  - 没有模块系统（不能使用 `import` / `export`）
  - 所有前端代码必须在单个 `scripts.js` 中
  - 没有 tree-shaking、压缩、source map
  - 前端代码体积会随功能增长而线性膨胀
- ⚠️ 构建步骤（`npm run build`）只做 TypeScript 编译 + `content/` 目录拷贝，**没有前端打包**。

---

## 全局问题汇总

### 严重问题

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | **双重聊天解析器不一致** | `message-parser.ts` vs `claude-pty-bridge.ts` | 同一 PTY 输出可能产生不同消息，导致终端视图和聊天视图内容不同步 |
| 2 | **server.ts 过度膨胀** | `server.ts` ~900 行 | 路由、鉴权、速率限制、Git 查询、PWA、WebSocket 全部耦合在一个文件，难以测试和维护 |
| 3 | **高频持久化无节流** | `process-manager.ts` `persist()` | 每次输出/输入都触发 SQLite 写入 + 文件写入，长会话性能退化 |
| 4 | **PTY 日志无大小限制** | `session-logger.ts` | 长期运行可能填满磁盘 |

### 设计隐患

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 5 | **启发式解析维护成本高** | `claude-pty-bridge.ts` `isStatusLine()` 等 | Claude CLI 更新输出格式时需同步更新解析规则 |
| 6 | **SessionRecord 接口过大** | `process-manager.ts` ~25 个字段 | 单类承担过多职责，不符合单一职责原则 |
| 7 | **前端无构建系统** | `web-ui/` | 所有前端代码必须在单一 JS 文件中，无法使用现代前端工具链 |
| 8 | **自动恢复阻塞启动** | `process-manager.ts` 构造函数 | 扫描 Claude project JSONL 文件可能阻塞服务器启动 |
| 9 | **生命周期定时器精度低** | `session-lifecycle.ts` | 60 秒间隔意味着超时触发有 0~59 秒偏差 |
| 10 | **SessionSnapshot 大对象频繁写入** | `storage.ts` | 长会话的 messages 数组可能很大，每次 persist 都完整写入 SQLite |
| 11 | **Service Worker 版本硬编码** | `server.ts` | 缓存策略更新需要改服务器代码并手动递增版本号 |
| 12 | **速率限制纯内存** | `server.ts` 模块级 Map | 进程重启后丢失，与 SQLite 持久化策略不一致 |

### 小问题

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 13 | `ensureConfig()` 无条件重写文件 | `config.ts` | 即使配置未变更也会触发磁盘写入 |
| 14 | `isRealChatInput()` 过度过滤 | `claude-pty-bridge.ts` | 可能丢弃合法的单字符输入 |
| 15 | 生命周期状态机错误被吞 | `session-lifecycle.ts` | 定时检查中的 try/catch 空实现，状态转换失败无感知 |
| 16 | Schema 迁移缺少旧字段兼容 | `storage.ts` | 加载旧会话快照时可能缺少新字段 |
| 17 | 配置值同时存在于 `config.json` 和 `config` 表 | `config.ts` + `storage.ts` | 密码等值存在两份来源，优先级逻辑不够透明 |

---

## 修复状态

| # | 问题 | 状态 | 修复说明 |
|---|------|------|----------|
| 1 | 双重聊天解析器不一致 | ✅ 已修复 | 创建 `src/pty-text-utils.ts` 共享模块，两个解析器使用同一套 `stripAnsi` 和 `isNoiseLine` |
| 2 | server.ts 过度膨胀 | ✅ 已修复 | 拆分为 `middleware/rate-limit.ts`, `middleware/path-safety.ts`, `ws-broadcast.ts`, `pwa.ts`；server.ts 从 ~1440 行降至 ~944 行 |
| 3 | 高频持久化无节流 | ✅ 已修复 | 添加 `schedulePersist()`（1 秒 debounce）用于热路径，`flushPersist()` 用于关键节点 |
| 4 | PTY 日志无大小限制 | ✅ 已修复 | `session-logger.ts` 添加日志轮转：50MB 自动轮转，最多保留 3 个历史副本 |
| 5 | 启发式解析维护成本高 | 🟡 部分修复 | 噪声检测集中到 `pty-text-utils.ts`，但正则匹配本身仍需随 Claude CLI 更新 |
| 6 | SessionRecord 接口过大 | ⏸ 未修复 | 需要大规模重构，风险较高 |
| 7 | 前端无构建系统 | ⏸ 未修复 | 架构级决策，暂不改变 |
| 8 | 自动恢复阻塞启动 | ✅ 已修复 | 改为 `setImmediate` 异步执行，不再阻塞服务器启动 |
| 9 | 生命周期定时器精度低 | ✅ 已修复 | 添加 try/catch 错误边界，单次会话检查失败不再导致整个定时器停止 |
| 10 | SessionSnapshot 大对象频繁写入 | ✅ 已修复 | `persist()` 改用 `saveSessionMetadata()`（跳过 messages），完整写入仅在 chat.turn 和会话退出时执行 |
| 11 | Service Worker 版本硬编码 | 🟡 已优化 | 已移至独立 `pwa.ts`，便于后续改为配置化 |
| 12 | 速率限制纯内存 | 🟡 已优化 | 已移至独立模块，便于后续接入持久化存储 |
| 13 | `ensureConfig()` 无条件重写文件 | ✅ 已修复 | 比较内容后再决定是否写入 |
| 14 | `isRealChatInput()` 过度过滤 | ✅ 已修复 | 仅对 Claude 会话过滤 y/n，非 Claude 会话不再丢弃 |
| 15 | 生命周期状态机错误被吞 | ✅ 已修复 | `checkSessions()` 添加 try/catch 并记录错误到 stderr |
| 16 | Schema 迁移缺少旧字段兼容 | ✅ 已确认 | 现有 `ALTER TABLE ADD COLUMN ... DEFAULT` 策略安全，映射函数正确处理 null 值 |
| 17 | 配置值两份来源 | ⏸ 未修复 | 影响有限，优先级低 |

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/pty-text-utils.ts` | 共享的 `stripAnsi` 和 `isNoiseLine` 函数 |
| `src/middleware/rate-limit.ts` | 登录速率限制 |
| `src/middleware/path-safety.ts` | 路径安全检查 |
| `src/ws-broadcast.ts` | WebSocket 广播管理（含防抖和背压控制） |
| `src/pwa.ts` | PWA manifest 和 Service Worker 生成 |

### 修复状态变更记录（2026-04-03）

| 变更 | 说明 |
|------|------|
| `claudeSessionId` 窗口 4KB→16KB | 减少启动输出过长时丢失 session ID 的风险 |
| JSONL 跨 session ID 检查修复 | 恢复会话不再被错误拒绝，新增 proximity 降级搜索 |
| 自动恢复异步化 | `setImmediate` 延迟执行，不阻塞服务器启动 |
| 生命周期错误边界 | `checkSessions()` 添加 try/catch + 错误日志 |
| 配置变更检测 | `ensureConfig()` 仅在内容变化时写入 |
| `isRealChatInput` 上下文感知 | 仅 Claude 会话过滤 y/n |
| `runStartupCommands` 同步化 | 移除多余的 async/Promise 包装 |

### 修改的关键文件

| 文件 | 变更 |
|------|------|
| `src/server.ts` | 拆分为多个模块，减少 ~500 行 |
| `src/claude-pty-bridge.ts` | 移除内联 `stripAnsi`/`isStatusLine`，改用共享工具 |
| `src/message-parser.ts` | 移除内联 `stripAnsi`/`isNoiseLine`，改用共享工具 |
| `src/storage.ts` | 新增 `saveSessionMetadata()` 轻量写入 |
| `src/process-manager.ts` | 添加 `schedulePersist()`/`flushPersist()`，`persist()` 改用轻量写入 |
| `src/session-logger.ts` | 添加 PTY 日志轮转逻辑 |
