# AGENTS.md

本文件是本仓库所有编码 agent 的**唯一操作指南**。历史设计与分析文档已移除，后续调整以本文和源码为准。

## 项目记忆

- 后续所有 Wand 功能验收、真机验收和最终端到端验收，统一使用这台机器上已安装运行的 Wand 服务，以及用户指定的连接码；连接信息读取本机私密文件 `~/.wand/acceptance-connection.json`（`serverURL` / `connectionCode`）。不要使用隔离服务、mock 服务或另建测试实例代替最终验收。连接码包含鉴权信息，不得写进仓库、提交、日志或截图。单元测试和开发期隔离检查仍可使用独立环境。

- 只要当前项目的 Android 客户端发生改动，收尾时必须重新编译带版本号的 beta APK，并部署到 `~/.wand/android/` Beta 更新目录；同时验证 `/api/android-apk-update?currentVersion=0.0.0&channel=beta` 能返回新版本。除非用户明确要求跳过，否则不得省略。
- 只要当前项目的 macOS 客户端代码发生改动，收尾时必须重新编译带新版本号的 Beta ZIP/DMG，并部署到已安装 Wand 服务的 `~/.wand/macos/` 更新目录；用本机已安装客户端的真实版本请求该服务 `/api/macos-app-update?currentVersion=<已安装版本>`，确认返回新版本且 `updateAvailable: true`，并核对下载文件可用。不要用只留在 `macos/build/` 或 `macos/dist/` 的构建代替分发验收。除非用户明确要求跳过，否则不得省略。


`wand` 是本机 AI CLI 工具的 Node.js Web 控制台，支持 Claude Code、Codex、OpenCode、Grok、Qoder、Pi、Gemini 七个 provider。Express + WebSocket 服务浏览器 UI；会话跑在 PTY 或结构化非 PTY 进程里；PTY 由**独立的 terminal daemon**（`wand terminald`）持有，web 重启 / 自更新不杀 shell。配置、鉴权、会话状态持久化在激活配置文件所在目录。

- Runtime: Node.js `>=26.10.0`（仓库 `.nvmrc` 固定构建/CI 版本；`nvm use`）, TypeScript, ESM。
- 默认 config: `~/.wand/config.json`；SQLite: `~/.wand/wand.db`；会话制品: `~/.wand/sessions/<sessionId>/`。
- `-c /path/to/config.json` 隔离以上全部（隔离测试统一用 `/tmp/wand-dev/`）。
- 单实例按 config 路径隔离：已有实例时 `wand web` 走 IPC attach，不开第二个 server。

原生客户端与 Render 都是 git submodule：

| Path | Repository | 作用 |
| --- | --- | --- |
| `android/` | `co0ontty/wand-android` | Android 客户端 |
| `ios/` | `co0ontty/wand-ios` | iOS 客户端 |
| `macos/` | `co0ontty/wand-macos` | macOS 客户端 |
| `render/` | `co0ontty/wand-render` | **Render 源码**（Rust 常驻进程，持有 PTY / 输出 journal / VT 屏幕模型） |
| `render-bin/` | `co0ontty/wand-render-bin` | **Render 产物**（各平台二进制 + `manifest.json`，只由 CI 写入） |

服务端开发/构建只需 `git submodule update --init -- render-bin`；修改 Rust 时另检出 `render`，修改原生客户端时另检出对应平台。不要默认递归检出全部子模块。未检出 `render-bin` 时 npm 包里没有 Render 二进制，`engine=auto` 会回退 legacy 并打警告。

## Server / Render 分离（不可破坏的边界）

Server（本仓库，Node）与 Render（`render/`，Rust）是两个独立进程、两个独立发布节奏：

| | Server | Render |
| --- | --- | --- |
| 拥有 | HTTP/WS、鉴权、SQLite、业务、聊天与权限投影、Web 资产 | PTY 进程、输出 journal、VT 屏幕模型、退出状态 |
| 生命周期 | 随 npm 升级重启 | 独立 detached 进程，**Server 重启不停** |
| 版本 | `package.json` | `render/Cargo.toml` + `render-bin/manifest.json` |

- 契约（权威）：`render/docs/render-protocol.md`；
  Rust 类型真源 `render/crates/wand-render-protocol/src/lib.rs` ↔ TS 镜像 `src/render-protocol.ts`。
  改协议必须同时提升 `RENDER_PROTOCOL_VERSION` 并同步两侧与该文档。
- 引擎开关：`render.engine = auto | rust | legacy`，环境变量 `WAND_RENDER_ENGINE` 优先。
  `protocolVersion` 不匹配时**拒绝启动**，不做降级运行。
- **Render 的更新与 Server 的更新分开**：Render 改完以后在 `render/` 内提交并 push，再回主仓库 bump 子模块指针；
  发新产物则在 `render/` 打 tag，CI 会把产物推进 `render-bin/`，主仓库再 bump `render-bin/` 指针。
  两个指针互相独立，可以只换二进制不换源码。
- 永不交叉领养：Render 与 legacy `terminald` 的 socket/token/pid 文件名刻意不同，升级期两套并存，
  旧会话继续由 legacy 服务直到自然结束（无损升级的实现方式）。
- 开发态与分发布局：`render/target/release/wand-render`（开发）→ `<configDir>/bin/wand-render`（就位）→
  `dist/native/<triple>/wand-render`（npm 包内嵌，由 `npm run build:render-bin` 从 `render-bin/` stage，校验 sha256）。
- 端到端验证：`scripts/verify-render-e2e.sh`（隔离实例+新端口，验 Server 重启后 PTY pid 不变、
  Render 崩溃自愈、drain 保留 PTY、Web/Android 两种 profile、回滚路径）。
- 无损升级验证另有一个独立入口，别当死代码删：`scripts/verify-render-upgrade-e2e.sh`
  （legacy 引擎下跑着旧会话 → 直接升级到 rust → 旧 PTY 全程存活并由 legacy 继续服务、
  新会话归 Render、回滚不破坏会话）。`verify-render-e2e.sh` 只覆盖 engine=legacy 的就地回滚，
  不覆盖这条跨版本存活路径。

## Common Commands

```bash
bash scripts/verify.sh      # 一键质量门：品牌资产 + 原生图标 → npm run check → npm test（与 CI 同序）
npm install                # 依赖安装
npm run check              # bundle tailwind/xterm/qrcode/browser → 再生成 embedded assets → tsc（server + browser + react 三套 tsconfig）
npm run build              # 全量：vendor bundle → 生成内嵌资产 → tsc 编译 → 拷贝/压缩 web 内容进 dist/ → bundle 预算门禁 → stage Render 二进制（best-effort）→ stamp build-info.json → 修权限
npm test                   # node:test 套件（tests/*.test.ts）
npm run dev -- -c /tmp/wand-test/config.json   # 隔离开发实例
```

定点运行：

```bash
node --test --import tsx tests/password-manager.test.ts
node --test --import tsx --test-name-pattern "vaults" tests/password-manager.test.ts
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json   # QA 冒烟服务器
```

没有 lint / format 脚本。测试用 `node:test` via `tsx`。

`tests/fixtures/structured-cli-recordings/` 是入库的 provider 真实输出样本，唯一再生成入口是
`node --import tsx scripts/capture-structured-cli-fixtures.ts --record`（必须显式 `--record`；
会真的调用本机 CLI 并消耗额度，失败/超时也不会落盘原始 stdout/stderr）。别当死代码删。

## Runtime Map

调试从这些链路入手。查任何会话 bug **先看 `SessionRegistry.ownerOf(id)` 是 `structured` / `pty` / `storage`**，再进对应 manager：

