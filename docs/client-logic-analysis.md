# Wand 客户端操作与交互逻辑

最后核对：2026-09-10。主仓库基线 `d240da1`；Android `dc4dc6a`，iOS `d10a456`，macOS `b0a545e`。

本文按用户操作描述当前调用、状态真源与端间差异。服务端机制见 `server-logic-analysis.md`，待办及验证证据见 `optimization-plan.md`。本次为代码核对和有限隔离验证，**没有完成多端真实设备验收，也没有实施修复**。

## 1. 客户端与入口

| 客户端 | 当前形态 | 主要代码 |
| --- | --- | --- |
| Web | Legacy runtime + React Shell/面板；议题看板为原生 React 面板 | `src/web-ui/browser/`、`src/web-ui/react/` |
| Android | Compose 列表/任务/聊天/原生 PTY 外壳；WebView 显示终端与网页兜底 | `android/app/src/main/java/com/wand/app/`，含 Kotlin 和 Java 桥接 |
| iOS | SwiftUI 原生列表/任务/聊天/PTY 外壳，WKWebView 显示终端 | `ios/Wand/` |
| macOS | 原生三栏、聊天、文件面板与任务；WKWebView 用于终端/网页 | `macos/Wand/`，不是纯 WebView 壳 |
| 扩展 | MV3 background + popup/options + content script | `browser-extension/` |
| JSON CLI / TUI | HTTP 客户端与 IPC 管理入口 | `src/cli-api.ts`、`src/cli.ts`、`src/tui/` |

Web Legacy 管会话/输入/WS/xterm；React 经 adapter、ui-store bridge 操作同一 runtime，不应建立第二份 session 真源。`?reactUi=0`、`?reactShell=0` 是旧界面回退，不保证与新信息架构一致。

## 2. 连接、登录、换服务器与退出

### Web

```text
restoreLoginSession → /api/session-check
  未登录 → 登录页 → POST /api/login → GET /api/config 验证 cookie
  已登录 → config / models / 会话列表 → WS + 任务聚合
```

密码登录获得 browser-admin。登出清服务端 cookie 会话与本地会话/终端状态。设置部署项、npm 更新、GitHub 等需要 admin，不能仅以“已登录”判断按钮可用。

### 原生

连接码包含 endpoint 和 appToken。冷启动先用 token 登录，REST 遇 401 可重登一次；iOS/Android 的网络层按 endpoint 隔离 cookie/认证。进入嵌入网页还有 WebView 会话准备，不能假设原生 HTTP 的 cookie 自动出现在网页内。

WS 服务端已支持 cookie 和 Bearer；“原生能 REST 不能 WS”仍要核对客户端是否把对应 endpoint 的认证带入握手。

原生一般是 connected-app，不是管理员。iOS 的服务端更新横幅已用 `canManageSettings` 控制安装按钮；其它端不能仅因为有 App 更新入口就推断能安装服务端 npm 包。议题看板/GitHub 在原生网页兜底中的能力与授权还需专门验收（R02）。

换服务器时应取消旧请求、socket、通知和草稿上下文。iOS 的 endpoint/redirect 隔离、Android 的 ServerProfiles/WandHttp 已有专门实现，后续需保持跨 host/port 不泄露凭据，而不是恢复成全局共享 cookie。

## 3. 首屏、列表与导航

### Web 的几种“任务”入口

| 用户看到的入口 | 实际打开 | 服务端真源 |
| --- | --- | --- |
| 新建任务 / 侧栏任务与项目树 | WorkspaceTask 容器 | `/api/tasks`、`/api/workspaces` |
| 底部「任务管理」按钮 | 原生 React 看板 | `/api/wand-tasks*` |
| 「自动化」 | Missions | `/api/missions` |
| 「GitHub」 | Issues 对话框 | `/api/github/*` |

当前不是“侧栏任务 = Missions”，也不再是 2026-08-23 记录中的“项目完全不可见”。独立任务与项目区均可见。旧 `wand_tasks` 看板 CRUD 仍在代码与数据库里，但当前 `TaskBoardHost` 渲染的是 vendor iframe。

