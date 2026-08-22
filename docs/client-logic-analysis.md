# Wand 客户端操作逻辑

最后更新：2026-08-22

配套文档：`docs/server-logic-analysis.md`（服务端真源）。本文只写**用户在客户端做了什么、客户端怎么调服务端、各端哪里不一致**。查会话执行 bug 仍先看服务端 `SessionRegistry.ownerOf`；查「点了没反应 / 输入错乱 / 列表丢绑定」再看本文。

---

## 1. 客户端有哪些

| 表面 | 形态 | 入口 | 鉴权 |
| --- | --- | --- | --- |
| Web 浏览器 | 服务端渲染 HTML + 内联 JS | `GET /` → `src/web-ui/` | 密码登录，cookie；**browser-admin** |
| macOS App | **原生三栏**（会话 / 聊天 / Inspector），不是纯 WebView。WKWebView 只做嵌入 PTY 和「打开网页版」 | `macos/Wand/MainShellView.swift` | 扫码 appToken → cookie；**connected-app** |
| iOS App | 原生列表 / 聊天 / PTY 壳；WebView 仅网页版兜底 + 嵌入终端 | `ios/Wand/` | 同 macOS；cookie 在 endpoint 级 `SelfSignedSession` |
| Android App | Compose 原生层；WebView 仅网页版。Cookie **不**拷进系统 `CookieManager`（按端口隔离） | `android/` | 同 iOS；进 WebView 前走 `WandWebSession` |
| 浏览器扩展 | MV3 密码库 / 自动填充 | `browser-extension/` | `client:"browser-extension"` 登录拿 appToken，之后 Bearer |
| JSON CLI | `wand session:*` / `inbox:*` / `mission:*` | `src/cli.ts` → `cli-api.ts` | 用 config 密码登录 `127.0.0.1` |

Web 内部还有两层，不要当成两个 App：

- **Legacy**（`src/web-ui/browser/*.ts`）：登录、会话列表合并、WS、聊天渲染、xterm、输入、PTY
- **React**（`src/web-ui/react/`）：Shell、新建会话、设置、工作空间、任务、文件预览/编辑器、快捷提交、worktree 合并

React 通过 `*-adapter.ts` 调 legacy 的 `selectSession` / `refreshAll` / 终端池。回滚：`?reactUi=0` 关整个 React UI/Shell；`?reactShell=0` 只回退 Shell，对话框仍在。

原生壳识别：UA 含 `WandApp/`、`WandPlatform/iOS|Android|macOS`。PTY 嵌入：`?embed=terminal&nativeInput=1&passthrough=1`。

---

## 2. 开机与登录

### Web

```
restoreLoginSession()
  GET /api/session-check          # 不鉴权，避免未登录刷 401
  未登录 → 画登录页
  已登录 → GET /api/config
         → render + startPolling()
         → refreshAll() = GET /api/sessions
         → GET /api/models
         → 如有 APK/DMG 版本号则查更新
```

登录：`POST /api/login { password }`（`credentials: "same-origin"`）→ 立刻 `GET /api/config` 验证 cookie 真存住了。HTTPS 下密码对但 config 401，当成证书不被信任，提示导入 `/cert/server.crt`。

登出：`POST /api/logout`，清 `state.config` / sessions / 终端。

### 原生 / macOS

1. 扫设置页二维码：`GET /api/app-connect-code` → `base64(url#appToken)`
2. `POST /api/login { appToken }` → connected-app cookie
3. 之后 REST 带 cookie；**WS 只认 cookie**（Bearer 是后来补的，旧包仍靠 cookie）
4. macOS `WandAuth.loginWithToken` 把 Set-Cookie 写进 `WKHTTPCookieStore` 再 load `GET /`
5. 扩展：`{ password, client: "browser-extension" }` → `{ appToken, serverUrl }`，`serverUrl` 现为**当前请求 origin**

原生没有 admin。`POST /api/update`、改部署项、上传证书会 **403**。扫码进 App 后看到的「服务端可更新」横幅若去装 npm 包，会失败。connected-app 只能改 session 偏好（默认 provider / 模型 / 模式 / kind / thinking）。