```text
CLI/startup:        src/cli.ts -> src/server.ts
Terminal daemon:    src/server.ts -> src/terminal-daemon-client.ts -> src/terminal-daemon-server.ts
PTY sessions:       src/server-session-routes.ts -> src/process-manager.ts
Claude PTY 解析:    src/process-manager.ts -> src/claude-pty-bridge.ts
Structured runs:    src/server-session-routes.ts -> src/structured-session-manager.ts -> src/structured-*-adapter.ts
统一查找:           src/session-registry.ts -> src/session-transport.ts
Workspaces:         src/server-workspace-routes.ts + src/web-ui/react/workspaces/
Missions/Inbox:     src/missions.ts + src/server-mission-routes.ts
WebSocket fanout:   src/ws-broadcast.ts -> src/web-ui/browser/websocket.ts
```

关键所有权边界：

| Area | Files |
| --- | --- |
| CLI、单实例 attach、service:* 命令 | `src/cli.ts`, `src/pidfile.ts`, `src/tui/*` |
| Express 组合根、静态 UI、WS 挂载 | `src/server.ts`（路由分散在 `server-*-routes.ts`） |
| PTY 会话（权限弹窗、resume、归档） | `src/process-manager.ts` |
| Structured 会话（多 provider 流式） | `src/structured-session-manager.ts` + `src/structured-{claude,codex,opencode,grok,qoder,pi,gemini}-adapter.ts` |
| SQLite 持久化与只加不删迁移 | `src/storage.ts` |
| 共享契约 | `src/types.ts`、`src/provider-catalog.ts`（provider 列表/别名/推断的唯一真源，服务端与浏览器 bundle 共用） |

两套 runner 共享类型和存储，**不共享执行代码**；改一边不会自动影响另一边。结构化 CLI 在服务重启后恢复连接时，也必须登记进与新启动 runner 相同的运行所有权表；恢复等待期的新输入继续排队，恢复失败重试不能遗忘 daemon 记录。停止、队列立即发送与旧退出回调都受当前请求代次保护，服务关闭只断开持久进程的连接。

Claude structured 走 `claude-cli-print`（`claude -p --verbose --output-format stream-json`）——和其他 provider 一样是 spawn 本机 CLI，没有运行时权限提示；`@anthropic-ai/claude-agent-sdk` 及其 `canUseTool` 审批桥、按消息的 skills 白名单已整体移除，`runner: "claude-sdk"` 只是历史值，读旧会话时归一为 `claude-cli-print`。

## Session 输入契约（最容易写错）

PTY 输入服务端原样写入终端，客户端必须拆成**先文本、后单独 `"\r"`** 两包（快捷键回车标 `shortcutKey = "enter_text"`）；不要用 `text + "\n"` 代替回车。参考实现：Web `getTerminalSubmitChunks`、iOS `sendPtyInput`、Android `PtyTerminalScreen.sendPtyDraft`。

Android 结构化输入统一走 `sendStructuredInput`，始终请求 `respondImmediately: true`：该字段只控制 HTTP 回执时机，不控制队列调度或中断。是否排队由服务端当前运行所有权决定；composer 收到接受回执后清空本次提交的内容，期间新输入继续受 revision 保护。

`SessionSnapshot.claudeSessionId` 名不副实：存的是各 provider 的原生 resume 标识（Claude UUID、Codex thread、OpenCode/Grok/Qoder 会话 ID、Pi `--session`、Gemini `--resume`）。恢复逻辑横跨 `process-manager.ts`、`resume-policy.ts`、`storage.ts` 和各 provider 历史目录，时间窗兜底只在候选唯一时绑定。

角色 / 规则这类「系统提示」不要拼进首条用户消息：会话级系统提示统一走 `SessionSnapshot.systemPrompt`（持久化在 `session_options`；PTY 与结构化都是）。入口两个：服务端内部调 `dispatchAgentForTask` / `createSession` / `processes.start` 时传 `systemPrompt`，客户端开会话时在 `POST /api/commands`（`initialInput` 旁）或 `POST /api/structured-sessions`（`prompt` 旁）传 `systemPrompt`。由 `structured-provider-common.ts` 映射到各 provider 自己的开关——Claude / Qoder / Pi 是 `--append-system-prompt`，Grok 是 `--rules`；Codex / OpenCode / Gemini 没有这个入口，只在首条消息用 `promptWithSystemFallback` 并接一次。

一次性 AI 调用同理（commit message / tag、提示词优化、任务标题、会话标题、快捷提交兜底执行器）：用 `AiTextRequest { system, prompt }`（`src/types.ts`），规则进 `system`，执行走内置「系统运维」员工的 CLI 候选链（`callConfiguredAiText`）；CLI 走 `systemPromptFlag(provider)`，没开关的 provider（Codex / OpenCode / Gemini）用 `composeSystemFallback` 并入内容。**没有直连 API 分支**：API 线路、`systemAi` 偏好与 `commitAiSource` 已整体移除，`pref:systemAi` / `pref:commitAiSource` 的历史值留在库里但不再被读取。

会话标题的来源优先级固定为「原生 CLI 标题 → 内置系统运维员工」，两侧（`process-manager.ts` / `structured-session-manager.ts`）都只在 `maybeGenerateSessionTopic` 一处编排，逻辑收在 `session-topic.ts` + `native-session-title.ts`：

- `SessionTopicCoordinator.run` 每轮先读 `request.readNativeTitle()`：provider 自己在运行期写下的标题——codex `~/.codex/session_index.jsonl` 的 `thread_name`、qoder 转录里的 `ai-title`、OpenCode SQLite `session.title`（占位名 `New session …` 不算）、grok `summary.json` 的 `generated_title`——命中即直接落库，**不发起任何模型调用**；Claude / Pi / Gemini 没有这个入口，返回空串。读取按文件 mtime+size 缓存，任何异常都当「没有原生标题」，不能因为取标题失败让会话没名字。
- 取不到原生标题才回退系统「勤劳的初二」：走 `resolveSystemAiContext(..., getSystemSiliconEmployee())` 的候选链（`callConfiguredAiText`）。每个会话都要有标题：输入到达时先落 `provisionalSessionTopic` 的首行标题，模型成功再覆盖，模型失败/垃圾输出保留已有标题，不写空串。
- 原生标题优先于模型标题：`SessionNativeTitleTracker` 按会话记住已确认的原生标题，此后模型候选与输入首行都不再覆盖（`SessionTopic.source === "native"`），但每轮输入仍重读一次原生源，CLI 改名能跟随；这份状态只在内存，重启后重新读原生源。


## Web UI 与生成文件

先验证并清理失效实现，再调整保留组件的样式。运行时边界以上面的 Runtime Map 为准。

扫 legacy 残留（React 迁移删了渲染层、留下查询与写入）用 `npm run audit:remnants`。

前端是服务端渲染的单 HTML shell + 构建期打包的前端资产（脚本/样式/vendor 按内容指纹单独请求，保留内嵌回退），浏览器侧有**两层并存**：

- Legacy vanilla-TS 层：`src/web-ui/browser/*.ts`（entry `main.ts`）— 终端、聊天渲染、WS、输入
- React 层：`src/web-ui/react/*.tsx` — Shell、新建会话、设置、工作空间、任务、文件预览/编辑器等

回滚开关：`?reactUi=0` 只关通用 React 对话框/通知层（退回原生 confirm/prompt + legacy 气泡）；**认证后的 Shell 没有回退开关**，React Shell 始终挂载。`?reactShell=0` 已随 legacy Shell 一并删除。React 通过 `*-adapter.ts` 调 legacy 的 `selectSession` / 终端池。

手编源码：

- `src/web-ui/browser/*.ts` + `src/web-ui/react/*.tsx`
- `src/web-ui/content/styles.css`
- `scripts/` 下的 entry

生成产物（禁止手改）：