`WorkspacesPanel` 约每 6 秒请求 `/api/tasks`；失败保留旧列表。折叠、窄栏和选中态存在本地。点击任务与展开其终端列表是不同动作；移动端必须保留返回任务/项目导航。

任务内会话摘要来自聚合接口；具体输出/消息来自选中后的详情和 WS。目录分组可能是合成组，其分组 ID 不一定是该 task 的真正 workspaceId，创建/导航应使用 task 自身绑定。

### 原生

- 三端都已接入 `listTaskGroups` / 任务根导航，不再属于“原生任务同步尚未开始”。
- Android TaskListState 使用 `/api/tasks?revision=` 并处理 unchanged；SessionListState 保留给历史、通知、快捷方式等辅助用途。
- iOS/macOS WorkspaceAPI 当前仍请求数组形态的 `/api/tasks`，没有使用该聚合的 revision 快路径。
- `/api/session-list` 已有分页 revision/unchanged；不能把旧“每 10 秒必定全量重绘”直接当现状。

### 选中会话

Web `selectSession` → 切旧终端/视图、保存选中 ID → HTTP 详情与 WS subscribe；分屏终端池另保留 add 订阅。原生按 sessionKind 进入 Chat 或 PTY 页。

`mergeServerSession` 保留本地进行中的消息/output，以免 slim 列表覆盖流式状态；这不是“服务端越旧越可信”。标题用服务端 DTO，`titleGenerating` 驱动动画。

## 4. 创建任务与会话

### 创建容器

- 独立任务：`POST /api/tasks`，cwd 可不填，使用 global workspace 的上下文。
- 项目任务：`POST /api/workspaces/:id/tasks`，绑定项目目录。
- 创建项目本身不会启动模型。
- worktree 创建可能失败降级；客户端要展示 `isolated/worktreeError`。显式要求隔离是否允许自动回退，是本轮计划的安全交互决策（R10），不是已经修好的功能。

### 在任务里加会话

当前 Web `startSessionInCwd`、iOS/macOS `workspaceTaskWindowRequest`、Android `createWorkspaceTaskWindowRequest` 都可按 kind 选择：

| 选择 | 请求 |
| --- | --- |
| structured Agent | `POST /api/structured-sessions` |
| PTY Agent | `POST /api/commands` |
| 空白 shell | `POST /api/commands {shell:true}` |

任务内请求带 cwd、workspaceId、workspaceTaskId；Qoder 映射 `qodercli`。旧文档“任务内＋只开 PTY”已失效。

Web 同任务“先 openTask 再建会话”已有 await，**但跨任务 A→B 的详情响应仍缺少当前 task generation 校验**；晚到 A 可覆盖 B 的布局/选中会话（R11）。不能把已修复的同任务创建顺序问题与这一风险混为一谈。

通用新会话、快捷启动、空输入区启动和兼容 deep link 仍是旁路。审查绑定时需逐一检查入口，不能只测任务行上的＋。

## 5. 实时通道与消息合并

| 事件 | 客户端应该理解为 |
| --- | --- |
| init | 窗口化权威快照；含 offset/total，不一定是全部历史 |
| output + messages | 消息窗口替换/衔接 |
| output + incremental/lastMessage | 尾 turn 更新；按 messageCount/offset 合并 |
| output + chunk | 原始 PTY，只交终端，不当聊天正文 |
| status | 权限、模型、标题、inFlight/ptyBusy 等元数据 |
| ended | 当前执行结束；PTY CLI 退出与底层 shell 退出需区分 |
| resync_required / seq gap | 主动拉 init，不能继续猜缺失内容 |

Web WS 优先、HTTP 轮询兜底，后台/前台有重连策略。HTTP 详情在 WS 活跃时不应再次把全量 transcript 写入 xterm，否则会重复绘制。

原生详情各有 WandSocket；Android SessionWatcher / iOS 系统 socket 还处理全局通知。它们不是没有会话订阅就完全收不到消息。

