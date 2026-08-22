# Wand 服务端逻辑分析

最后更新：2026-08-22

范围：`src/` 服务端（CLI、Express、两套 session runner、terminal daemon、存储、workspace / mission、更新）。客户端怎么点、怎么发输入见配套文档 `docs/client-logic-analysis.md`。后续优化排期见 `docs/optimization-plan.md`。

用途：后续下钻和排期。查任何会话 bug，**先看 `SessionRegistry.ownerOf(id)` 是 `structured` / `pty` / `storage`**，再进对应 manager。查「点了没反应 / 回车没提交 / 列表丢绑定」先看客户端文档。

---

## 1. 它是什么

`wand` 是本机 AI CLI 的 Web 控制台。一个 Node 进程（`src/cli.ts` → `src/server.ts`）同时做四件事：

1. Express HTTP + `/ws`，给浏览器 / 原生客户端 / JSON CLI 用
2. **PTY runner**（`ProcessManager`）跑交互式终端（Claude / Codex / … TUI 或纯 shell）
3. **Structured runner**（`StructuredSessionManager`）跑非交互流式会话
4. SQLite + 文件制品持久化

PTY 不在 web 进程里：默认由独立的 `wand terminald` 持有，所以 `wand web` 重启 / 自更新不会杀掉正在跑的 shell。

两套 runner **共享类型和存储，不共享执行、权限、恢复代码**。

---

## 2. 进程模型与 CLI

入口只有 `src/cli.ts`。全局 `-c/--config` 决定整套数据目录（默认 `~/.wand/`）。

| 命令 | 作用 |
| --- | --- |
| `init` | 建 config + SQLite，首次生成随机密码 |
| `web` | 启动服务，或 attach 到已有实例 |
| `terminald` | PTY 守护进程（通常由 web 自动拉起） |
| `config:path` / `show` / `password` / `set` | 配置读写。密码和偏好写 DB，部署项写 JSON |
| `session:list` / `read` / `send` / `wait` | 对本地 HTTP 的 JSON 封装，**需要已在跑的 web** |
| `mission:list` / `create` / `diff` / `review` / `review:send` | 同上 |
| `service:install` / `uninstall` / `start` / `stop` / `restart` / `status` / `logs` | systemd / launchd |

`wand inbox:list` 现已实现，对应 `GET /api/inbox`。

### `wand web` 启动顺序

```
resolveConfigPath
  → shouldUseTui()          # WAND_NO_TUI / 非 TTY / Windows 无 WT_SESSION → banner
  → loadConfig + 建 DB
  → discoverAttachableInstance(pidfile + wand.sock)
       已有实例 → attach TUI 或打印 URL 后退出
  → ensureNodePtyHelperExecutable()
  → startServer()
       EADDRINUSE → 再尝试 attach / 探测是否本服务占用
  → 写 pidfile + 开 IPC
  → TUI 或一行 banner
```

单实例按 **config 路径** 隔离，不是全局一个。Windows 没有 unix socket，attach 不可用。

`shouldUseTui()`：`WAND_NO_TUI` 有值、stdout/stderr 非 TTY、或 Windows 且没有 `WT_SESSION` → 不用 TUI。服务 unit 一律带 `WAND_NO_TUI=1`。

---

## 3. 组合根：`startServer()` 造了什么

`src/server.ts` 是唯一组合根。构造顺序（有依赖）：

```
repairRuntimePath + deepRepairRuntimePath     # 服务 PATH 过期兜底
express + WandStorage
RuntimeConfigState                            # 热更偏好 vs 需重启的部署项
AuthService
ModelCatalogService                           # 全服唯一模型发现者
DistributionManager                           # APK/DMG
createTerminalHost()                          # 领养或拉起 terminald
ProcessManager                                # PTY
SessionLogger + StructuredSessionManager
SessionRegistry                               # 统一查找
Missions                                      # 只调度 structured
HTTP(S) + WebSocketServer + WsBroadcastManager
```

事件接线：

```
ProcessManager "process"  ──┐
                            ├─→ Missions.ingest
StructuredSessionManager ───┘   WsBroadcastManager.emitEvent
```

WS 回写 PTY 只走 `ProcessManager`：`sendInput` / `resize` / `pauseOutput` / `resumeOutput`。

构造函数里就会恢复会话，**listen 之前**：

- PTY：对 `status === running` 的记录 `terminalHost.attach`。daemon 还活着就重绑；死了 / 丢了就标 exited/failed，累加 `orphanRecoveredCount`
- Structured：任何 `running` **强制打回 `idle`，`inFlight = false`**。进行中的一轮不会跨 web 重启存活

启动后（非 `WAND_TEST_MODE`）：跑 `startupCommands`、模型目录 30 分钟刷新、npm / provider-CLI 自动更新定时器。