- `src/web-ui/content/scripts.js`（esbuild 打包两层 browser 代码，不入库）
- `src/web-ui/content/ai-teams.js`（AI 团队/群聊按需 chunk，不入库）
- `src/web-ui/content/tailwind.css`（Tailwind v4 编译产物，不入库）
- `src/web-ui/embedded-assets.ts`（压缩 base64 内嵌，不入库）
- `src/web-ui/content/vendor/xterm/*`、`content/vendor/qrcode/*`（vendor bundle）
- `dist/` 全部

```text
browser/*.ts + react/*.tsx -> scripts/bundle-browser.js -> content/scripts.js + content/ai-teams.js
                           -> scripts/generate-web-assets.js -> embedded-assets.ts
src/web-ui/css/appica.css -> scripts/bundle-tailwind.js -> content/tailwind.css
scripts/xterm-entry.js     -> scripts/bundle-xterm.js     -> content/vendor/xterm/*
scripts/qrcode-entry.js    -> scripts/bundle-qrcode.js    -> content/vendor/qrcode/*
```

升级 `@xterm/*` 或 `qrcode` 后要重跑对应 vendor bundler。`npm run build` 必须保持把 `src/web-ui/content/` 拷进 `dist/web-ui/`，否则打包版坏。

`src/web-ui/index.ts` 只返回轻量 no-store HTML；主脚本 `/assets/app.js?v=<内容指纹>`（含当前 configPath 与团队脚本地址）、合并样式 `/assets/app.css?v=<内容指纹>` 与 vendor 都单独请求，命中指纹后可浏览器缓存；JS 因包含实例路径用 `private`。`scripts.ts` / `styles.ts` 保留嵌入回退，保证 npm 自更新短暂删除磁盘产物时旧进程仍能服务。`scripts/check-bundle-budget.js`（`npm run check:bundle-budget`，构建末尾执行）分别约束复访 HTML、首次加载完整字节、主 JS/CSS、按需脚本，不能通过换成外部资源绕过预算；调高阈值必须在同一个提交说明首载/缓存影响。构建与 CI 的 Node 版本统一取 `.nvmrc`。

Raw PTY 输出和结构化聊天 turn 是同一会话的两种表示；渲染 bug 先查 provider parser / WS payload / `chat-render.ts`，别急着怪 CSS。

## 任务与输入状态的唯一所有权

- `wand_tasks` 拥有标题、状态、工作区归属、迭代与 Agent 元数据；`workspace_tasks` 拥有 cwd、worktree、layout、revision 与 last opened。通过 `storage` 的创建/修改/会话移动入口原子更新；旧侧栏/看板 DTO 从同一事实源投影，不得在 GET 或路由中重新增加双向同步/全表修复。
- 当前会话任务归属只看 `command_sessions.workspace_task_id`，历史关联表不决定独占归属。移动后刷新 SessionRegistry，runner checkpoint 不得回写旧归属；原进程、cwd、历史与输出继续保留。
- 对话/终端「刚完成」是完成但未查看的展示态，不是任务卡状态，也不改变 runner 的 idle/running/exited/failed/stopped。`command_sessions.completion_revision` / `viewed_completion_revision` 归 storage 单独原子写入，checkpoint 不覆盖；成功回合结束、PTY busy→idle 或 CLI 正常退出记录新代次，旧历史默认0不回填。`POST /api/sessions/:id/completion/view` 按客户端实际看到的代次 CAS 确认并推送跨设备状态；普通 GET、后台轮询、重连和自动选中最近会话不算查看。Web 只在明确打开后的可见视图确认，Android 只在已加载且 RESUMED 的会话/终端页确认。刚完成纳入活动/「在跑」筛选，但不计入真正运行中的数量；查看后恢复原有完成展示，新一轮完成再次未读。
- Web `browser/composer.ts` 拥有按会话的草稿、附件、提交恢复和队列 freshness；React、DOM、input 与 WebSocket 通过它的入口修改。异步优化/上传绑定会话与 revision，删除会话清理附件 URL，迟到结果不得复活会话或覆盖新输入。
- PTY 的「运行中」资格看实时内核事实：Server 每秒采样运行中 PTY 会话的终端前台进程组（`src/pty-foreground.ts`，darwin/linux 的 `ps -o tpgid`；前台不是 shell 自己的进程组就说明 CLI 在前台），再配合输出静默窗口得出 `ptyBusy`。**不得**只靠一次性的 `providerCliActive` 启动标记——CLI 在同一个终端里退出后再启动（自更新、手动重跑）会让该标记永久失效，任务就再也不显示运行中。采样不可用时才回退该标记；无 provider 的纯 shell 终端不参与跟踪。
- Android 会话级 `ChatComposer` 拥有提交锁、上传与发送反馈，`SessionDraftStore` 拥有按会话的未发送内容；`ChatStore` 仍拥有聊天、PTY/structured 协议、权限与队列。页面只投影状态，dispose 时取消 composer；语音/上传回调绑定启动时会话。
- 未知送达的已提交内容只留内存；部分 PTY chunk 已接受、成功 ack 后解析失败、5xx/408/409 都属于未知。只有输入被接受前的明确拒收或本地未发送才可恢复持久化；不得取消重复提交保护，也不得改变 native PTY 的分包契约。
- 普通工具的 `preview` 是服务端 `tool-preview.ts` 生成的有界只读输入/结果摘录（每块最多180字符），在 compact 清空正文前保留；不额外调用模型、不改历史，完整正文仍按单条点击加载。外层活动分组**收起时仅显示数量概览与状态，不显示具体参数/结果**；展开分组后，各工具条目直接显示操作对象、关键参数与结果摘录，单条再展开才请求完整正文。Web/Android 共用这一字段，旧数据回退已有可用信息；运行/失败/展开项高亮使用现有主题与动效 token，状态点固定占位。
- Android sherpa 只编译 `app/libs/sherpa-onnx-api-1.13.2.jar`；固定来源/hash 与复现工具见 Android README。完整 AAR 不入库，常规构建/单测不下载大产物。
- Android 工具折叠由 `isCollapsibleActivityTool` 按用途判定，不能用 `activity != null` 当资格；`activity` 只是服务端 compact 投影元数据。普通调用、旧格式调用与待办操作（含 `Pi/todo`）默认进入时间线，任务进度仍读取 `ToolUseSemantic.TaskList`；提问、子 Agent 派发、图片与本地决策保持独立。活动段、外层回复头与探索分组复用同一资格判断，迟到的跨 turn 图片/决策结果也要识别；决策卡自身默认收起详情，用户点击卡头原位展开/收起，与活动分组的折叠是两个层次。

AI 团队改名：`ai_team_runs.team_json` 是执行快照，relay `ConversationTurn.author` 与正文是历史事实，不批量重写。`AiTeamRunner.detail().displayTeam` 按稳定成员 id 从当前团队定义投影名字/头像，删除定义或成员时退回运行快照；Web/Android 仅在渲染时替换署名，不改变消息指纹/去重/派工。团队 PUT/DELETE 用独立定义变更通知刷新展示与团队轻缓存，不能把进度通知当作配置变更。

群聊名固定为「任务标题 + 任务处理群」，不是团队名。新建 relay 标题与入群提示共用 `aiTeamChatTitle()`；已有群聊的列表与详情通过 `chatTitle` 只读投影当前任务标题（优先当前会话的任务归属），任务改名即跟随，不批量改历史消息或执行快照。Web 合并详情按独立的 `chatTitleUpdatedAt` 防止旧请求回退群名；Web/Android 页头使用该展示字段，团队名只表达团队身份。