| 端 | 详情窗口与启动顺序 |
| --- | --- |
| iOS | REST/WS 使用 blockBudget=60；支持首 turn 分块加载；有晚到 REST 保护 |
| Android | turn 窗口；ChatStore 先 REST、模型/配置，再连详情 WS |
| macOS | ChatStore 常规详情/WS 仍按 turn；API 另有 blockBudget overload，WorkspaceStore 会使用 |
| Web | turn 窗口和终端池；已有 seq/resync 与 output 单写保护 |

后续统一的是消息新旧顺序、窗口语义与性能上限，不是要求所有端具备 Web 分屏（R06–R08）。

## 6. 输入、队列与中断契约

### 6.1 Structured

发送通常走统一 input 或 structured messages；客户端乐观插入 user turn，进行中则显示排队。202 只表示服务端接收/调度，不表示回复成功。

- Android 已应用发送返回的快照，并 requestResync；iOS 同样协调发送/实时结果。
- macOS structured send 当前丢弃返回的 snapshot，随后 requestResync；与其它端仍不完全相同。
- 排队、提升、删除、清空分别调用 queued 路由；服务端是队列真源。
- Web 有 queueEpoch 防旧 HTTP 回包；原生删/清队列仍有“失败直接恢复整份旧数组”的位置，需防止覆盖新 WS 队列（R08）。

AskUserQuestion 的选择暂存客户端，流式替换不应丢选择；提交交给对应 runner 处理，SDK 与 CLI 的回答机制不同。

中断要明确是否保留队列。structured 是协议字段 interrupt/preserveQueue，不是把 Ctrl-C 字节当 prompt；PTY 则发送真实控制字符。

### 6.2 PTY：文本与回车拆包

所有端 composer 的当前实现已对齐：

```text
{input: 文本, view, shortcutKey: "enter_text"}
  → 约 30ms（原生 helper）
{input: "\r", view, shortcutKey: "enter_text"}
```

不要改成 `text + "\n"`。终端文本包也标 enter_text，以便服务端捕获标题。PTY AskUser 已使用对应拆包路径；旧文档中 Android ChatStore/iOS AskUser/macOS 聊天仍发送 `\n` 的断言应删除。

实现入口：Web `getTerminalSubmitChunks`；iOS `PtyInputProtocol.swift` / ChatStore.sendPtyInput；Android `ptyComposerSubmitChunks` / PtyTerminalScreen；macOS ChatStore.sendPtyInput。

终端视图优先 WS pty_input；HTTP 写用 responseMode=accepted。结束的 PTY 先 resume 再输入。两包中第二包失败时不能盲目重发全文，避免重复执行（验收项，非本次已复现问题）。

### 6.3 离线、粘贴与附件

Web pending PTY 输入有数量/TTL 限制，过期丢弃以免重连后输入旧命令；它不是持久可靠消息队列。

`pty-paste.ts` 协调文本、图片上传与路径插入；原生 WebView 桥接也有剪贴板/文件入口。目标必须绑定粘贴开始时的 session/cwd，晚到上传不能串到后来切换的会话。IME 候选确认不能当发送回车。

附件上传与模型执行不是同一步；上传成功但发送失败时，应能保留重试内容而不假装消息已执行。后续跨端验收同时覆盖文字、中文输入法、图片、后台切换和第二包失败。

## 7. 权限、模型与“正在回答”

- Claude PTY 和 Claude SDK structured/default 都可以有 pendingEscalation。
- print/其它 structured 无同等运行时审批；不能依据 structured 一刀切隐藏所有权限卡，也不能一律显示批准按钮。
- 审批失败/已过期后应 resync，别只乐观消掉卡片。
- structured 看 inFlight；provider PTY 看 ptyBusy；底层 shell running 不代表模型回答中。
- 重启提示要区分 CLI 恢复中、恢复成功、SDK 已中断。当前服务端恢复有临时 idle/lastError，UI 不应把瞬时状态当最终结论。