环境开关：

| 变量 | 作用 |
| --- | --- |
| `WAND_NO_TUI` | 强制 banner |
| `WAND_TEST_MODE=1` | 进程内 PTY，跳过启动命令 / 模型刷新 / 更新检查 |
| `WAND_DISABLE_UPDATE_CHECK=1` | 只关更新检查 |
| `WAND_PATH_REPAIR_DISABLE` / `_DEEP_DISABLE` | 关 PATH 自修 |
| `INVOCATION_ID` / `XPC_SERVICE_NAME=com.wand.web` | 托管重启时只退出、不 spawn |

---

## 4. 配置与四类状态

状态分四个桶，不要混用：

| 桶 | 放哪 | 例子 |
| --- | --- | --- |
| 部署 / 启动 | `config.json`（0600，原子写） | `host/port/https/tls/shell`、`startupCommands`、`allowedCommandPrefixes`、APK/DMG 目录 |
| 偏好 | SQLite `app_config` 的 `pref:*` | 默认 provider / 模型 / 模式、`systemAi`、语言、`inheritEnv` |
| 密钥 | SQLite | `password`、`appSecret`（绝不回写 JSON） |
| 大件 / 运行时 | 文件或 daemon 内存 | PTY 日志、worktree、上传、daemon 里的 PTY |

`loadConfigWithStorage()`：读 JSON → 把老 JSON 偏好 / 密码迁到 DB（仅当 DB 还没有）→ 合并默认值 → 用 DB 覆盖 → 调和 `appSecret` → 必要时把 JSON 里残留的偏好 / 密钥剥掉再写回。

`RuntimeConfigState`：`host/port/https/shell` 改了要重启；偏好热生效。

---

## 5. 鉴权

两种主体：

| Principal | 怎么拿到 | 权限 |
| --- | --- | --- |
| `browser-admin` | 密码登录 | `admin`（隐含全部） |
| `connected-app` | `appToken` 登录或 `Authorization: Bearer` | `sessions` + `files` + `password-vault` + `session-preferences` |

密码以 DB 为准（`storage.getPassword() ?? config.password`）。首次 `init` 会生成随机密码。改密码会吊销全部 cookie 会话并踢掉所有 WS。

Cookie（12 小时，httpOnly，SameSite=strict）：

- HTTPS：`__Host-wand_session` + 兼容名 `wand_session`
- HTTP：`wand_session_local` + `wand_session`

分名字是为了躲浏览器 Strict Secure Cookies：HTTPS 留下的 Secure cookie 会挡住同名 HTTP Set-Cookie。

`appToken` = `HMAC-SHA256(appSecret, password)` 的 hex。改密码或 `appSecret` 会让所有二维码 / 扩展 token 失效。`POST /api/login` 带 `client:"browser-extension"` 时额外返回 `{ appToken, serverUrl }`。

登录限流：每 IP 15 分钟 10 次失败（内存）。

**WS 只认 cookie，不认 Bearer。** 原生客户端必须先 login 拿 cookie，才能连 `/ws`。

公开、不鉴权：`/`、vendor、`/api/login`、`/api/logout`、`/api/session-check`、头像、APK/DMG 检查与下载、HTTPS 下的 `/cert/server.crt`。

之后所有 `/api/*` 先 `requireAuth`，再按前缀套 scope。下列路由只要求「已登录」，不在 sessions / files 前缀名单上：

- `GET /api/session-list`
- workspace 全家
- `POST /api/file-create` / `dir-create` / `file-rename` / `file-delete`
- `GET /api/quick-paths` / `validate-path` / `file-search`
- `POST /api/opencode-sessions/:id/resume`、`/api/qoder-sessions/:id/resume`

当前只有两种 principal，connected-app 已带 `sessions` + `files`，所以多数不是立刻可利用的越权。这是防御深度缺口，不是现网必炸洞。

---

## 6. HTTP 表面

没有 `Router`，全部挂在同一个 Express `app` 上。中间件顺序：

1. 路由级 JSON 限额（optimize-prompt 256kb、file-write 2mb）再全局 1mb
2. compression
3. 关服时 503
4. 浏览器扩展 CORS
5. 公开路由 → `requireAuth` → scope → 业务路由
6. `jsonErrorHandler`

### 6.1 会话