冷启动 cookie 是空的：iOS `NativeRootView.authenticate()`、Android `WandApp` 每次进程起来都会用存着的 appToken 再 login 一次。REST 401 同样静默重登再试。裸 URL（没 token）先探 `session-check`，401 就提示用连接码。

---

## 3. 会话列表与选中

| 端 | 拉列表 | 选中 |
| --- | --- | --- |
| Web | `GET /api/sessions`（`loadSessions`），和本地 `state.sessions` 做 `mergeServerSession` | `selectSession(id)`：拆旧终端、清队列、拉详情、`subscribe` |
| iOS / Android / macOS | 主路径 `GET /api/session-list?offset&limit&revision`（10s 轮询）。404 才回退 `GET /api/sessions` + 各 `*-history` | structured → Chat；否则 PTY 页 |
| Web 侧栏目录 | `GET /api/session-directories`，改名 `PUT /api/session-directories/name` | 点目录项仍 `selectSession` |

`mergeServerSession` 会保住比服务端更长的本地 output / 未完成 assistant 占位（`__processing`），避免列表刷新把正在流的一轮打回「已结束」。

选中后 Web 再 `GET /api/sessions/:id?format=chat`（`loadOutput`），structured 才要消息窗。列表 DTO 没有 messages/output。

标题以服务端 `title` 为准（`resolveSessionDisplayTitle`）。`titleGenerating` 只用于动画。

---

## 4. 新建会话

两条创建入口，打的不是同一个 API。

### 4.1 通用「新对话」

React `new-session/repository.ts`：

| 用户选 | HTTP |
| --- | --- |
| 结构化 | `POST /api/structured-sessions`（cwd / mode / provider / runner / model / thinkingEffort / worktreeEnabled） |
| 终端 / 指定 CLI | `POST /api/commands`（command / provider / cwd / mode / cols / rows） |
| 纯 shell | `POST /api/commands { shell: true }` |

创建成功后 adapter `selectSession(id)`。PTY 创建前 `ensureTerminalReady()`，把当前 xterm 的 cols/rows 带上。

这条路径**不传** `workspaceId` / `workspaceTaskId`。服务端按 cwd find-or-create 项目。

同一套 API 还有几条旁路，不要漏：

| UI | 函数 | 实际打的接口 |
| --- | --- | --- |
| 欢迎页 / 空会话直接回车 | `sendOrStart` / `createSessionFromInput` | `POST /api/commands`，带 `initialInput` |
| 一键 Claude / Codex | `quickStartSession` | `POST /api/commands`（PTY，无首条） |
| 跨会话排队冲刷（PTY） | `launchQueueItem` | **新开** `POST /api/commands`，不续旧会话 |
| 跨会话排队冲刷（structured） | `continueStructuredSession` | 原会话 `POST .../messages` |

### 4.2 工作空间任务里的「+」

`session-engine.startSessionInCwd`：**只打** `POST /api/commands`（PTY），显式带 `workspaceId` / `workspaceTaskId`，cwd 用任务 worktree。

并行多 provider 是前端连开多个 session，不是 `POST /api/missions`。

### 4.3 原生

iOS / Android 新建页同样按 kind 打 structured 或 commands，并在任务上下文里带 binding。Qoder 命令名要写成 `qodercli`（服务端也会把裸 `qoder` 改掉）。

---

## 5. 实时通道

所有会盯着某一会话的客户端都走 `/ws`（cookie）。

### Web `websocket.ts`

- `startPolling()` 优先 `initWebSocket()`，失败才 1.6s HTTP 轮询
- 连上后对当前选中会话 `subscribe`；分屏池里的 PTY 用 `mode: "add"` + `capabilities.ptyAck: true`
- 服务端 20s ping；浏览器 10s 检查，40s 无帧则 `forceReconnectWebSocket`
- 切后台不重连，回前台强制重连
- `resync` / `resync_required` → 再拉 init，终端走 `softResyncTerminal`

消息合流（iOS `ChatStore` 注释与此对齐）：

