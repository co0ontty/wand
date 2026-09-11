# Wand 服务端逻辑分析

最后核对：2026-09-10。代码基线：主仓库 `d240da17b4bfee37b304e0a51c90506979357d8c`。

本文描述**当前实现**，不把历史缺陷或未来设计写成现状。客户端操作见 `client-logic-analysis.md`；问题证据、优先级、实施与验收计划统一见 `optimization-plan.md`。本次仅更新文档，没有实施修复。

核对方法：枚举自有代码目录，沿入口 → 路由 → owner → 存储/进程 → HTTP/WS → 客户端追踪主要交互，辅以针对性测试和隔离探针。不是逐行安全审计，也未对六种真实 provider、全部平台设备和外部服务做运行验收。完整覆盖表及验证限制见计划 §1、§6。

## 1. 系统与数据流总览

```text
Web / Android / iOS / macOS / JSON CLI / 浏览器扩展
  ├─ REST：鉴权、创建、命令、查询、文件、设置、更新
  └─ /ws：快照、增量、通知；订阅后的 PTY 输入与流控
         │
         ▼
cli.ts → server.ts（组合根）
  ├─ SessionRegistry → StructuredSessionManager → provider Adapter
  │                    ├─ CLI → StructuredExecHost → terminald 或本进程
  │                    └─ Claude SDK → web 进程内 query + canUseTool
  ├─ SessionRegistry → ProcessManager → TerminalHost → terminald / 测试 host
  ├─ WandStorage + SessionLogger
  ├─ WorkspaceTask / Missions / GitHub connector
```

PTY 与 structured 共享 `SessionSnapshot`、DTO、存储、事件，不共享执行状态机。

排查会话先调用 `SessionRegistry.ownerOf(id)`：`structured` → `pty` → `storage`。不要仅按 URL、provider 或界面外观推断执行路径。

## 2. CLI、启动与关停

主要文件：`cli.ts`、`pidfile.ts`、`tui/*`、`terminal-host.ts`、`server.ts`。

1. `-c/--config` 决定 config、SQLite、会话制品与分发目录；单实例按 config 路径隔离。
2. `wand web` 探测 pidfile / IPC；已有实例则 attach 或打印访问地址，不再开第二个服务。
3. 修复 PATH 与 node-pty helper 权限，创建存储、运行配置、模型目录、分发管理器。
4. 创建 TerminalHost、两个 manager、SessionRegistry、Missions。
5. 挂 HTTP/WS，连接事件广播，再异步执行 `recoverDetachedRuns()`。
6. 非测试模式下运行启动命令、模型刷新、包与 provider CLI 更新检查。

`wand session:*`、`mission:*`、`inbox:list` 经 `cli-api.ts` 登录本机 HTTP，并不直接操纵 manager。TUI/attach 通过 IPC 读状态和发管理命令。`service:*` 管理 systemd/launchd。

关停必须分别理解：

| 对象 | 当前行为 |
| --- | --- |
| daemon 持有的 PTY | web dispose 解绑；终端进程保留 |
| daemon 持有的 structured CLI | 保留执行；下次 web 尝试领养与回放 |
| Claude SDK / 本进程 structured CLI | 中断；不能承诺跨 web 重启续流 |
| WS / 定时器 / logger / SQLite | 停止广播、释放资源 |


常用开关：`WAND_TEST_MODE=1` 使用测试/进程内路径并跳过部分后台任务；`WAND_DISABLE_UPDATE_CHECK=1` 关闭更新检查；`WAND_NO_TUI` 控制 TUI。测试模式不能替代真实 daemon 生命周期测试。

## 3. 配置、持久化与所有权

| 状态 | 真源 | 相关实现 |
| --- | --- | --- |
| 部署项：host/port/TLS/shell/启动命令/分发目录 | config.json | `config.ts`、`runtime-config.ts` |
| 偏好、更新通道、模型缓存 | SQLite `app_config` | `storage.ts`、`models.ts` |
| 登录凭据、appSecret、连接器 token、密码库 | SQLite | `auth.ts`、`storage.ts`、`password-manager.ts` |
| 会话运行态 | owner manager；持久化为 checkpoint | 两个 manager、`session-logger.ts` |
| PTY/CLI 进程及回放日志 | terminald 或本进程 host | `terminal-daemon-*`、`structured-exec-*` |
| WorkspaceTask、Missions、WandTask、会话绑定 | Wand SQLite | workspace/mission/task routes |
| 上传 / worktree / 分发包 | 文件系统 | upload / git / distribution 模块 |