| 路径 | 含义 |
| --- | --- |
| `POST /api/commands` | 开 **PTY**（`shell:true` 则纯 shell） |
| `POST /api/structured-sessions` | 开 structured（可带首条 prompt） |
| `GET /api/sessions` / `/api/session-list` | 列表。后者分页 + revision 冲突 409 |
| `GET /api/sessions/:id` | 详情 DTO。`?format=chat` 才带消息窗 |
| `POST /api/sessions/:id/input` | 统一输入：structured 走队列 / 中断；PTY 可自动 resume |
| `POST /api/sessions/:id/{model,thinking-effort,mode}` | 写到 owner manager |
| structured 的 `messages` / `queued*` | 队列、提升、清空 |
| `resume` / `claude-sessions` / `codex-sessions` / `opencode-sessions` / `qoder-sessions` | 各 provider 恢复入口不同 |
| `approve/deny-permission`、`escalations/:id/resolve` | **实际只对 Claude PTY 有用** |
| `stop` / `DELETE` / `batch-delete` | stop：PTY 杀进程；structured 回到 idle |
| git / worktree / upload / tool-content | 挂在 session cwd 上 |

列表 DTO 剥掉 `output` / `messages`。详情用 `src/session-transport.ts`：标题由服务端裁定（title → description → summary → 目录名 →「会话」），output 截到 20 万字符，消息默认 40 turn 窗口。

`sessionBase()` **没有**带上 `workspaceId` / `workspaceTaskId` / `queuedMessageSkills` / `titleGenerating`。列表和多数详情响应会丢掉这些字段。

`POST /api/commands` 和部分 PTY 权限 / resume 仍返回**裸 `SessionSnapshot`**，和 DTO 路径不一致。

Provider history 的 **GET 全是空数组**（不再把原生历史灌进列表）。DELETE / hide 仍有效（删文件 + `hidden_claude_session_ids`）。

没有 grok / pi 的独立 history / resume 路由；它们走通用 `/api/sessions/:id/resume`。

### 6.2 文件

目录列表、预览、原文 range、写入、创建、重命名、删除、搜索、最近路径、快捷路径。`/etc` `/root` `/boot` 被挡。`file-search` **锁在 `process.cwd()` 下**，不是 session cwd。

上传：`POST /api/sessions/:id/upload`，最多 5 个、每个 10MB，写到 `<cwd>/.wand-uploads/`。

### 6.3 设置 / 模型 / 提示词

`/api/config` 给客户端启动用（无密码）。`/api/settings*` 管部署 + 偏好。`/api/models` 只读缓存；刷新是 admin。`/api/optimize-prompt` 是一次性改写，不是会话。`/api/claude-skills?cwd=` 扫 `~/.claude/skills` 和项目 skills。

---

## 7. WebSocket `/ws`

同一 HTTP(S) 服务器，path `/ws`，maxPayload 256KB（只收控制消息）。

客户端 → 服务端：

| type | 作用 |
| --- | --- |
| `subscribe` | 订阅会话。默认替换全部；`mode:"add"` 叠加上（分屏）。可带 `blockBudget`、`capabilities.ptyAck` |
| `unsubscribe` / `resync` | 退订 / 要全量 init |
| `pty_input` / `pty_resize` | 必须已订阅。输入上限 128KB |
| `pty_ack` | 流量控制：未确认字节 >512KB 暂停 PTY，<128KB 恢复 |
| `pong` | 心跳 |

服务端 → 客户端：`init`、`error`、`pty_error`、`resync_required`、`ping`，以及 `ProcessEvent`：

```
type: output | status | started | ended | usage | task | notification
sessionId, data?, seq?   # seq 只打在 output 上，用来发现丢包
```

系统通知用 `sessionId: "__system__"`（restart / update / auto-update-*）。

Output 16ms 防抖。每客户端队列上限 500，超了**丢掉 output** 并在排空后发 `resync_required`。未订阅的会话收不到原始 PTY 块。心跳 20s，45s 无帧则掐连接。

---

## 8. 会话数据模型

核心类型在 `src/types.ts`。

```
SessionKind     = pty | structured
SessionProvider = claude | codex | opencode | grok | qoder | pi
SessionRunner   = claude-cli | claude-cli-print | claude-sdk
                  | codex-cli-exec | opencode-cli-run | grok-cli-headless
                  | qoder-cli-print | pi-cli-json | pty
ExecutionMode   = assist | agent | agent-max | default | auto-edit
                  | full-access | native | managed
```

`SessionSnapshot` 两边共用。要点：

- `status`：`idle | running | exited | failed | stopped`。**没有** `thinking` / `waiting-input`；那些由 `inFlight`、`permissionBlocked`、`isResponding` 暗示
- `claudeSessionId` 名不副实：Claude UUID、Codex thread、OpenCode `ses_*`、Grok/Qoder UUID 都塞这里
- `providerCliActive`：PTY 上 CLI 是否还占着终端；CLI 退后会话仍 `running`（底下是 login shell）
- `structuredState`：`{ provider, runner, model, lastError, inFlight, activeRequestId }`
- `queuedMessages` 只属于 structured
- `pendingEscalation` 实际只属于 Claude PTY