| 事件 | 聊天 | 终端 |
| --- | --- | --- |
| `init` | 用详情 DTO 整表替换 | 恢复 `terminalState` 或全量 output |
| `output` + `messages` | 替换 | 忽略聊天字段 |
| `output` + `incremental` + `lastMessage` | 末条同 role 则替换，否则按 `messageCount` 追加 | 忽略 |
| `output` + `chunk` | **忽略**（避免 TUI 垃圾进聊天） | `wandTerminalWrite` / 池终端 |
| `status` | 权限、mode、model、`providerCliActive`、`titleGenerating` | resize 校准 |
| `ended` / `notification` | 停转圈、系统重启/更新条 | 壳保活时会话仍 running |

系统通知 `sessionId: "__system__"`：restart / update / auto-update-*。

Web 还盯 `seq`：`init` 校准，`output` 必须 `prev+1`，跳号就 `resync` 并丢弃该帧。`loadOutput` 在 WS 已连上时**不会**把 HTTP 全文写进 xterm（磁盘 transcript 远大于 WS 环形缓冲，双写会重画一段）。HTTP 详情只管聊天 messages 和元数据。

### 原生

- 每个详情一个 `WandSocket`，`subscribe { sessionId }`
- **只有 iOS** 带 `blockBudget: 60`，详情也带 `?format=chat&blockBudget=60`，并可按块翻 `GET .../messages?turn&blockOffset`
- Android / macOS 仍是 turn 窗口，不传 `blockBudget`
- Android `SessionWatcher`、iOS 系统 socket：一条**不订阅**的全局 WS，只吃 `notification` / 列表动态（依赖服务端对未订阅连接仍广播非 raw-PTY 事件）
- Android ChatStore **先 REST 快照再连 WS**；iOS 立刻连
- PTY 页：原生顶栏 + `embed=terminal&nativeInput=1` WebView + 原生底栏
- macOS 的 `SessionSnapshot` **没有**解析 `title` / `titleGenerating` / `workspaceId` / `workspaceTaskId`，标题只能从 `summary` 凑，聊天顶栏没有生成中动画

---

## 6. 发送输入（最容易写错的契约）

先看 `sessionKind`。

### 6.1 Structured

| 端 | 行为 |
| --- | --- |
| Web | `POST /api/structured-sessions/:id/messages`，或统一 `POST /api/sessions/:id/input`。进行中则入队（最多 10，重复 409） |
| iOS / Android | 乐观插入 user turn；`respondImmediately: true` 拿 202，不阻塞等整轮。进行中则本地先推进队再 POST |

AskUserQuestion：选项存在客户端 `askUserSelections`（流式会重建 DOM，不能放组件 state）。提交时把答案当下一轮 input（服务端会包成 tool_result）。

中断：`POST .../messages { interrupt: true }`。Web 上 Cmd/Ctrl+Enter 或队列「立刻发送」走这条；摇杆 Ctrl+C / Esc 对 structured 是 `{ input:"", interrupt:true, preserveQueue:true }`，对 PTY 是往终端写 `\x1b`。

Web 结构化还有同会话队列条：删一条 / 清空 / 提升 / 拖拽排序，分别打 `DELETE/PATCH/POST .../queued*`。`queuedMessages` 以服务端为准；本地有 `queueEpoch`，过期 HTTP 回包会被剥掉队列字段。

Claude SDK 的 skills 勾选只活在 `state.selectedClaudeSkillsBySession`，下次 send 才放进 body。不写进 Snapshot。

### 6.2 PTY — 必须「文本」再「回车」

服务端 `sendInput` 原样写入 PTY。客户端负责拆包，**不要** `text + "\n"` 代替回车。

**Web 终端 / 聊天提交 PTY**（`getTerminalSubmitChunks`）：

```
[text, "\r"]
```

终端视图优先走 WS `pty_input`（低延迟）；聊天视图或 WS 未开则 `POST /api/sessions/:id/input`，`view: "chat"|"terminal"`，最后一包带 `shortcutKey`。

**iOS**（`sendPtyInput`）：HTTP 两包，中间 30ms；文本与 `\r` 进同一条 `ptyInputTail` 队列，快捷键不能插进两者之间。`shortcutKey` 回车为 `enter_text`。已结束的 PTY 先 `POST /api/sessions/:id/resume`。

**Android 原生 PTY 页**（`PtyTerminalScreen.sendPtyDraft`）：与 iOS 相同，文本再 `\r` + `enter_text`。