配置 mutation：Web 已串行；iOS 有发送尾队列和 revision；Android 有 Mutex/generation 与 pending 字段保护。macOS setModel/setThinkingEffort 仍各起 Task 并 apply 整份返回快照，快速切换可发生旧回包覆盖新选择（R08）。不是三端都已完全对齐。

## 8. 恢复、停止、删除与通知

| 动作 | 语义 |
| --- | --- |
| 继续已结束的 Wand PTY | 通用 resume，尽量复用 Wand ID |
| 从 provider 原生历史恢复 | provider-specific resume；可新建 Wand 壳，structured 不自动导入全部原生日志 |
| 停止 structured | 当前回合结束，会话回 idle，仍能发消息 |
| 停止 PTY | 停终端进程；与仅 provider CLI 退回 shell 不同 |
| 删除会话/任务 | 可能包含终止执行、历史清理、worktree 强拆，必须清楚提示范围 |
| 通知点击 | 由 session ID/deep link 找回任务上下文，而不是再创建一条会话 |

批量清空在任务操作中已经存在，不再需要从零恢复旧平铺列表。隔离任务删除默认级联与非隔离默认解绑不同。通知/Live Activity/launcher 快捷方式分别有自己的 store，回退与进程重建需验证 ID 仍可达。

## 9. 工作空间、分屏与布局

Web：任务详情 → reconcile 布局 → 终端池/文件页签 → 保存 layout；打开任务也可能触发布局修复写回。保存失败当前有忽略异常的位置，不能认为服务器必定保存成功。

原生 WorkspaceStore/WorkspaceWorkflow 负责窗口创建、会话 binding、布局对账和工作树审查。Android 已有创建 workspace、worktree overview、merge Agent API/UI，不再是“完全没有项目创建和合并”。是否所有项目增删改入口都与桌面一致，仍需按 UI 可达性验收。

跨端同时改 layout 没有 revision/CAS 防覆盖；任务 A/B 请求乱序也属于这一条链路（R11）。应先明确恢复与保存 Interface，再重构代码，而不是再加一层镜像 store。

## 10. 议题看板、GitHub、Missions 与 Inbox

### 任务管理

Web 主区 iframe，经 ready/ready-request 握手结束 loading；超时显示失败/重试。打开绑定会话使用 postMessage，并校验 origin/source。

卡片「派发 Agent」选 provider/model/thinking → `POST /api/wand-tasks/:id/dispatch` 创建 structured + binding + prompt。它不是把 WandTask ID 填进 workspaceTaskId。provider 切换会丢弃不在新目录里的模型，未加载目录时提交 `default`。

当前 session ID 在 iframe 创建时放进 query。切换/重新打开时必须核对上下文；卡片 binding 的一次性 loaded 标志也不是实时状态同步机制。看板内置 AI 与 Wand Agent 的执行、权限、数据目录不应混淆。

### GitHub

设置中连接 token；Issues 对话框输入 owner/repo → 列 issue → 为每个 issue 读本地绑定。服务端代理要求 admin。

当前 owner/repo 是可编辑 state，而已加载列表没有固定的 loadedRepo 身份；输入改为 B 后操作仍显示的 A issue，可能对 B 的同号 issue 操作。创建按钮也缺少 pending 去重，列表加载是 1+N 请求。服务器连接校验另有晚到失败回滚问题（R05）。

### Missions / Inbox

自动化创建 mission，打开 attempt 只是 selectSession；diff/review 有独立 API。Missions 可以关联 WorkspaceTask，但仍是不同实体。

Inbox 服务端和 CLI 已有；Web Missions 不消费 `/api/inbox`，没有因此自动变成收件箱。跨端是否新增统一 Inbox 入口是产品计划项，不是修复一个“空后端”（R12）。

## 11. 文件、快捷提交与设置