`ConversationTurn` = user/assistant + `text | thinking | tool_use | tool_result`。PTY 聊天是对 TUI 文本的启发式投影，**没有 tool block**；结构化路径才有完整块模型。

`SessionRegistry` 查找顺序：structured 内存 → PTY `getOwned` → SQLite。列表同序去重，按 `startedAt` 降序。删除时先尽力拆 worktree。

归档：两边都是每 60s 扫，非 running 且结束超过 **24h** 标 archived。PTY 还有硬顶：会话数 ≥200 时删 7 天以上的已归档。

`src/session-lifecycle.ts` **不存在**。生命周期散落在两个 manager 里。

---

## 9. 两套 runner

### 9.1 PTY：`ProcessManager`

入口：`POST /api/commands` → `start()` / `startShell()`。

启动：

1. 非 shell 要过 `allowedCommandPrefixes`；拒绝未引号的 `; | & < > \` $()`
2. cwd 必须是已存在目录
3. 可选 worktree → cwd 变成 `.wand-worktrees/...`
4. Codex PTY **强制 `full-access`**
5. `processCommandForMode` 注入模型 / 思考 / 权限 flag
6. Grok/Qoder 预先分配 `--session-id`（TUI 抓 ID 不可靠）
7. `buildPtyShellLaunchPlan` 包一层 POSIX wrapper
8. 先落库 `running`，再 `terminalHost.createOrAttach`
9. Claude 且 CLI 仍活跃 → 挂 `ClaudePtyBridge`
10. 有 `initialInput` 就等提示符或 3s，再写 `input+\r`

**Shell 保活**（`pty-shell-launch.ts`）：provider + POSIX shell 时，CLI 在 wrapper 里跑完后打印 `\x1eWAND_CLI_EXIT:<token>:<code>\x1f`，再 `exec` login shell。会话保持 `running`，用户可以继续敲命令。非 provider 命令走 `shell -lc`，命令死 PTY 就死。

输入：必须 running。聊天视图会触发标题生成。客户端约定是**先发文本再单独发 `\r`**，不要用 `text+"\n"` 代替回车。

权限（**仅 Claude PTY**）：

- 模式 `full-access | auto-edit | managed | native` 或 root → 自动批准
- 否则 bridge 扫 TUI 文本，设 `pendingEscalation`，UI 回 `\r` 或 `n\r`
- Codex PTY 没有权限 UI

`stop()` 立刻杀 PTY → `stopped`。`dispose()`：持久 daemon 只解绑不杀；进程内 host 才杀。

### 9.2 Structured：`StructuredSessionManager`

`createSession` 只建 **idle** 行，第一条消息才 spawn。

Runner 选择：

| Provider | Runner |
| --- | --- |
| Claude | `config.structuredRunner === "sdk"` → `claude-sdk`，否则 `claude-cli-print` |
| Codex | `codex-cli-exec` |
| OpenCode | `opencode-cli-run` |
| Grok | `grok-cli-headless` |
| Qoder | `qoder-cli-print` |
| Pi | `pi-cli-json` |

`sendMessage`：

- 已在飞：可 `interrupt`（记下 prompt，杀进程，结束后重发）；否则入队，最多 10 条；重复文本 409
- 否则追加 user turn，`inFlight=true`，新 `activeRequestId`（防过期回调）
- adapter 流式更新，16ms 广播，1s checkpoint
- 正常结束 → `idle`，再冲队列
- `AskUserQuestion`：CLI 杀进程用文本伪装回答；SDK 走真 `tool_result`
- `ExitPlanMode` 自动续一句 “Plan approved…”

**没有运行时权限提示。** 策略写进 CLI flag / SDK options。`resolveEscalation` 基本是死 API。

`stop()` → **idle**（不是 stopped），会话还能再发。Web 重启丢掉 in-flight 一轮，只保留上次 checkpoint 的 messages。

### 9.3 ClaudePtyBridge

只在 `provider === claude && providerCliActive` 时挂上。

从 PTY 抽：

- 原始输出（终端视图）
- Claude session UUID（16KB 窗口正则）
- 权限提示（启发式：intent + confirm 语法 + 动作上下文）
- 聊天文本（跳过回显，用光秃 `❯` 判断一轮结束）——**不是** tool / thinking 解析

自动批准有三层：严格检测延迟回车、关键词分数兜底、3s 静默探测。`approve_turn` 记到下一轮 `chat.turn`。

### 9.4 Provider 差异