**Android / macOS / iOS 的聊天页对 PTY**（以及 AskUser 在 PTY 上的提交）仍有 `text + "\n"` 旧路径。Android 聊天页实际只开 structured，这条多半是死代码，但 AskUser 若落到 PTY 仍会踩。

其它差异：

- iOS 两包 input 带 `responseMode: "accepted"`，不等整份 snapshot
- macOS 两包都走完整 `sendInput`（解码整份 snapshot），更重
- Android structured 发送后**不**把 202 snapshot `apply`、也不 `requestResync`（iOS 会）
- iOS `isResponding` 把 PTY 的 `running` / `providerCliActive` 也算进去；Android / macOS 只看 structured `inFlight`

快捷键（Ctrl-C 等）只发控制字符，不附带假回车。`shortcutKey` 用于服务端 shortcut 日志，不是协议必填，但回车应标 `enter_text` 以便自动 resume 认出「真文本提交」。

### 6.3 离线

Web 把 PTY 按键缓存在 `pendingMessages`（最多 100，TTL 5s），重连后回放。超过 TTL 丢弃，避免把过期按键打进新提示符。

---

## 7. 权限、模式、模型

### 权限

只对 **Claude PTY** 有运行时弹窗。

- Web：`status.permissionBlocked` / `pendingEscalation` → 批准 / 拒绝 / 本轮记住 → `POST .../approve-permission` | `deny-permission` | `escalations/:id/resolve`
- iOS / Android：同样 HTTP；无结构化 escalation 时退回旧 `permissionBlocked` 条
- Structured：客户端不应画批准条。服务端现对这类路由回 404
- Codex PTY：客户端应禁用批准（服务端 400）

`toggle-auto-approve` 只影响 Wand 侧自动回车，改不了已经 spawn 出去的 CLI flag。换 mode 中途同样如此。

### 模型 / 思考 / 模式

`POST /api/sessions/:id/{model,thinking-effort,mode}`。

- Structured：下一轮 spawn 生效
- PTY Claude：额外往终端打 `/model`、`/effort`
- Web 用 mutation 队列，避免连点乱序
- iOS 用 revision，丢弃过期回包，防止旧 snapshot 盖掉刚选的模型

---

## 8. 恢复、停止、删除

| 用户动作 | 客户端 | 服务端 |
| --- | --- | --- |
| 继续已结束的 PTY | `POST /api/sessions/:id/resume` | 同 id 重拉 CLI，`reuseId` |
| 从原生历史恢复 | `POST /api/{claude,codex,opencode,qoder,grok,pi}-sessions/:id/resume` | Claude → PTY；其它 → 新 structured 壳，不导入历史 |
| 对已结束 PTY 再打字 | iOS 先 resume；服务端 input 路由也会自动 resume | 文本当 `initialInput` |
| 停止 | `POST /api/sessions/:id/stop` | PTY 杀进程；structured 回 idle |
| 删除 | `DELETE /api/sessions/:id` | 拆 worktree + 尽量删原生历史 |

Web 侧栏仍会打 `GET /api/claude-history` 等。这些 GET **恒为 `[]`**，删除 hide 仍可用。不要把空列表当「没有历史文件」。

---

## 9. 工作空间

数据：项目（cwd）→ 任务（可选独立 worktree）→ 窗口布局树（session / editor / preview）。

Web：

1. `GET /api/workspaces`（服务端会 backfill 孤儿会话）
2. 打开项目：只改 `state.activeWorkspaceId` + React context，**不开会话**
3. 建任务：`POST /api/workspaces/:id/tasks`
4. 任务里加会话：`startSessionInCwd`（PTY + binding）
5. 分屏：`PUT /api/workspace-tasks/:id/layout`；多 PTY 用 `terminal-pool`，subscribe `mode:add`
6. 合并：`POST /api/sessions/:id/worktree/merge/check` → `merge` → `cleanup`

iOS / macOS：`WorkspaceStore` 对齐上述 REST，含建项目、worktree 总览、合并 agent。任务里加窗仍是 `POST /api/commands` + binding（**只开 PTY**）。