`loadConfigWithStorage()` 会迁移旧 JSON 偏好/密钥、合并默认值，并可能写回配置。排查与验证不要随意加载真实用户配置。

SQLite 迁移只加表/列。`saveSession`、标量 metadata 更新、消息/output checkpoint 是不同写路径；文件制品与 SQLite 互补，不能只查一个。

**加密范围须说准确：** 存在 appSecret 时，新写入的 `password_items.password`、`notes`、`fields`（JSON 整体）和 connector token 使用 `enc:v1:` AES-256-GCM；读取兼容旧明文。因此密码库里可包含 TOTP、卡信息、passkey 私钥的字段也已纳入加密。但 appSecret 同在该数据目录，这不等于可抵御整个数据目录泄露（R09）。

## 4. 鉴权与路由覆盖

| 主体 | 获取方式 | 权限 |
| --- | --- | --- |
| browser-admin | 密码登录 | admin，隐含其它 scope |
| connected-app | appToken 登录或 Bearer | sessions、files、password-vault、session-preferences |

appToken 由 appSecret 与密码派生；改密码撤销 cookie 并断开已认证 WS，旧 appToken 随之失效。REST **和 WS 都已支持 cookie / Bearer appToken**；原生当前仍大量使用先登录得到的 endpoint-scoped cookie。

公开路由包括站点 shell、登录/会话探测、原生包检查/分发、iOS OTA；头像已经要求登录。HTTPS 与 HTTP 使用不同 cookie 名，避免 Secure cookie 相互干扰。

`/api/*` 在业务前经过 `requireAuth`。会话/文件前缀另外挂 scope；GitHub connector、GitHub API、`/api/wand-tasks` 显式要求 admin。

**新路径不是自动继承所有中间件：**

- `/api/tasks` GET/POST 没有出现在 `requireSessions` 前缀列表，虽然仍要求登录。
- 当前 connected-app 本就有 sessions/files，不能把后一项直接宣称为已证实越权；应补全能力矩阵和回归测试（R02）。

## 5. HTTP 契约与会话 DTO

主要入口：`server-session-routes.ts`、`session-transport.ts`。

| 操作 | 路径 / 结果 |
| --- | --- |
| 新建 PTY / shell | `POST /api/commands`；`shell:true` 表示纯 shell |
| 新建 structured | `POST /api/structured-sessions`；可携首条 prompt |
| 列表 | `GET /api/sessions`；`GET /api/session-list` 分页/探测 |
| 详情 / 历史窗 | `GET /api/sessions/:id?format=chat`；`.../messages` |
| 统一输入 | `POST /api/sessions/:id/input`，按 owner/kind 分流 |
| structured 队列 | `.../messages`、`queued`、`queued/:index/promote` 等 |
| 配置变更 | `.../model`、`thinking-effort`、`mode` |
| 权限 | approve/deny、`escalations/:requestId/resolve` |
| 生命周期 | resume / stop / delete / batch-delete |
| 文件/Git | upload、tool-content、git-status、quick-commit、worktree 等 |

DTO 已携带 `workspaceId`、`workspaceTaskId`、`queuedMessageSkills`、`titleGenerating`、`ptyBusy`，并提供 `providerSessionId`（兼容别名）。`claudeSessionId` 仍保存所有 provider 的原生 resume ID，不应直接删列改名。

- 列表 `output:""`，不附全量 messages；标题由服务端统一裁定。
- 详情有 `wandProtocolVersion`、output 窗口与 offset/total；默认 output 上限 200,000 字符。
- 聊天支持 turn 窗口，也支持 `blockBudget` 及首 turn 的块级 offset；不能只按 turn 数判断响应大小。
- `offset=0` 且 revision 未变的 session-list 返回 `unchanged:true`；后续分页 revision 不一致返回 409。
- `respondImmediately:true` 的 structured 输入返回 202 快照，表示接收/启动，不表示执行完成。
- PTY `responseMode:"accepted"` 只返回轻量确认，不应每个按键拉整份详情。