| | Claude | Codex | OpenCode | Grok | Qoder | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| PTY 权限 UI | 有 | 无，强制 full-access | `--auto` | `--always-approve` | `--permission-mode` | 无 |
| PTY 抓 ID | bridge + `~/.claude/projects` | `~/.codex` | `opencode.db` | 预分配 | 预分配 | 无特判 |
| PTY resume | `--resume` | `resume <uuid>` | `--session` | `--resume` | `--resume` | `--session` |
| Structured 命令 | `claude -p --output-format stream-json` 或 Agent SDK | `codex exec --json` | `opencode run --format json` | `grok -p --output-format streaming-json` | `qodercli -p stream-json` | `pi --mode json --print` |
| 历史 resume HTTP | `/api/claude-sessions` → **PTY** | `/api/codex-sessions` → **新 structured** | 同左 | 无专线 | 同 Codex | 无专线 |

Claude structured 有两条后端，由 `structuredRunner` 选。SDK 优先系统 PATH 上的 `claude`。`runClaudePrint()` **不是**会话 runner，给标题 / commit / 提示词优化用，`tools: []`，不持久化。

---

## 10. Terminal daemon 与 Resume

### Daemon

路径按 `sha256(configPath)[:12]`：

- socket：`/tmp/wand-terminald-<uid>-<suffix>.sock`（躲 macOS ~100 字节限制）
- token：`<configDir>/.terminald-<suffix>.token`（0600）
- pid：`<configDir>/.terminald-<suffix>.pid`

协议：换行 JSON，v1。请求 `hello | list | createOrAttach | write | resize | kill | forget`。事件 `data | exit`，带单调 `seq`，重连可补洞。

`createTerminalHost`：测试模式 → 进程内；否则领养已有 socket；有活 pid 就等 5s **绝不踢掉还握着 PTY 的 daemon**；否则 spawn detached `wand terminald`；再失败才进程内。

客户端断线 500ms–10s 退避重连，对账后补 seq 或合成 exit。

`PtyTerminalState` 是 headless xterm（scrollback 5000），只给重连快照用。浏览器仍吃原始字节。

### Resume

`src/resume-policy.ts` 只负责**拼命令字符串**。真正发现 ID 在 `process-manager.ts`。

活着时：只在「同 cwd、启动后新出现、时间近、**恰好一个**」时绑定。多个新文件 → 不绑。

退出时才允许时间窗兜底（`startedAt-30s` ~ `endedAt+30s`），仍要求唯一。

Claude 还要求 JSONL 里真有对话（至少 2 行 user+assistant），且 Wand messages 里已有 user turn。

不安全的 ID 不会插进命令行（`isSafeProviderSessionId`）。

PTY 上对已结束会话再 `input`：若有 provider + `claudeSessionId` + 真文本，会先 resume 再用这段作 `initialInput`。

Structured 的 history resume **不导入**原生聊天记录，只预填 `claudeSessionId`，下一轮 `sendMessage` 带上 resume flag。

---

## 11. Workspaces vs Missions

两个上层系统，都建在 runner 之上，**自己不执行模型**。

### Workspace（项目 / 分屏）

数据：`Workspace`（一个 cwd）→ `WorkspaceTask[]`（命名工作流，可独占 worktree）→ 布局树（pane/split，tab 可以是 session / editor / preview）。

- `POST /api/workspaces` **只建项目，不开会话**
- 新会话通过 `resolveWorkspaceIdForNewSession`：显式 id，否则按**项目 cwd** find-or-create
- worktree 会话归属 **repo root**，不是 `.wand-worktrees/...`
- 列表时 `backfillSessionWorkspaces` 把孤儿会话收进项目
- 并行多 provider 是 **前端**在同一 task 下连开多个 session，共用该 task 的 worktree

布局校验：`sanitizeLayout` / `sanitizeTaskLayout`（老的单棵树会升成一个 `window-legacy`）。

### Mission（多 provider 编排）

只走 **StructuredSessionManager**。最多 6 个 provider。

创建：校验 prompt / cwd → 落库 `dispatching` → 每个 provider 一个 attempt → `createSession({ mode:"agent", worktreeEnabled, sessionSource:"automation" })` → **每家一个独立 worktree** → `sendMessage(prompt)`。

`ingest(ProcessEvent)` 把会话状态滚成 attempt：`needs_permission` / `needs_input`（未答 AskUserQuestion）/ `failed` / `working` / `done`。任务状态再聚合。

Review：评论 → `sendReview` 拼成一段反馈 prompt 再 `sendMessage`。Diff：`git diff` vs `baseRef`，补丁上限 2MB。

**Inbox 是空的。** `GET /api/inbox` 固定 `{ items: [] }`。`agent_activity` 表和 `upsertAgentActivity` 在存储层存在，**没有任何调用方**。

### Worktree（`git-worktree.ts`）

`prepareSessionWorktree`：要 git 仓库 → 解析 `baseRef` 成 **commit**（钉死基线）→ 分支 `wand/<task>-<id前缀>` → `<repo>/.wand-worktrees/<...>` → 复制 `copyPaths`、符号链接 `sharedDirectories`。失败回滚。