Android 窄一截：能列项目/任务、改任务、存 layout、在任务里开 PTY/shell 窗。**没有**原生建/改/删项目、没有 worktree 总览、没有合并 agent。

列表 DTO 现已带 `workspaceId` / `workspaceTaskId`。客户端分组应信这两个字段，不要只靠 cwd。

---

## 10. Missions / Inbox

编排在服务端 `Missions`，只跑 structured。

| 操作 | API |
| --- | --- |
| 列表 / 创建 | `GET/POST /api/missions` |
| 看 diff | `GET .../attempts/:id/diff` |
| 写评论 / 发给 agent / 标记已解决 | `POST .../comments`、`.../review/send`、`.../review/resolve` |
| Inbox | `GET /api/inbox`（`agent_activity`）；`POST /api/inbox/read` |
| CLI | `wand mission:*`、`wand inbox:list` |

Web React `missions/` 走 missions 路由，**不会打** `/api/inbox`。侧栏「任务」打开的是 Missions 叠层，不是 inbox。Inbox 目前是 CLI / JSON（`wand inbox:list`）和原生若自行封装的表面。

macOS 有原生 `MissionsView`。iOS / Android 也有 mission 模型，能力以各端 API 封装为准。

创建任务后「打开会话」只是 `selectSession(attempt.sessionId)`，叠层自己不发聊天。

---

## 11. 文件、Git、设置

### 文件

Web 文件面板 / 预览 / 编辑器：

- 列目录 `GET /api/directory`，预览 `GET /api/file-preview`，原文 `GET /api/file-raw`
- 写 `POST /api/file-write`，创建/改名/删另有路由
- 上传 `POST /api/sessions/:id/upload` → `<cwd>/.wand-uploads/`
- 搜索 `GET /api/file-search?q=&cwd=`（cwd 为搜索根，不再锁 `process.cwd()`）

编辑器未保存草稿只在浏览器。切预览会确认丢弃。

### 快捷提交

挂在当前会话 cwd：`GET .../git-status`、`POST .../quick-commit`、`generate-commit-message`、`git/tag-head`、`git/push`。Web / iOS / Android 共用同一套 REST。

### 设置

- 读启动配置：`GET /api/config`
- 完整设置：`GET /api/settings`（admin）
- 改偏好：`POST /api/settings/config`（connected-app 只能改默认 provider/model/mode/kind/thinking）
- 模型目录：`GET /api/models`（客户端不自己探 CLI）
- 提示词优化：`POST /api/optimize-prompt`
- 更新：admin `GET/POST /api/update*`；Android `GET /api/android-apk-update?channel=`；macOS `GET /api/macos-dmg-update`；iOS 无更新接口

---

## 12. 只活在客户端的状态

服务端 `SessionSnapshot` **没有**这些东西：

| 状态 | 在哪 |
| --- | --- |
| 输入草稿 / 附件 | `state.drafts`、`attachmentsBySession` |
| 跨会话排队 | `state.crossSessionQueue`（`wand-cross-session-queue`，最多 10） |
| Claude skills 勾选 | `state.selectedClaudeSkillsBySession` |
| 聊天贴底、未读、AskUser 选项 | `chatStickToBottom`、`askUserSelections` |
| xterm 实例与本地 fit | `state.terminal`、`terminal-pool`、cols/rows 回写服务端 |
| 侧栏开合、当前视图 chat/terminal | localStorage + `state.currentView` |
| 当前工作空间（未写进 URL） | `wand-active-workspace` |
| React feature flags | query / `localStorage`，默认开 |
| 扩展 vault 的本地缓存 | 扩展 storage |

重载页面会丢草稿和 AskUser 未提交选择；会话本身在 SQLite / daemon。

---

## 13. 平台能力对照