Provider history GET 仍返回兼容空数组；Claude/Codex/OpenCode/Qoder/Grok/Pi 均有对应恢复入口。原生历史恢复与 Wand 会话原 ID 的 resume 不是一个契约，不能把空 history GET 当成磁盘没有历史。

## 6. 输入、审批与执行状态

### PTY

```text
创建 → running（provider CLI 活跃）
    → 一轮输入/输出，ptyBusy 区分生成中与提示符
    → CLI 退出，wrapper 转 login shell：仍可能 running
    → stop / shell 退出：stopped / exited / failed
```

`providerCliActive` 不是 `ptyBusy`，`status=running` 也不等于 AI 正在回答。POSIX provider wrapper 用私有退出标记识别 CLI 结束。

服务端 `sendInput` 原样写 PTY。composer 必须发“文本包”再发单独 `"\r"`；当前各端 composer 两包均标 `shortcutKey:"enter_text"`，终端文本包用于标题捕获。控制键只传实际控制字符。详见客户端 §6。

Claude PTY bridge 从 TUI 启发式提取权限、ID、聊天文本；不生成假的 tool_use/thinking block。Codex PTY 当前强制 full-access，不应承诺可运行时审批。

### Structured

```text
create → idle
send → running / inFlight / activeRequestId
     ├─ 流式 output + checkpoint
     ├─ pending permission / AskUserQuestion
     ├─ 后续消息排队（最多 10；重复拒绝）
     └─ 完成 → idle → 调度下一条
stop / interrupt → 终止当前 generation，按队列策略处理后续输入
```

`activeRequestId` 是屏蔽旧回调的关键；错误和完成不得用旧快照覆盖新的 turn。停止 structured 后回 idle，而非永久不可发送。

Claude SDK 默认权限模式经 `canUseTool` 产生 pending escalation；approve_once、approve_turn、deny 及 stop 释放 waiter 均已有测试。Claude print 和其它 structured Adapter 没有相同运行时审批机制。没有 pending 时返回错误，不应渲染“必定可批准”的按钮。

模型/思考/模式对 structured 通常下一轮生效；PTY 某些 provider 可发 CLI 内命令，但不能笼统认为已启动进程的所有权限 flag 都可热改。

## 7. Terminal daemon 与 structured 恢复

主要文件：`terminal-daemon-protocol.ts`、client/server、`structured-exec-host.ts`、`structured-exec-pump.ts`、`resume-policy.ts`。

PTY daemon 以 config 路径哈希区分 socket/token/pid；客户端重连对账并补 seq。终端显示快照由 headless xterm 提供，浏览器消费原始字节。

**当前已不再是“所有 structured 重启必定中断”：**

1. manager 构造时先把原 running 记录归一为 idle，并暂记中断提示；非 SDK 记录加入恢复候选。
2. 服务端接好事件后异步 `recoverDetachedRuns()`；persistent exec host 才能列出、领养 surviving CLI。
3. 根据 provider 的回放 processor 重放 stdout，继续接 live output/exit；成功恢复重新设 inFlight，清中断提示。
4. SDK、本进程 fallback、daemon 中不存在的 run 不具有这条续流保证；日志截断也影响完整恢复。

需要验证而未在本次真实环境复现的窗口：恢复完成前再次发送、list→adopt 期间新增/半行输出、恢复中断线或连续重启、被截断的回放日志、SDK 正常关停后的中断提示（R07）。不要只凭“进程活着”认定消息、队列和 UI 已完全恢复。

**已修复的字节流问题：** pump 曾按 Buffer 块直接 `.toString()`，中文字符字节跨块时出现替换字符；daemon 的 CLI 输出、socket 帧、TUI attach socket 与 daemon client socket 也有同类位置。现统一在字节流 seam 使用有状态 UTF-8 解码（`createUtf8TextDecoder` / `StringDecoder`），流结束先 flush 再宣告 exit（R03）。这与 PTY WebView 常见的列宽乱码是两类问题。

## 8. WebSocket 订阅、合流与背压

主要文件：`ws-broadcast.ts`、客户端 `websocket.ts` / `WandSocket`。