合并：脏工作区 / 无提交 / 冲突 / `MERGE_HEAD` 已在 → 拒。`merge --no-ff`，失败 abort 并恢复 HEAD。会话还在 running 时不能合。删除会话会 `cleanupWorktreeSync` 强拆。

---

## 12. 更新、分发、其它子系统

### 更新

三条线互不替代。

**Web 包**

- 通道在 SQLite `updateChannel`：`stable` → `npm i -g @co0ontty/wand@latest`；`beta` → `@co0ontty/wand@beta`
- 现行代码用 `npm view` 比版本，**不是**旧文档写的 `build-info.json` SHA 对比。`build-info.json` 只给 UI 展示
- 手动 `/api/update` 走脱离进程的 update-helper
- `autoUpdateWeb` 则进程内装，再 `repairServiceUnitAfterUpdate` + `computeRelaunch`
- systemd / launchd 托管 → 只退出，交给 `Restart=always`；否则 spawn 全局 `dist/cli.js`

**Provider CLI**

`claude` / `codex` / `opencode` / `qodercli` / `pi` 各自 `xxx update`。识别 npm / brew / native。成功后刷新模型目录。开机 2 分钟后第一次，再每 30 分钟。

**APK / DMG**

`DistributionManager`：本地目录按 mtime / 版本，比不过再扫 GitHub 最近 30 个 release，版本从**文件名**抽。

- APK：`?channel=stable|beta`。beta 含 `-debug.MMDDHHMM`。比较用 `compareApkInstallOrder`（同三段 debug > release）
- DMG：无 channel，谁版本高用谁
- `/android/download` 默认 **beta**；检查接口默认 **stable**
- `autoUpdateApk` / `Dmg` 只是开关，服务端不推包
- iOS 没有更新接口

### 其它

| 模块 | 做什么 |
| --- | --- |
| `system-ai.ts` | Wand 自用直连 HTTP（标题、commit、提示词）。openai / anthropic 协议 + fallbacks |
| `models.ts` | 唯一模型发现者，结果进 `app_config`。客户端只读快照 |
| `session-topic.ts` | 用户消息触发，调 AI 出 `{title,description}` |
| `git-quick-commit.ts` | 不是 runner。对 session cwd 做 status / commit / tag / push |
| `prompt-optimizer.ts` | 一次性改写，≤8000 字 |
| `language-prompt.ts` | 语言指令，注入所有 runner 和 one-shot |
| `password-manager.ts` + `/api/browser-extension/*` | 保险库 CRUD、生成器、TOTP、安全报告。库内密码是 **明文 TEXT** |
| `claude-skills.ts` | 扫 SKILL.md frontmatter |
| `provider-history-scanner.ts` | 只读扫原生历史，供 resume UI |
| `session-logger.ts` | `<configDir>/sessions/<id>/` 文件制品 |
| `path-repair.ts` | 服务 PATH 追加工具链 + login shell PATH |
| `tui/` | neo-blessed 仪表盘 + `service:*` + attach IPC |
| `cli-api.ts` | 登录 `127.0.0.1`，忽略 TLS，30s / 20MB |

`DEFAULT_BROWSER_EXTENSION_BASE_URL` 硬编码为 `https://home.huniu.fun:8183`，login / status 会把它当 `serverUrl` 返回。

---

## 13. SQLite 表

数据库：`<configDir>/wand.db`（0600）。迁移只加列 / 加表，从不 DROP。

| 表 | 角色 |
| --- | --- |
| `auth_sessions` | cookie token + principal |
| `command_sessions` | 所有会话目录（含 bounded output / messages JSON、`session_options` 袋） |
| `app_config` | 密钥、偏好、更新开关、模型缓存、隐藏历史 id、最近路径 |
| `session_directory_names` | 侧栏目录自定义名 |
| `password_vaults` / `password_items` | 密码库（明文） |
| `missions` / `mission_attempts` / `mission_review_comments` | 任务编排 |
| `agent_activity` | **死表**，inbox 未接线 |
| `workspaces` / `workspace_tasks` | 项目与任务 |

热路径：`saveSession` 全量；`updateSessionRuntimeMetadata` 只标量；`checkpointSessionMessages/Output` 给流式。`saveSession` 自己不开事务，好让 checkpoint 进调用方事务。

`workspace_id` / `workspace_task_id` 在新库上也是 ALTER 补上的。

---

## 14. 后续下钻入口