| 能力 | Web | macOS | iOS | Android | 扩展 |
| --- | --- | --- | --- | --- | --- |
| 主体身份 | browser-admin | connected-app | connected-app | connected-app | Bearer + password-vault |
| 结构化聊天 | 完整 | 原生 `ChatView` | 原生完整 | 原生完整 | 无 |
| PTY 终端 | xterm / 分屏池 | 嵌入 WebView + 原生底栏 | 原生壳 + 嵌入 WebView | 同左 | 无 |
| PTY 回车拆包 | 文本 + `\r` | 终端正确；聊天旧路径 `\n` | 终端正确；AskUser 仍 `\n` | **PTY 页正确；ChatStore 仍 `\n`** | — |
| WS 窗口 | turn；可 `mode:add` | turn；单订阅 | **blockBudget=60**；单订阅 | turn；单订阅 | — |
| `titleGenerating` | 有 | **模型没解析** | 有 | 有 | — |
| 工作空间 | 完整分屏 | 完整 + 合并 agent | 完整 + 合并 agent | 仅任务窗，无建项目/合并 | 无 |
| Missions | React（不打 inbox） | 原生 | 原生 | 原生 | 无 |
| 文件树 | React | **原生** FilePanel | 网页兜底 | 网页兜底 | 无 |
| 客户端更新 | `/api/update`（admin） | GitHub ZIP/DMG + 可选服务端 DMG | 无 IPA 更新 | `/api/android-apk-update` | 无 |
| 装服务端 npm 包 | 设置页（admin） | 横幅会 403 | 横幅会 403 | 横幅会 403 | — |
| 语音 | 无 | 无 | SFSpeech | sherpa + 系统兜底 | 无 |
| 密码库 | 无 | 无 | 无 | 无 | 全部 |

---

## 14. 操作 → 模块 → API（速查）

| 用户操作 | Web 模块 | API |
| --- | --- | --- |
| 打开站点 | `render.restoreLoginSession` | `GET /api/session-check` → `/api/config` |
| 登录 | `session-engine.login` | `POST /api/login` |
| 刷列表 | `loadSessions` | `GET /api/sessions` |
| 点开会话 | `selectSession` | `GET /api/sessions/:id` + WS `subscribe` |
| 新建 structured | `react/new-session` | `POST /api/structured-sessions` |
| 新建 PTY / shell | 同上 / `startSessionInCwd` | `POST /api/commands` |
| 聊天发送 | `input.sendInputFromBox` | structured `.../messages`；PTY `.../input` 或 WS `pty_input` |
| 终端打字 | xterm → `queueDirectInput` | WS `pty_input` |
| 批准权限 | 聊天卡片 | `POST .../approve-permission` |
| 换模型 | composer trio | `POST .../model` |
| 工作空间开任务 | `workspaces-adapter` | `POST /api/workspaces/:id/tasks` |
| 合并 worktree | `worktree-merge` | `POST .../worktree/merge` |
| 快捷提交 | `quick-commit` / `git-commit` | `POST .../quick-commit` |
| 设置 | `react/settings` | `GET/POST /api/settings*` |

---

## 15. 查客户端问题怎么走

1. 先确认端：Web legacy / Web React / iOS / Android 聊天 / Android PTY / macOS WebView。
2. 确认 `sessionKind`。structured 的块、队列、中断与 PTY 的刮字、权限、回车不是同一条路。
3. 输入类：对照 §6。Android 聊天页对 PTY 仍可能发 `\n`。
4. 列表缺项目绑定：看 DTO 是否带 `workspaceId`（服务端已补），以及创建时走的是通用新建还是 `startSessionInCwd`。
5. 「思考中转个不停」：看 `mergeServerSession` 是否在保本地 `inFlight`，以及 WS `activeRequestId` 是否还对得上。
6. 嵌入终端乱码：先查 cols/rows 和 `embed=terminal` 的 CSS fit，不是 UTF-8。
7. 原生能 REST 不能 WS：旧客户端没 cookie；新服务端已接受 Bearer，旧包仍要先 login。
8. 原生点「更新服务端」403：connected-app 不是 admin。App 自己的 APK/DMG 更新走另一条公开/会话接口。
9. macOS 标题不闪、工作空间绑不上聊天顶栏：原生 `SessionSnapshot` 还没解析 `title` / `titleGenerating` / `workspaceId`。
10. `CLAUDE.md` 仍写 macOS 是纯 WebView 壳，已经过时；以 `MainShellView` 为准。

服务端行为以 `docs/server-logic-analysis.md` 为准。两端对不上时，以服务端契约改客户端，不要在 PTY bridge 里伪造 tool block。