- Web 文件树/预览/编辑器经独立 repository/controller；macOS 有原生文件面板，移动端有预览/网页兜底。
- Web editor 草稿在内存，当前保存没有外部版本条件，能覆盖 Agent 刚改过的文件（已复现，R04）。
- 快捷提交共用服务端 REST，但生成文案也会 `git add -A`；取消弹窗不代表暂存区没变（R10）。
- 设置区分部署项与会话偏好；App 自己的 APK/IPA/DMG 与服务端 npm 更新是两条线。
- 语音最终进入 composer/send 链路：iOS SpeechRecognizerService；Android VoiceInputController + VoiceSessionStateMachine（recording/canceling/awaiting_final）。迟到 final、取消与切会话应只提交一次，不能另起不受保护的输入路径。

## 12. 本地状态与恢复保证

| 状态 | 当前主要位置 | 不应误认为 |
| --- | --- | --- |
| Web 输入/附件/AskUser 选择 | Legacy state / 内存 | 已持久化到服务器 |
| Web 跨会话队列、侧栏/外观 | localStorage | structured 服务端队列 |
| Android 会话草稿 | SessionDraftStore + Saver | 所有冷启动场景都永久保存 |
| iOS/macOS composer 与选择 | View/ChatStore 等 | 跟服务端 Snapshot 同生命周期 |
| 原生 endpoint/token | ServerStore/ServerProfiles/Auth | 可以跨服务器重用 cookie |
| xterm/fit/滚动/贴底 | Web runtime / terminal-pool | 新 init 必須重放全量 transcript |
| 任务管理状态 | `/api/wand-tasks` | WorkspaceTask 布局的一部分 |

草稿持久化如要扩展，应先确定 endpoint+session 分区、过期清理、敏感信息处理与上传孤儿文件策略，不默认把所有聊天明文长期落盘。

## 13. 已纠正的端间能力表

| 能力 | Web | iOS | Android | macOS |
| --- | --- | --- | --- | --- |
| composer PTY 拆包 | 已有 | 已有，含 AskUser | 已有，含 ChatStore | 已有，含聊天路径 |
| title/titleGenerating/任务 binding | 已有 | 已有 | 已有 | 已解析，不再是 DTO 缺口 |
| 任务内 structured / PTY / shell | 已有 | 已有 | 已有 | 已有 |
| SDK pending 审批 | 已接 | 已接 | 已接 | 已接 |
| 模型 mutation 乱序保护 | 队列/revision | 尾队列/revision | Mutex/generation | 待对齐 |
| `/api/tasks` revision 快路径 | 未用 | 未用 | 已用 | 未用 |
| 聊天块预算 | 当前主要 turn 窗口 | REST+WS 块预算 | turn 窗口 | API 部分支持，聊天未完整接入 |
| 议题看板/GitHub | 任务管理已接入；GitHub 仍为 Web 入口 | 任务管理已接入 | 任务管理已接入 | 任务管理已接入 |
| 客户端更新 | 服务端包管理 | IPA/OTA | APK | MacUpdateManager / DMG 路径 |

“已接”表示在当前代码里存在调用和处理，不代替本次未做的真机验收。

## 14. 排查速查与后续计划

1. 明确客户端、endpoint、会话 kind/owner，以及 WorkspaceTask/议题/Mission 的真实 ID。
2. 输入异常查 §6；不要继续照旧计划修已经消失的 `text+"\n"` 分支。
3. 回复丢失/卡住查 HTTP 与 WS 的到达顺序、seq、activeRequestId、消息窗口 offset。
4. 任务标题与内容不符查 openTask 跨任务 generation、layout 保存回包，而不仅是侧栏高亮。
5. PTY 显示错位先查 fit/字号；structured JSON 中文变 `�` 则查字节流解码。
6. 更新 403 查 principal；App 版本更新不等于服务端更新。
7. 本轮 Apple WebView 契约测试失败：断言要求 `.notification-bubble.update-card`，iOS 当前注入更宽的 `.notification-bubble` 隐藏规则。先验证实际行为，再修正测试，不能据此断言通知必定露出（R14）。

优化计划按 R01–R14 排期；历史任务一级容器完成记录保留在 `task-first-rollout.md`，只作为历史，不覆盖本文当前基线。