| 现象 | 先看 |
| --- | --- |
| 起不来 / 双开 / attach | `cli.ts` → `pidfile.ts` → `tui/ipc-*` |
| 登录 / cookie / 扩展 token | `auth.ts` + `server.ts` login + `appSecret` |
| 列表 / 详情字段不对 | `session-registry.ts` → `session-transport.ts` |
| 终端乱、重连丢字、CLI 退后还能敲 | daemon + `pty-shell-launch.ts` + `pty-terminal-state.ts` + WS ack |
| 聊天块 / 工具 / 队列 / 中断 | **先确认 structured**，再 manager + 对应 adapter |
| Claude TUI 权限弹窗 | `claude-pty-bridge.ts` + `ProcessManager.resolvePermission` |
| Resume 绑错 / 没绑 | `process-manager` 发现逻辑 + `resume-policy.ts` |
| 标题 / commit / 优化 | `session-topic` / `git-quick-commit` / `prompt-optimizer` + `system-ai` |
| 工作空间分屏 / 合并 | `server-workspace-routes` + `git-worktree` + `workspace-binding` |
| 多模型并行任务 | `missions.ts`（不是 workspace dialog） |
| 自更新后起不来 | `npm-update-utils` → `service-self-repair` → `relaunch` |

---

## 15. 文档与代码的偏差

1. `session-lifecycle.ts` 已不存在；没有 `thinking` / `waiting-input` 状态机
2. Inbox / `agent_activity` / `wand inbox:list` 未落地
3. 密码库曾为明文（旧 `CLAUDE.md` 写成 encrypted；P0 已修复为 AES-256-GCM）
4. Beta 自更新现在是 `npm view @co0ontty/wand@beta`，不是 GitHub `build-info.json` SHA
5. Provider history GET 恒为空
6. Structured 的 escalation API 是死面
7. `claudeSessionId` 被所有 provider 复用
8. PTY 聊天和 structured 块模型会漂移——渲染问题先分清来源

---

# 问题修复优先级

原则：先修会丢数据、错绑状态、或已经在线上协议里伤客户端的问题；半成品要么补完要么删掉，不要留双真源；文档偏差最后清。

优先级含义：

- **P0**：现网会错、会泄密、或客户端已经依赖却拿不到的字段。建议立刻修。
- **P1**：行为不一致，用户能踩到，但有绕路。下一轮该做。
- **P2**：半成品 / 死面。修或删，二选一。
- **P3**：命名、文档、清理。不挡功能。

---

### P0 — 立刻修（已完成，2026-08-22）

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 会话 DTO 丢掉字段 | `sessionBase()` 已带上 `workspaceId` / `workspaceTaskId` / `queuedMessageSkills` / `titleGenerating` |
| 2 | 密码库明文落盘 | `enc:v1:` AES-256-GCM，密钥来自 `appSecret`；读路径兼容明文旧行 |
| 3 | 扩展 `serverUrl` 写死 | login / status 改为当前请求的公开 origin |

---

### P1 — 下一轮该做（已完成，2026-08-22）

| # | 问题 | 影响 | 建议改法 | 关键文件 |
| --- | --- | --- | --- | --- |
| 4 | `POST /api/commands` 和部分 PTY 权限 / resume 返回裸 `SessionSnapshot` | 和 `SessionDetailDTO` 双协议。客户端有的吃 DTO 窗口字段，有的吃全量 output / messages，容易截断或漏 `wandProtocolVersion` | 统一走 `sessionResponseDTO` | `src/server.ts`、`src/server-session-routes.ts` |
| 5 | Structured 重启丢 in-flight | web 一重启，进行中的一轮变 idle，只留上次 checkpoint。用户看到「停了」，队列也不会自动续 | 恢复时若有未完成 user turn / 非空队列，标可恢复并提供续跑；至少在 UI 上明确「已中断」 | `src/structured-session-manager.ts` |
| 6 | `file-search` 锁在 `process.cwd()` | 服务当 systemd 跑时 cwd 常是 `/` 或 unit 目录，搜索不是 session / workspace 目录 | 以请求里的 `cwd`（并做 path-safety）为根 | `src/server-file-routes.ts` |
| 7 | Scope 名单漏路由 | workspace、文件创建删除、OpenCode/Qoder resume、`/api/session-list` 只要求已登录。现在两种 principal 碰巧都够用；以后加只读 principal 会漏 | 把它们挂到 `requireSessions` / `requireFiles` | `src/server.ts` |
| 8 | WS 不认 Bearer | 只带 `Authorization` 的客户端能打 REST、连不上 `/ws` | 握手时同时接受 cookie 和 Bearer appToken | `src/ws-broadcast.ts`、`src/server.ts` |
| 9 | `/android/download` 默认 beta，检查接口默认 stable | 网页扫码下到 debug 包，客户端检查却说没更新（或反过来） | 下载和无参检查对齐同一默认通道；文档写死 | `src/server-update-routes.ts` |

---