团队成员成功交付报告时，群聊投递 `ConversationTurn.reportFile` 文件卡片，不重复整份报告正文。服务端在完成时从真实文件冻结有界 `preview`（标题最多100个字符、摘录最多240个字符/3行，优先结论/摘要），不额外调用模型；Web/Android 的列表只显示该投影，完整内容点击后走公共文件预览/下载。原文件保持完整，负责人交接照常读取文件；旧消息缺预览时只显示文件身份，不补造摘要、不批量改写历史。约定报告路径优先；成员明确交付其他报告链接时，只认可工作目录内、步骤开始后新产出且唯一可确认的本地 Markdown 文件（含 symlink 越界检查），步骤的实际报告路径与负责人交接一起落库，不能把「已写入」回复当作真实文件正文。

团队交付概览：`AiTeamRunDetail.delivery` 是同一 run 的可选只读投影；结论只取 done 后的负责人说明，不视为代码验证成功或任务已验收。文件只取当前已完成工作步骤匹配的 relay `reportFile` 冻结记录（最多20条、总数明确），接力只取现有 running/queued 与真实未完成依赖（最多6条）；先从完整 relay 投影再截尾聊天200条。GET不读正文/知识/私聊，不改任务状态、completion/viewed或历史；旧数据不凭 reportPath/正文造文件，缺preview仅身份，历史交付不承诺文件现在可用。Web/Android共享字段并使用现有预览/下载，点击前不读正文；复用原位上下文与提交实例，显式展开按runID保留。相同revision的缺字段、较少total/满20条窗口丢旧身份、完整preview变空不能回退；明确较新源无字段须清旧投影回退原UI。任务、群聊和团队运行历史加载都守真实请求/动作回执代次，不让旧GET或另一scope覆盖当前完整结果/草稿。

交付UI、快照合并与历史scope保护仍只进ai-teams按需包：45,569→47,523B gzip（+1,954B），按需门限48,000B；同输入主JS543,093B/CSS99,057B不变，首载755,158B，其他门限/内容指纹缓存保持。不同并行UI修改的传输差异不归此功能，安装更新只替换已核对的后端投影、按需包与以当前安装主脚本/样式生成的内嵌回退。

硅基员工定义由 `silicon_employees` 持有，按顺序保存结构化 CLI 候选；会话在创建时保存员工名字、头像、候选与实际候选下标的快照，删除定义后历史聊天仍按快照显示。员工候选只在 CLI 无法启动且首条输入尚未被接受时尝试下一位；已接受输入、运行中错误和未知送达不能自动重试。任务执行主体由 `wand_tasks.execution_subject_json` 持有，`employee` / `team` / `cli` 只用于结构化任务，PTY 始终只能选 CLI；任务路由与会话路由都要验证此边界，不能只靠客户端隐藏选项。Web/Android 的联系人与聊天署名从当前定义投影，历史消息正文不改写。

员工入群：`AiTeamMember.employeeId` 是可选的通讯录绑定，不按名字猜身份。员工拥有名字、头像、基础角色与结构化 CLI 候选，团队拥有分工、role 与负责人；旧客户端按同一 member.id 省略 employeeId 保留绑定，显式 null/空串才解绑。新开工验证真实、未归档员工并冻结所有关联成员的角色/候选；关联员工的基础角色等私有执行信息仅在 run storage 私有字段中持久化，不作为新增公共 DTO 字段返回，也不写入团队定义或历史 author。运行中替换/改名不回写执行身份；展示只投影原员工的当前名字/头像，删除后退回快照并阻止新开工。实际步骤 session.employeeId/候选下标归启动快照，运行时仍只读自己的有界知识，不复制私聊、其他员工知识或默认伙伴的短期习惯。

团队是绑定员工的唯一候选调度者，manager 不再叠加员工私聊降级。只有真实当前请求的明确未接受启动失败，才能单次降级工作成员；服务端私有 UUID 事实最多1024条、仅内存、标题/展示更新不使其失效，新请求/stop/delete/dispose使其失效。已接受、未知送达、旧回调与旧持久错误不推断重试；负责人沿用失败后等待用户的规则。普通员工私聊的既有启动前安全降级保持。目录/worktree不是文件系统权限沙盒。

Web/Android 团队编辑从通讯录原位邀请/替换员工，绑定身份/候选只读，分工与负责人仍可编辑。Web隐藏保活编辑页通过 useSiliconEmployees.enabled 不请求名单，迟到结果不改隐藏组件或团队草稿；选择器使用真实 React trigger/button ref，Portal只认自身所有权。新逻辑保持按需加载：ai-teams实测43,674→45,569B gzip，门限44,000→46,000B；共享可见性保护/triggerRef使主包与首载仅+121B，首载754,643B，CSS98,910B和复访HTML1,012B不变，其余门限及内容指纹缓存不放宽。

新建空白结构化对话可通过 `POST /api/sessions/:id/provider { provider }` 原位换 CLI（Android 欢迎页 Logo 入口）：先查 `SessionRegistry.ownerOf`，只允许未归档、idle、无消息/队列/运行/resume ID/自动化的交互式 structured 会话；PTY 与已接受输入的会话不得跨工具搬历史。会话ID、员工身份/系统规则/知识归属、目录/任务绑定和原候选快照不变，只更新实际工具与该工具的模型/模式/深度；候选链外的明确工具选择不自动换回其他 CLI。切换中保留同一个 composer 与草稿，不发送首条输入，不修改员工定义或全局默认。

### 内置「系统运维」员工（Wand 自有生成式 AI 的唯一执行者）

- 定义在代码里：`src/system-employee.ts`（名字「勤劳的初二」、职责、人设 Prompt、Tag「系统用户」），常量与 `isSystemSiliconEmployee` 放在 `ai-team-types.ts`（浏览器端要读 Tag，不能把依赖 `node:fs` 的模块拉进前端 bundle）。
- 存储：`silicon_employees.system_key = 'wand-ops'`（只加列，用户员工保持 NULL），`loadConfigWithStorage()` 里 `ensureSystemSiliconEmployee()` 幂等补齐，首次按用户已有的 `systemAiCli`/`systemAiModel`（没有则 `defaultProvider`）落首条候选；列表读取时内置员工永远排在最前。
- **名字/职责/人设/头像由服务端固定**：`PUT /api/silicon-employees/:id` 只接受 `agents`（锁定字段提交了不同值直接 400），`archive`/`unarchive`/`DELETE` 一律拒绝；只有执行候选（CLI 工具 + 模型 + 思考深度 + 顺序降级）由用户维护。
- Wand 自有生成式 AI 调用一律由它执行：commit message / tag、快捷提交兜底执行器、会话与任务标题、提示词优化、员工起草。人设走 `AiTextRequest.system` 前缀（`withOpsPersona`，任务自己的输出格式必须排在后面），执行走它的候选链（`resolveSystemAiContext(…, systemEmployee)` → `cliCandidates`）：跳过没安装的 CLI、已安装的先试、按顺序降级，整条链 150s 预算（每次调用受剩余预算约束）。
- 一次性文本候选必须同时通过 CLI / 协议状态与业务结果校验；退出码 0 或非空文本不等于成功。标题、员工起草、提示词优化、commit/tag 的解析与校验放在 `callConfiguredAiText` 候选循环内，格式不可用继续下一位。逐候选日志只记顺序/provider/错误码，不记提示词、路径或原始响应；执行过工具或未知送达的员工任务仍不走这条无条件重试路径。
- 候选里「跟随默认模型」必须在选举时就换成 `getDefaultModelForProvider(config, provider)`：不能把「CLI 默认」的牌子转给下一个 provider，也不能让它停在某个 CLI 自己坏掉的默认模型上。
- `systemAiCli` / `systemAiModel` 降级为兼容字段：只作为「内置员工不存在」时的兜底与首次 seed 输入，设置页不再编辑它们（设置页只读投影候选链，候选在「AI 团队 → 硅基员工」里改）。