- `subscribe` 默认替换订阅；Web 分屏使用 `mode:"add"`。`resync` 请求新的 init。
- `pty_input` / resize 要求订阅对应 PTY；ACK-capable 客户端按未确认字节数暂停/恢复 PTY。
- output 约 16ms 合流；不同 payload 形状先 flush，避免 messages/lastMessage/raw chunk 混成歧义事件。
- 非 output 事件前 flush output，保证最终文字在 ended/status 前到达。
- output 按客户端/会话打 seq；缺口或 `resync_required` 触发快照恢复。
- 未订阅的 raw PTY 不广播；**非 raw 的结构化/状态事件仍可全局 fanout**，原生全局通知 socket 利用这一点。
- 心跳负责断线检测；HTTP 快照、WS init 和本地乐观状态仍需独立处理新旧顺序。

当前非 ACK 背压分支会丢新业务事件，不仅 output；但只有丢 output 才记录 pending resync。若最后只丢 ended/status，UI 可能没有主动纠正信号。这是静态确认的协议缺口，尚未复现真实慢网络卡死（R06）。

## 9. “任务”的四套实体不能混同

| 名称 | 真源 / 标识 | 用途 |
| --- | --- | --- |
| WorkspaceTask | `workspace_tasks`，`workspaceTaskId` | 会话容器、cwd/worktree、窗口布局 |
| Mission / attempt | missions 系列表，`automationId` | 多 provider 派发、review、状态聚合 |
| WandTask（任务管理） | `wand_tasks` / `wand_task_sessions` | 原生任务管理看板；可绑定项目与 CLI 工具并派发会话 |

它们不是同一个 task ID，状态不会自然同步。GitHub issue 另以 owner/repo/number 关联会话。任务管理绑定的项目就是 Wand Workspace。

### WorkspaceTask

- `POST /api/tasks` 可创建独立任务，属于 global workspace；可不选项目/目录。
- 项目任务走 `POST /api/workspaces/:id/tasks`；runtime cwd 顺序为 task worktree → task.cwd → workspace.cwd。
- 项目任务未传 worktree 时默认尝试隔离；global 独立任务默认不隔离。
- **显式 `worktree:true` 创建失败也会降级**，返回 `isolated:false` + `worktreeError`，不是强保证。需更明确的用户确认（R10）。
- `GET /api/tasks` 支持 workspaceId、limit、maxSessions、revision；不带 revision 返回数组，带 revision 返回 `{unchanged,revision,groups}`。
- limit 是每 workspace 的截断，不是完整游标分页。带 `revision` 时先用存储指纹 + slim 会话状态做廉价比对，unchanged 不再拼 groups。
- 任务详情 GET 会 touch lastOpenedAt；布局 PUT 校验树形数据，但没有版本条件，多端可最后写入覆盖（R11）。
- 删除非隔离任务默认解绑；隔离任务即使未显式 cascade 也要删除其会话并清 worktree，避免 cwd 悬空。清理失败/未提交改动的可见性仍需验证。

### Missions / Inbox

Missions 只调 structured。无关联任务时每 attempt 创建 worktree；传 taskId 后使用绑定任务上下文，不再叠加隔离。并行共享目录的改动冲突需与用户预期明确区分。

`ingest` 聚合 working/needs_permission/needs_input/failed/done，已写入 `agent_activity`。`GET /api/inbox`、read 和 CLI 已接线，不是空壳。Web Missions 并不因此自动具备 Inbox UI。

review 发送经 `sendMessage`：请求被接受（入队或启动）后才标 sent；同步/微任务失败保持 pending。整轮执行失败只记日志，不再把已接受的评论改回 pending。

## 10. 任务管理与 GitHub 新交互

### 任务管理

`TaskBoardHost` 是 Wand 原生 React 面板，直接读写 `/api/wand-tasks`，不再有 iframe、回环子服务或 postMessage 握手。原生客户端走同一套 API（登录即可，不要求 admin）。

指派：`POST /api/wand-tasks/:id/dispatch` → cwd 取任务绑定的项目目录（未绑定则 `config.defaultCwd`）→ 创建 structured（automation source、不新建 worktree）→ 写 `wand_task_sessions` binding → 发送 prompt → 202。它不会自动成为 WorkspaceTask，也不经 Missions attempt 状态机。

还需补：指派去重、异步失败状态回写（当前派发失败只进 console）、真实 provider CLI 端到端验收。

### GitHub

设置连接 token → `connectGithub` 调 `/user` 校验 → connector 存储；Issues UI → Wand admin routes → GitHub。绑定存在 Wand SQLite，不是发到 GitHub 的 label/comment。