### P2 — 半成品：补完或删掉（已完成，2026-08-22）

- Inbox：`Missions.ingest` 写 `agent_activity`，`GET /api/inbox` / `POST /api/inbox/read` / `wand inbox:list` 接上
- History GET：保持 `[]` 作为旧客户端兼容契约
- Structured 权限路由改为 404
- 补上 `/api/grok-sessions/:id/resume`、`/api/pi-sessions/:id/resume` 与 history GET 空壳
- 聊天渲染按 `sessionKind` 分叉，不在 PTY 路径伪造 tool block

| # | 问题 | 现状 | 建议 | 关键文件 |
| --- | --- | --- | --- | --- |
| 10 | Inbox | HTTP 恒 `{ items: [] }`；`agent_activity` 表和 `upsertAgentActivity` 无调用方；CLI `inbox:list` 不存在 | 要么 `Missions.ingest` 写 activity 并接上 inbox；要么删路由 / 表 / 文档，避免双真源 | `src/server-mission-routes.ts`、`src/storage.ts`、`src/missions.ts` |
| 11 | Provider history GET 恒 `[]` | DELETE / hide 仍有效，列表是兼容空壳 | 若 UI 已不展示原生历史，删 GET 或改 410；若还要展示，接 `provider-history-scanner` | `src/server-session-routes.ts` |
| 12 | Structured `resolveEscalation` / 权限路由 | structured 从不设 `pendingEscalation`，这些 API 只会 400 | 结构化路径直接 404 / 从文档摘掉；不要让客户端以为能批准 | `src/structured-session-manager.ts`、session routes |
| 13 | Grok / Pi 无独立 resume / history 路由 | 只能走通用 `/api/sessions/:id/resume`，和 Codex / OpenCode / Qoder 不对称 | 需要原生历史恢复时再补；现在先在文档写清楚 | `src/server-session-routes.ts` |
| 14 | PTY 聊天 vs structured 块模型 | Claude PTY 是启发式刮字，没有 tool / thinking block | 不要强行合成假 tool block。聊天渲染必须按 `sessionKind` 分叉 | `src/claude-pty-bridge.ts`、前端 chat-render |

P2 里 **Inbox（#10）优先于其它半成品**：表已经建了，前端也有 inbox 入口，空壳最容易被当成活功能来排 bug。

---

### P3 — 文档、命名、清理（已完成，2026-08-22）

- DTO 增加 `providerSessionId` 别名
- `CLAUDE.md` 去掉不存在的 `session-lifecycle.ts`，并更正 beta 更新与 vault 加密表述
- `resumed_to_session_id` 标注为只加不删的遗留列
- 头像接口改为需要登录

| # | 问题 | 建议 |
| --- | --- | --- |
| 15 | `claudeSessionId` 被所有 provider 复用 | 新加 `providerSessionId` 别名并双写一段时间，或至少在类型注释里写清 |
| 16 | 旧 `CLAUDE.md` / `agent.md` 过时 | 已完成：`CLAUDE.md` 删除，指南并入 `AGENTS.md`；过时表述清掉并指向本文 |
| 17 | `resumed_to_session_id` 列在、写入路径不在 | 确认无读取后再从文档拿掉；不要为它写新逻辑 |
| 18 | 公开头像 `/api/structured-chat-avatar/:role` 无鉴权 | 风险低（本地图片）。若 persona 可能指向敏感路径，再收紧到已登录 |

---

## 16. 建议实施顺序

不要平行铺开。按这个切片：

1. **切片 A（P0，协议 / 密钥）**  
   DTO 补字段 → 扩展 `serverUrl` 改成请求 origin → 密码库 at-rest 加密（可单独 PR，含迁移）。
2. **切片 B（P1，响应与恢复）**  
   PTY 创建 / 权限 / resume 统一 DTO → structured 重启后续跑或明确中断 → `file-search` 根目录。
3. **切片 C（P1 收尾）**  
   scope 名单补齐 → WS 接受 Bearer → APK 通道默认对齐。
4. **切片 D（P2）**  
   Inbox 二选一（落地或删除）。其余死面随手清。
5. **切片 E（P3）**  
   文档和命名。不要单独开一轮只改名字。

每片做完用：

```bash
npm run check
npm test
```

会话 / DTO / 权限相关改动再补针对 `session-transport`、`server-session-routes`、`password-manager` 的单测。

---

## 17. 本轮明确不修

这些是架构取舍，不是漏修：

- 两套 runner 继续分开，不合并
- PTY 聊天继续做文本投影，不在 bridge 里伪造 tool_use
- Structured 继续无运行时权限提示
- Codex PTY 继续强制 full-access
- iOS 继续没有应用内更新
- 单实例按 config 路径隔离
- Schema 继续只加不删