### 默认任务伙伴与用户短期记忆

- 默认伙伴「赛博虎妞」独立于系统运维「勤劳的初二」，由 `default-employee.ts` 定义，`silicon_employees.system_key='wand-default'` / `id='e_wand_default'`。`loadConfigWithStorage()` 初始化时幂等补齐；名字、基础职责与基础规则固定（与系统运维一样是内置员工，`PUT` 只接受 `agents`，`archive`/`DELETE` 一律拒绝），用户可维护直接联系它时的结构化 CLI 候选。Android 原生员工页对内置员工只读锁定字段、不提供归档/删除；「勤劳的初二」默认不出现在首页顶部「发起对话」员工列表。
- CLI 是执行器、默认伙伴是角色：交互式新建 CLI 对话与任务派发未选员工时注入默认角色；明确选择员工/团队、显式自带 systemPrompt、系统内部自动化、普通 shell 和恢复会话沿用自己的规则。用户已选的 provider/model/mode/thinkingEffort 不被角色替换；隐式默认角色不启用员工的候选重发。PTY 仍只选 CLI，注入角色时同时保存员工 ID/名字/头像，菜单按该身份归入对应员工，执行器与模型选择不变；快照、重启与原 ID 恢复保留身份。旧 PTY 仅在保存了完整默认角色提示词（可含既有偏好段）时补充只读身份投影，不按 CLI 或角色名字猜测，不改历史正文。角色规则通过 systemPrompt 注入，不改变文本 + 单独 `"\\r"` 分包。
- `user_memory_events` / `user_memory_state` 是每个配置目录内单一用户的短期知识库；只记录有效交互提示词（含 wand-task 用户提示词）及 allowlist 内成功的任务创建/编辑/派发、团队开工、模型/深度/模式切换、上传、快捷提交、worktree 合并和提示词优化。只收新发生的行为，不回填旧记录；不读取登录/密码库/配置/文件/工具正文。敏感行、凭据模式、链接与本机路径过滤后最多600字符，记录最多1000条/30天，串行有界异步写入，不给输入加 IO 或模型等待。
- `UserMemoryService` 启动后台补检、每小时检查；至少3条证据才整理，最多每天一次，无新证据不重复调用；手动整理最短间隔1分钟。生成只走系统运维员工的 `callConfiguredAiText` CLI 候选链（150s总预算、候选内校验），最多10条沟通/工作方式/近期关注，每条160字符并引用真实记录ID，不把旧生成物反馈为证据。基础规则、权限和本轮要求始终优先；知识随证据过期或淘汰，模型失败保留现有角色。
- 记忆状态用 revision CAS；暂停或清空使排队写入与迟到生成失效，更新时保留最新员工候选，不改已有会话快照、历史消息或其他员工。清空的是短期知识库，不是会话历史；后台关闭不等待整个模型调用，迟到结果不再读写已关闭DB。
- `/api/user-memory`（GET/PATCH/DELETE）与 `/refresh`（POST）受登录及 sessions scope 保护，不返回原始提示词记录。Web默认员工原位展开后才获取记忆，可查看、暂停/恢复、整理、清空；按钮原实例/尺寸/位置保持，结果与失败留在原位。过滤并不保证识别任意秘密，用户不应在提示词中提交凭据；整理后的有界记录会交给所配置的 CLI 模型，不新增直连API。
- 默认伙伴记忆面板仅进 `ai-teams.js` 按需 chunk，主包注册表共享仓储通知。实测新增后 lazy 41,649B gzip（原40,201B），门限41,000→42,000B；首载仅增加15B、仍为732.2KiB，首次/复访与内容指纹缓存契约保持，未外置资源规避预算。

### 员工标签

- 员工标签存于 `silicon_employees.tags_json`（只加列），API 的 `tags` 为数组。内置系统运维员工固定「系统用户」，默认伙伴固定「默认用户」，标签按 `systemKey` 投影，不可修改、删除或由普通员工冒用；执行候选仍可维护。
- 普通员工可自定义、编辑和清空标签，最多8条、每条20字符，去首尾空白、去重并保序；保留标签与非法格式由服务端拒绝。旧客户端省略 `tags` 时保留已有标签，显式 `[]` 清空。标签只是分类资料，不改变角色、权限、会话快照或知识归属。
- Web 新建/就地编辑、标签搜索与 Android 通讯录/员工资料使用同一标签契约；两端内置员工不提供标签修改入口。
- 标签编辑/校验与原位保存反馈进入 `ai-teams.js` 按需包，实测43,674B gzip；仅按需包门限43,000→44,000B。当前首载750,957B、复访HTML1,013B，主包/首载门限不变，内容指纹缓存保留；未外置资源规避预算。

### 每员工独立知识库（明确记忆）

- 每位硅基员工（含默认伙伴和系统运维）以稳定员工ID拥有独立 `employee_knowledge` 命名空间；空库可直接使用，改名/归档/换CLI/换会话不改变归属。明确的知识没有30天过期，最多200条×4000字符，满库报错，不偷偷淘汰；员工删除时仅其知识与工具访问随FK删除，历史聊天保留。`user_memory_*` 仍是默认伙伴短期习惯，不代替其他员工的知识库。
- 员工结构化对话在实际启动本轮runner时读取自己的知识，按关键词/近期记录提供最多12条、8000字符的有界上下文；`runtimeSystemPrompt` 只在runner边界使用，不进session_options/DTO，不改基础角色或历史。Claude/Qoder/Pi/Grok走各自系统提示开关；Codex/OpenCode/Gemini每轮含resume时追加实时知识，基础systemPrompt仍只在首轮兜底一次。
- 直接以「记一下/记住/存到你的知识库」开头的明确要求，由Wand本地原子保存并把真实成功/失败回执交给员工；只处理真正开始执行的员工输入，排队/重复请求不提前写。条件句/示例/日志任务/「记得跑测试」不当知识；其他自然表达由员工按明确授权调用知识工具。文本是资料，不是执行指令，保存失败不能说记住了。普通员工私有对话和明确记忆不进入默认伙伴的自动习惯学习；明确前缀也不进入共享迭代/commit摘要，操作统计只记功能，不抄这些任务正文。
- 新增员工工具命令：`knowledge:remember <text> | --stdin`、`knowledge:search [query]`、`knowledge:forget <entry-id>`。由 `startEmployeeKnowledgeRunner` 注入 `WAND_KNOWLEDGE_DB` / `WAND_KNOWLEDGE_TOKEN` 到子进程环境；token不进argv/提示词/DTO/日志，DB只存hash，按本次session.employeeId绑定、最长6h，完成/启动失败即撤销。不接受employee/config选择参数，不默认转存默认伙伴；继承来的凭据先剥离。清空某员工知识同时撤销其旧工具凭据，写入在事务内复验，迟到stdin不能复活已清空内容。无命令权限的CLI不得绕过权限；标准明确前缀仍由服务端处理。
- 所有读写走storage按employeeId过滤的原子入口；知识不拼入普通用户消息或写到cwd里的README/AGENTS。允许知识里的正常文档URL/路径，实际凭据拒存而不是假装存入；这不是敌对本地进程的文件系统沙箱，CLI原有文件权限不被提升或降低。
- 管理API `/api/silicon-employees/:id/knowledge`（GET/POST/DELETE）及条目DELETE受登录+sessions scope保护，URL归属不受请求体employeeId覆盖。Web每张员工卡原位展开自己的知识库，按需读取、搜索、刷新、二次确认清空，内容窗口固定240px、确认反馈占原有行，清空不使触发按钮移位；grid展开在reduce-motion下关闭transition；不预取所有员工的知识，不用知识更新通知重置未保存的角色表单。清空不影响其他员工、短期习惯或聊天历史，Escape/取消/再点卡头/筛选与页面卸载收起并使迟到请求失效。
- 知识搜索在SQL里先限于当前员工最多200条，再由JS做Unicode大小写字面匹配、匹配后应用结果limit，避免SQLite ASCII-only lower漏掉Équipe/西里尔字母；Web与CLI共用。
- 新知识面板只进ai-teams按需chunk；lazy 41649→42586B gzip（+937B），门限42000→43000B；主包/首载保持约732.2KiB和既有内容指纹缓存，不外置资源或关闭预算。