已复现：校验 token 前先改共享 connector，晚到失败回滚能删除较新成功连接。请求也未设置应用层截止时间。UI 的 repo 输入与已加载列表上下文没有绑定，缺少请求 generation 与创建 pending 保护（R05）。

## 11. 文件、上传与 Git

目录、预览、raw、搜索、写入与增删改名在 `server-file-routes.ts`。搜索已使用请求 cwd。path-safety 当前阻止特定系统目录，**不是完整文件系统沙箱**；符号链接、真实路径和父目录校验需要单独核验。

文件写采用同目录临时文件 + rename，避免半写。`POST /api/file-write` 接受可选 `expectedMtime` / `expectedSize`，不匹配返回 409 和当前 stat，不覆盖外部更新。

上传最多 5 个文件、单文件 10MB，落到会话 cwd 的 `.wand-uploads/`；路由通过 ProcessManager.get 的兼容查找取得会话。优化时应统一 Registry seam，并保留 structured 上传回归。

快捷提交、生成说明、tag、push、worktree merge 都会触及真实工作区：

- `generateCommitMessageOnly()` 当前先执行 `git add -A`，**生成文案也会改变暂存区**。
- quick-commit 的 fallback、子模块提交/推送与主仓库提交不是一条原子事务。
- merge 有脏工作区/冲突检查及失败恢复，但多入口对同仓库同时写仍需单独验证。
- 删除 worktree 可能强制丢弃未合并内容，不能当成单纯删列表项（R10）。

## 12. 模型、系统 AI、扩展与更新

`models.ts` 为唯一模型目录发现者；客户端只读缓存。`system-ai.ts`、`claude-sdk-runner.ts`、session-topic、prompt-optimizer 与 git 文案生成属于 one-shot 辅助调用，不等于会话执行。首条文本触发标题时还要遵守 pending/旧回调防覆盖。

浏览器扩展：content script 捕获/填充 → background 按消息分派 → Bearer REST；popup/options 管理连接与条目；passkey 路径按浏览器能力启用，并在发给内容脚本前去掉私钥字段。服务端返回当前请求 origin；代码仍有历史默认地址常量，不能写成“运行时 origin 已完全不存在默认值”。

更新分线：

| 对象 | 当前路线 |
| --- | --- |
| Wand npm | stable/beta 通道，npm view 比版本；手动 detached helper 或自动更新，再服务自修复/relaunch |
| provider CLI | 各工具更新器；成功刷新模型目录 |
| Android | 本地 beta 唯一来源；无 channel 的检查与下载均默认 stable |
| macOS | 服务端 DMG 分发与原生 MacUpdateManager 路径分别核对；不可概括成一个通道 |
| iOS | 本地 IPA 检查 + manifest/install/download OTA；未签名包可被发现，但不能据此承诺系统安装成功 |

`dist/build-info.json` 只是展示信息，不是 beta 更新判定唯一依据。原生 connected-app 无 npm 更新管理权限，App 包更新与服务端更新必须分开呈现。

## 13. 当前文档纠偏与后续入口

本次删除了旧版正文中与“已完成”表相互冲突的描述：DTO 漏字段、WS 不认 Bearer、Inbox 死表、SDK 无审批、iOS 无更新、所有 structured 重启必丢等。2026-08-22/23 的完成记录只代表当时范围，不能当作当前全功能验收。

| 现象 | 下钻入口 | 计划 |
| --- | --- | --- |
| 真正字符损坏 / 恢复后消息不对 | structured-exec-pump、daemon 解码、recoverDetachedRuns | R03、R07 |
| 编辑器覆盖外部文件 | file-write + code-editor repository/controller | R04 |
| GitHub 连接/列表串状态 | github-connector + issues host | R05 |
| 慢客户端不停止转圈 | ws-broadcast 背压、客户端 reducer | R06 |
| 原生模型/队列回退 | 各端 ChatStore、WandSocket | R08 |
| 密码库敏感字段范围 | storage + password-manager + extension | R09 |
| worktree/暂存区/删除意外 | workspace routes、git-*、Registry | R10 |
| 布局/review/任务状态错位 | workspace/missions/storage | R11–R12 |
| 大列表阻塞 | tasks 聚合、Registry.listSlim、storage 查询 | R13 |
| 契约测试与实际行为冲突 | web-native-contracts、原生 WebView | R14 |