### 通用本地决策（可选、实验性、只推理）

- 本地判定是独立于生成式系统AI的显式可选能力，不是第八种聊天provider，不自动派工、不替代权限/审批。标题、commit、提示词优化仍走系统运维CLI链，不新增云API兜底。
- 部署配置 `localDecision: { enabled, pythonPath, modelPath }`：默认关闭；`pythonPath` 是本机可信Python可执行文件的绝对路径，`modelPath` 是已下载的1024-token多语言Laya目录。Server只用这两个可信部署路径spawn包内 `decision-worker.py`，不接受HTTP中的命令/模型/文件路径。首期运行时支持macOS arm64，固定模型应由操作员校验；普通启动不下载大产物、不修改全局Python。
- `wand decision:configure --python <绝对路径> --model <绝对目录>` / `--disable` 保存配置，重启服务后生效；`wand decision:skills [--providers pi,claude,...]` 安装用户级技能，默认覆盖七provider。维护一份技能源，通过`.agents`、`.claude`、`.qoder`发现入口链接；保留同名第三方技能与用户编辑，不改CLI权限/MCP设置。已有会话可能需reload或新建后发现。
- `POST /api/decisions/evaluate` 接受有界 `state + questions`（choice/score/noul），`GET /api/decisions/status` 只投影无路径/凭据的状态。普通调用需要登录+sessions scope；会话能力只被这两条路由接受，不改变通用API鉴权。最多32KiB、8题、每题8选项；实际1024-token预算由worker复验，状态截断/选项折叠明确拒绝，不伪造完整判断。
- 七种结构化CLI在实际runner启动时获得本轮只推理能力（`decision_access`只存hash、绑定session、6h上限；完成/启动失败/interrupt撤销；新一轮撤销旧能力）。`WAND_DECISION_URL/TOKEN/CA/NODE/CLI`只进子进程环境，继承值先剥离；不进session DTO、持久化人设或Skill。服务重启后旧运行中的能力在有效期内可继续使用。PTY/普通shell与一次性文本自动化不隐式获得能力；Wand外命令不自动读取管理员凭据。
- `wand decide --stdin` 从标准输入读JSON，通过HTTP请求绑定服务；`--status`不加载模型。远程地址必须HTTPS，本机HTTP仅允许回环；TLS使用绑定证书并验证，不全局关闭TLS验证。不跟随重定向、不自动重试。Skill只教如何调用，不授予被禁止的命令权限。
- 每个Server只管理一份离线MLX worker（单独于Render生命周期），总排队上限8、每调用身份60次/分钟、45s绝对期限、空闲5分钟释放，worker错误/超时失败关闭，无无限重启。只处理调用者主动提供的最少证据，不读任何员工知识库/任务库，不保存推理正文，不把概率当准确率或操作授权。
- 结构化推理调用由 `decision-tool.ts` 识别官方CLI/Skill脚本的 `--stdin` 和直接HTTP推理入口，只读投影为 tool_use/tool_result 的 `semantic.kind='decision'`；不改原始名字、参数、结果或历史。读取Skill、`--status`、echo/grep文档示例不算推理。Web/Android单独显示「本地决策」卡，不进入活动/探索分组；卡片详情默认收起，只显示卡头与状态，用户点击卡头展开/收起。独立的按会话/调用ID折叠状态优先于默认值，刷新、结果迟到和结果独立分页不重置显式选择；通用工具的自动展开偏好不让新决策卡自动展开。聊天详情从卡头上方展开，卡头保持原位、收起倒放，动效使用既有token并支持减动效。独立可见的卡头仍计入窗口预算，传输不因卡内收起而丢掉结果；旧截断缓存的加载反馈原位显示，不用迟到缓存覆盖新完整结果。缩略卡头显示服务端投影 `semantic.kind='decision'.summary`：`decision-tool.ts` 的 `decisionCardSummary` 从请求体（heredoc 正文 / 内联 `-d`；`--data @file` 读不出要点）与结果 JSON 派生 `label`（结论 → 题数 → 被判定内容，另带 `mode/questions/preview/outcome`），有界、幂等、失败或读不出 `answers` 时不编结论、缺数据时退化为模式提示；同一调用的 tool_use 与 tool_result 携带同一份摘要（迟到结果页靠结果块自己的投影），Web 与 Android 只渲染这一个 `label`，不再各自解析原始 command/结果（两端只保留「本地决策」「实验性」与各自状态源）。

## State、Config 与目录

- Config 默认值与合并：`src/config.ts`。`loadConfigWithStorage()` 会把合并结果写回磁盘——改 config schema 必须同步它。
- SQLite 在配置文件旁边解析。迁移**只加列/加表，从不 DROP**。
- 状态分四桶：部署项（config.json）/ 偏好（SQLite pref:*）/ 密钥（SQLite，绝不回写 JSON）/ 大件（文件或 daemon 内存）。
- 上传写在 `<session.cwd>/.wand-uploads/`；worktree 在仓库根 `.wand-worktrees/`；分发文件默认 `<configDir>/android|macos|ios/`。

持久化看起来不一致时，同时查 `src/storage.ts` 和 `src/session-logger.ts`，它们互补而非冗余。

## 保留期：会话与任务同一套自动归档 / 自动清理

会话和任务是**同一套逻辑**，常量只定义在 `src/retention.ts`（`RETENTION_IDLE_MS` / `RETENTION_ARCHIVED_MS`，都是 7 天）：

- **7 天没活动 → 自动归档**：非运行中的会话按 `endedAt ?? startedAt`、任务按「`updated_at` / 容器 `last_opened_at` / 名下会话时间」的最新值判断；任务只要有名下会话在跑就永不归档。
- **归档满 7 天 → 自动清理**：会话按 `archived_at` 删除（`SessionRegistry.delete`，先清 worktree）；任务是 `wand_tasks.status='archived'` 的行按 `archived_at` 删除（`deleteWandTask`，解绑会话、保留历史）。
- 遍历由 `startRetentionTimer` 在 `server.ts` 启动（启动即扫一次，之后每小时一次，`unref`，`testMode` 下不跑）；`ARCHIVE_AFTER_MS` 在两个 runner 里也指向 `RETENTION_IDLE_MS`，避免「会话 24h、任务 7 天」两套口径。
- 历史行 `archived_at` 为 NULL 时只补写时间戳、绝不立刻删除，给用户留出恢复窗口。

用户手动归档与自动归档写**同一个标记**（`command_sessions.archived/archived_at`、`wand_tasks.archived_at`）：

- 会话路由 `POST /api/sessions/:id/archive|unarchive`、`POST /api/sessions/batch-archive`（`{ sessionIds, archived }`，返回 `failed`）；任务沿用 `POST /api/workspace-tasks/:taskId/archive` 与看板状态。
- `/api/tasks` 的 `workspaceSessionSummary` 带 `archived` / `archivedAt`，客户端在**加载后分拆一次**（Web：`react/workspaces/session-archive.ts` 的 `groupSessionsByArchive`）：正常列表只看活跃会话，归档的收进每一层自己的「已归档会话」折叠区（任务内一份、目录未分组会话一份），可恢复、需二次确认才删除；「只看活动」模式不渲染归档区。
- 侧栏批量管理的两个动作分开：主操作（secondary）归档任务 + 归档终端，危险按钮（只在选中终端时出现）才是真删除终端。
- 归档**不杀进程、不删历史**；`archived` 是软标记，`deleteWandTask` / 会话删除才动数据。

## 迭代与 commit 生成

「迭代」就是里程碑（同一张表、同一套路由），加了两条规则：每个任务都有归属（没选时落到
全局唯一的**默认迭代**，惰性创建、不可删、不可改挂工作区），以及把用户在这一轮里发过的
提示词标题记下来当 commit message 的默认输入（省 token）。

最容易改错的三处：

- 库里 `milestone_id IS NULL` 的历史行不搬家，只在**读路径**（`resolvedMilestoneFields`）
  兑成默认迭代，**写路径**（POST/PATCH/`createTaskForWorkspace`）落默认迭代 id。
- 提示词记录挂在输入热路径上：新增调用点必须保持「同步过滤 + 串行异步写入 + 永不抛错」，
  不能给普通输入加任何延迟或 IO。
- 未消费（`consumed_at IS NULL`）= 「上次提交以来」；提交成功就消费选中集合，
  diff 模式也消费（提交是仓库事实）。

## Browser Extension

MV3 密码库扩展在 `browser-extension/`，后端在 `src/password-manager.ts` + `/api/browser-extension/*`。扩展通过 `POST /api/login { client: "browser-extension" }` 拿 appToken；改密码会使旧 token 失效。后端改动跑 `tests/password-manager.test.ts`。

## Native Client Workflow

改 Android/iOS/macOS 代码的流程：

1. 在 submodule 里 commit。
2. push 子仓库（本地推送用 ssh URL）：`git push git@github.com:co0ontty/wand-<platform>.git HEAD:master`
3. 回主仓库 `git add <dir>` 提交指针。

只改主仓库指针而不 push 子仓库，CI 拉不到对应 commit 必挂。release workflow 用 submodule 指针判断「客户端无改动则跳过构建」。

### Android APK

```bash
cd android && SKIP_INSTALL=1 APK_DIST_DIR="$HOME/.wand/android" ./debug.sh
```

版本规则（必须遵守）：

- 版本号取最高语义 tag：`git tag --list 'v[0-9]*' --sort=-v:refname | head -1`，**禁止** `git describe --tags --abbrev=0`（多 tag 时可能返回旧 tag）。
- 文件名 / versionName 形如 `X.Y.Z-debug.MMDDHHMM`；versionCode 由 build.gradle 从 versionName 派生，不接受外部覆盖。
- 禁止直接分发未带版本的 `app-debug.apk`。
- 每次 Android 改动收尾都要重新编译带版本号的 beta APK 并部署到 `~/.wand/android/`（用户明确说不用才可跳过），并验证 `/api/android-apk-update?currentVersion=0.0.0&channel=beta` 返回新版本。

签名：仓库根的 `android/wand-release.keystore`（密码 `wand-release`）是 debug/release 共用的自签名 key。**绝不要换 keystore**——换了所有已装旧版都无法升级。

真机验证基线：`./gradlew :app:assembleDebug` → `adb install -r -d ...` → 截图检查 header、会话卡片、PTY 终端、输入栏。

Android 通讯录与员工/团队资料沿用 `Theme.kt` 的 `WandColors` / `WandShapes` / 字体及 `WandMotion`，不另建主题或设计文档。搜索复用 `WandInlineSearchField`，原位展开复用 `WandInlinePanel`，状态交叉淡入复用 `WandInPlaceSwap`，按钮加载与完成图标归 `WandStatusIconSlot`；系统减少动效时尺寸过渡也必须关闭。

- 通讯录点名字新建对话/群聊，员工与团队头像均进入对应资料；搜索名字、职责/说明、标签与团队成员，清空后焦点回搜索框，关闭时收起键盘。创建面板和列表共用滚动容器，内容最大720dp。
- 员工资料加载失败只显示原位重试，不开放空表单；内置资料只读，角色设定与候选原位展开。保存/管理操作期间保护输入与退出，反馈留在固定槽，失败保留输入。
- 团队刷新失败保留已有资料/协作/项目，已选项目失效须重选；开工绑定点击时的说明与项目，未知回执不允许盲目再派发，刷新只供核对结果。

### macOS DMG / iOS IPA

```bash
cd macos && ./build.sh <version>    # Universal Binary, ad-hoc 签名, dist/wand-v<version>.dmg
cd ios && IPA_DIST_DIR="$HOME/.wand/ios" ./build.sh    # 未签名 IPA 编完即丢进更新目录
```

- macOS ad-hoc 自签，无公证；换签名身份会让老用户被 Gatekeeper 拦截。
- macOS Beta 版本用最高语义 tag（`git tag --list 'v[0-9]*' --sort=-v:refname | head -1`）作基数，形如 `X.Y.Z-debug.MMDDHHMM`；用 `macos/build.sh <version>` 生成签名 ZIP/DMG，再把 `macos/dist/wand-v<version>.zip|dmg` 部署到 `~/.wand/macos/`。`debug.sh` 的未带版本构建不能供应用内更新。检查本机已安装服务的 `/api/macos-app-update?currentVersion=<已安装版本>` 必须返回新版本、`updateAvailable: true` 和同源 ZIP/DMG 下载地址，下载的大小与 SHA-256 也要核对。
- iOS 构建仍是 `CODE_SIGNING_ALLOWED=NO`。模拟器设备用真实存在的名字（`Wand Debug`、`Wand Live Activity QA`、`Wand iPad Debug`，见 `xcrun simctl list devices`）。
- 分发目录：默认实例 `~/.wand/macos|ios/`，隔离测试 `/tmp/wand-dev/macos|ios/`。macOS 需在 config 开 `macos.enabled`。
- 每次 iOS 改动收尾都要重新编译带版本号的 IPA 并部署到 `~/.wand/ios/`（用户明确说不用才可跳过），并验证 `/api/ios-ipa-update?currentVersion=0.0.0` 返回新版本。无参数 `./build.sh` 的版本形如 `X.Y.Z-debug.MMDDHHMM`，规则与 Android 相同。
- iOS 在线更新走 Apple OTA：公开 `GET /api/ios-ipa-update`、`GET /ios/manifest.plist`、`GET /ios/install`。安装链接是 `itms-services://?action=download-manifest&url=<HTTPS manifest>`，不经过第三方分发站。未签名 IPA 只能被检查到，系统安装会失败；签发后的包放到同一目录即可覆盖安装。
- 公开 HTTPS origin 由反代决定（例如 `https://home.huniu.fun:8443/`）。manifest 里的 IPA URL 必须是系统信任的 HTTPS 绝对地址。

### Mobile UX 对齐规范

移动端开发优先对齐 iOS 已验证布局，要点：

- PTY 页是原生外壳（原生顶栏 + `embed=terminal&nativeInput=1` WebView + 原生底栏），网页输入栏隐藏。
- Chat/PTY 快速提交共用 GitChangesButton / QuickCommitStore / QuickCommitSheet。
- 外观模式持久化为 `wand.appearanceMode`（light/dark/system）。
- Android 嵌入终端「乱码」多是列宽/字号问题，不是 UTF-8；注入 CSS 后触发重新 fit。

## Update Channels & Releases

- 更新通道存 SQLite `updateChannel`（stable/beta）。stable → `@co0ontty/wand@latest`；beta → `@beta`（beta 分支 CI 带 prebuilt dist）。更新判定用 `npm view` 比版本；`dist/build-info.json` 只给 UI 展示。
- 更新后自修复：`repairServiceUnitAfterUpdate()` 重写 systemd/launchd unit；重启策略见 `src/relaunch.ts`。
- APK beta 通道走 `?channel=beta`（本地 apkDir 是唯一 beta 来源）；macOS Beta 只走当前连接服务端的本地 `macos.dmgDir` ZIP/DMG（校验大小和 SHA-256），Stable 才走 GitHub Release。iOS 走 `/api/ios-ipa-update` + `/ios/manifest.plist`（本地 `ipaDir` 签发后 OTA）。

正式发布全部由 tag 驱动：push 一个 `v*` tag，GitHub Actions 并行出 npm 包 / APK / DMG / release notes。相关 workflow：`npm-release.yml`、`android-release.yml`、`macos-release.yml`、`macos-beta.yml`、`ios-build.yml`、`release-notes.yml`、`beta-branch.yml`、`cleanup-old-releases.yml`。

`release-notes.yml` 是 GitHub Release body 的唯一写入者，其他 workflow 不得碰 body。`publish.sh` 只做本地构建 + 本地分发部署，**不发布 npm**。

## 动效与交互（强制）

动效规范以本节为准。落地实现是 `src/web-ui`（前端）与 `android/.../ui/components/WandMotionKit.kt`（Android）。
改完动画、展开/收起、状态反馈、页面切换后，用下面八条自检。

八条硬要求：

1. 搜索在**原位**展开成输入框、光标自动定位，不跳页；
2. 加号**从原位**展开面板，关闭时收回加号；
3. 提交后在**同一位置**依次显示 加载 → 完成 → 结果，不用 Toast/弹窗承担结果；
4. 形态相关的图标（菜单⇄关闭、播放⇄暂停、发送⇄停止）必须连贯变形，不是硬切；
5. 标签指示条先拉向新位置再收回（前缘先走、后缘晚一拍）；
6. 按钮展开成数量选择器，归零自动恢复（本项目暂无适用界面）；
7. 列表项详情在**当前页**展开、其他内容顺势下移，不跳转；
8. 同一位置的列表/视图切换交叉淡入淡出，不整屏重入场。

三条总则：**不跳页、不位移**（触发按钮动画前后位置与尺寸不变）、**可预期**（收起是展开的倒放）。
时长与曲线只从 `WandMotion`（Android）或对应 token 取，页面不得写字面量；
`reduceMotionEnabled()` 下所有位移/缩放动画退化为瞬时。

## Style and Safety

- 2 空格缩进、双引号、分号；行宽 ~100 字符软上限。
- Node built-in 用 `node:` 前缀 + 具名导入；ESM 相对导入带 `.js` 扩展名。
- 文件 kebab-case、类型 PascalCase、函数 camelCase、常量 UPPER_SNAKE_CASE。
- 导出函数尽量显式返回类型；错误捕获 `unknown` 并用 `src/error-utils.ts` 的 `getErrorMessage()`。
- 高频事件防抖（输出 16ms、任务 100ms）；大输出用有界缓冲。
- Commit：短祈使句 subject，一次一个逻辑变更；UI 改动附截图/录屏。
- Schema 迁移只加不删；不合并两套 runner；不在 PTY bridge 伪造 tool block。
- 绝不提交真实密码、appToken、私钥或机器本地路径；`host` 默认 `127.0.0.1`，除非有意远程访问。
- 新增命令执行类配置项必须在 `AGENTS.md` 写明。

## Validation

**一键验证（推荐）**：

```bash
bash scripts/verify.sh   # 品牌资产 → 原生图标 → npm run check → npm test，与 CI 同序
```

TS / 后端 / web UI 改动常规验证：

```bash
npm run check
npm test
npm run build
```

迭代期先跑相关单测文件，交付前跑全量。用户可见的会话/UI 行为改动，使用「项目记忆」指定的本机已安装服务及连接码人工验收受影响的流程（登录、建会话、provider/model 切换、终端与结构化聊天、权限弹窗、重连/resume、上传、快捷提交、扩展/原生行为）：

以下仅用于开发期隔离冒烟，不能替代上述最终验收：

```bash
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```

会话 / DTO / 权限相关改动补针对 `session-transport`、`server-session-routes`、`password-manager` 的单测。

## Web 设计契约（DESIGN.md 的维护等价物）

本节承接已删除 DESIGN.md / UX-CONTRACT.md 的有效约束，避免重新分散文档。`premium-ui.json.canonicalMap` 指向本文。产品是默认中文的本地 AI 工作台，技术标识保留原文；日期按本地时区展示，date-only 仍用 YYYY-MM-DD。

`src/web-ui/content/styles.css` 的语义 token 是唯一运行时数值来源；Appica 桥接与 react/ui 使用同一套值，feature 只拥有业务布局，不增加第二套框架、图标库或主题源。沿用暖纸色与赤陶色动作、系统中文字体；终端使用独立深色语义。桌面侧栏296px/56px，窄屏保留全部操作与独立滚动；聊天宽度偏好保留铺满/居中。控件反馈留在原位，异步失败保留已有输入，成功以服务端结果为准。

### Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | src/web-ui/react/ui/select.tsx | 本节与组件契约 | authored plain / searchable | popup、键盘、窄屏、所属表单边界 |
| Date | task-board-host.tsx 的 date-only 字段 | 服务端 YYYY-MM-DD | native 平台日历 | 日期不做 UTC 偏移 |
| Form | feature Host + Controller / composer | 对应 API 与状态所有权 | 就地创建/保存/发送 | 保留输入、失败恢复、重复提交 |
| Scrollbar | src/web-ui/content/styles.css | 语义 token | 原生终端几何保留 | computed style |
| Toast | wandOverlay + react/ui/toast.tsx | 共享通知服务 | success/info/warning/error | live region；发送结果用原位反馈 |
| CRUD | workspaces controller / taskBoardRepository | storage 规范任务写入 | 立即工作/记录待办/归档 | 已安装服务完整流程 |
| Search | react/ui/search-field.tsx | 公共组件契约 | 本地即时/远程防抖 | clear、IME、取消、无结果 |
| Dialog | react/ui/dialog.tsx + wandOverlay | 公共组件契约 | modal / confirmation | Escape、焦点、输入保留 |

静态 premium 审计目前只按固定 DESIGN.md 文件名检查维护入口，无法识别本节等价物；对此保留审计记录，不恢复已删除的重复文档，也不关闭产品审计。

## 架构精简工作记录与续接

逐轮工作记录（修改内容、验证结果、Beta 版本与 SHA、剩余事项）**不再堆在本文**，统一写到本机忽略目录 `output/architecture-stage2/AGENTS-WORKLOG.md`（不入库）。规则：每轮结束时把「实际修改 + 验证结果 + 剩余事项」追加到该文件；本文只保留最近一条作为上下文锚点。

- 2026-10-03 Cue第二阶段：Web/Android任务与群聊的交付/接力概览完成，只取负责人说明与冻结文件；完整relay投影后再运输截尾，不读正文/知识/私聊、不改completion或任务事实。满20窗口/total与preview迟到、较新缺字段回退、task/chat/团队历史请求及草稿保护经复查/Chrome回归通过。最终check/test/build通过（1889项/0失败/10跳过），Android Debug/Release各795项/0失败/2跳过；真实服务CLI三步骤+API+Chrome三模式预览/下载通过。仅6后端+2按需/回退产物更新，另外379件安装产物不变，保留当前主脚本/样式与其他会话工作；Web优雅重启原72会话保留。Beta `4.82.0-debug.10030609`已部署并核对同源下载SHA/原签名，未安装设备、未commit/push。仅按需上限48,000B，主包/CSS不变；第三阶段只读例行任务未实现。详见 `output/cue-delivery-1003/DELIVERY.md` 与本机工作日志。
