# AGENTS.md

本文件是本仓库所有编码 agent 的**唯一操作指南**。历史设计与分析文档已移除，后续调整以本文和源码为准。

## 项目记忆

- 后续所有 Wand 功能验收、真机验收和最终端到端验收，统一使用这台机器上已安装运行的 Wand 服务，以及用户指定的连接码；连接信息读取本机私密文件 `~/.wand/acceptance-connection.json`（`serverURL` / `connectionCode`）。不要使用隔离服务、mock 服务或另建测试实例代替最终验收。连接码包含鉴权信息，不得写进仓库、提交、日志或截图。单元测试和开发期隔离检查仍可使用独立环境。

- 只要当前项目的 Android 客户端发生改动，收尾时必须重新编译带版本号的 beta APK，并部署到 `~/.wand/android/` Beta 更新目录；同时验证 `/api/android-apk-update?currentVersion=0.0.0&channel=beta` 能返回新版本。除非用户明确要求跳过，否则不得省略。
- 只要当前项目的 macOS 客户端代码发生改动，收尾时必须重新编译带新版本号的 Beta ZIP/DMG，并部署到已安装 Wand 服务的 `~/.wand/macos/` 更新目录；用本机已安装客户端的真实版本请求该服务 `/api/macos-app-update?currentVersion=<已安装版本>`，确认返回新版本且 `updateAvailable: true`，并核对下载文件可用。不要用只留在 `macos/build/` 或 `macos/dist/` 的构建代替分发验收。除非用户明确要求跳过，否则不得省略。


`wand` 是本机 AI CLI 工具的 Node.js Web 控制台，支持 Claude Code、Codex、OpenCode、Grok、Qoder、Pi 六个 provider。Express + WebSocket 服务浏览器 UI；会话跑在 PTY 或结构化非 PTY 进程里；PTY 由**独立的 terminal daemon**（`wand terminald`）持有，web 重启 / 自更新不杀 shell。配置、鉴权、会话状态持久化在激活配置文件所在目录。

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
npm install                # 依赖安装
npm run check              # bundle xterm/browser → 再生成 embedded assets → tsc（server + browser + react 三套 tsconfig）
npm run build              # 全量：vendor bundle → 编译 → 拷贝/压缩 web 内容进 dist/ → stamp build-info.json → 修权限
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
| Structured 会话（多 provider 流式） | `src/structured-session-manager.ts` + `src/structured-{claude,codex,opencode,grok,qoder,pi}-adapter.ts` |
| SQLite 持久化与只加不删迁移 | `src/storage.ts` |
| 共享契约 | `src/types.ts` |

两套 runner 共享类型和存储，**不共享执行代码**；改一边不会自动影响另一边。Claude structured 走 `claude-cli-print`（`claude -p --output-format stream-json`）——和其他 provider 一样是 spawn 本机 CLI，没有运行时权限提示；`@anthropic-ai/claude-agent-sdk` 及其 `canUseTool` 审批桥、按消息的 skills 白名单已整体移除，`runner: "claude-sdk"` 只是历史值，读旧会话时归一为 `claude-cli-print`。

## Session 输入契约（最容易写错）

PTY 输入服务端原样写入终端，客户端必须拆成**先文本、后单独 `"\r"`** 两包（快捷键回车标 `shortcutKey = "enter_text"`）；不要用 `text + "\n"` 代替回车。参考实现：Web `getTerminalSubmitChunks`、iOS `sendPtyInput`、Android `PtyTerminalScreen.sendPtyDraft`。

`SessionSnapshot.claudeSessionId` 名不副实：存的是各 provider 的原生 resume 标识（Claude UUID、Codex thread、OpenCode/Grok/Qoder ID）。恢复逻辑横跨 `process-manager.ts`、`resume-policy.ts`、`storage.ts` 和各 provider 历史目录，时间窗兜底只在候选唯一时绑定。

角色 / 规则这类「系统提示」不要拼进首条用户消息：会话级系统提示统一走 `SessionSnapshot.systemPrompt`（持久化在 `session_options`；PTY 与结构化都是）。入口两个：服务端内部调 `dispatchAgentForTask` / `createSession` / `processes.start` 时传 `systemPrompt`，客户端开会话时在 `POST /api/commands`（`initialInput` 旁）或 `POST /api/structured-sessions`（`prompt` 旁）传 `systemPrompt`。由 `structured-provider-common.ts` 映射到各 provider 自己的开关——Claude / Qoder / Pi 是 `--append-system-prompt`，Grok 是 `--rules`；Codex / OpenCode 没有这个入口，只在首条消息用 `promptWithSystemFallback` 并接一次。

一次性 AI 调用同理（commit message / tag、提示词优化、任务标题、会话标题、快捷提交兜底执行器）：用 `AiTextRequest { system, prompt }`（`src/types.ts`），规则进 `system`，执行走内置「系统运维」员工的 CLI 候选链（`callConfiguredAiText`）；CLI 走 `systemPromptFlag(provider)`，没开关的 provider（Codex / OpenCode / Gemini）用 `composeSystemFallback` 并入内容。**没有直连 API 分支**：API 线路、`systemAi` 偏好与 `commitAiSource` 已整体移除，`pref:systemAi` / `pref:commitAiSource` 的历史值留在库里但不再被读取。

会话标题的来源优先级固定为「原生 CLI 标题 → 内置系统运维员工」，两侧（`process-manager.ts` / `structured-session-manager.ts`）都只在 `maybeGenerateSessionTopic` 一处编排，逻辑收在 `session-topic.ts` + `native-session-title.ts`：

- `SessionTopicCoordinator.run` 每轮先读 `request.readNativeTitle()`：provider 自己在运行期写下的标题——codex `~/.codex/session_index.jsonl` 的 `thread_name`、qoder 转录里的 `ai-title`、OpenCode SQLite `session.title`（占位名 `New session …` 不算）、grok `summary.json` 的 `generated_title`——命中即直接落库，**不发起任何模型调用**；Claude / Pi / Gemini 没有这个入口，返回空串。读取按文件 mtime+size 缓存，任何异常都当「没有原生标题」，不能因为取标题失败让会话没名字。
- 取不到原生标题才回退系统「勤劳的初二」：走 `resolveSystemAiContext(..., getSystemSiliconEmployee())` 的候选链（`callConfiguredAiText`）。每个会话都要有标题：输入到达时先落 `provisionalSessionTopic` 的首行标题，模型成功再覆盖，模型失败/垃圾输出保留已有标题，不写空串。
- 原生标题优先于模型标题：`SessionNativeTitleTracker` 按会话记住已确认的原生标题，此后模型候选与输入首行都不再覆盖（`SessionTopic.source === "native"`），但每轮输入仍重读一次原生源，CLI 改名能跟随；这份状态只在内存，重启后重新读原生源。


## Web UI 与生成文件

先验证并清理失效实现，再调整保留组件的样式。运行时边界以上面的 Runtime Map 为准。

扫 legacy 残留（React 迁移删了渲染层、留下查询与写入）用 `npm run audit:remnants`。

前端是服务端渲染的单 HTML shell + 内联资产，浏览器侧有**两层并存**：

- Legacy vanilla-TS 层：`src/web-ui/browser/*.ts`（entry `main.ts`）— 终端、聊天渲染、WS、输入
- React 层：`src/web-ui/react/*.tsx` — Shell、新建会话、设置、工作空间、任务、文件预览/编辑器等

回滚开关：`?reactUi=0` 只关通用 React 对话框/通知层（退回原生 confirm/prompt + legacy 气泡）；**认证后的 Shell 没有回退开关**，React Shell 始终挂载。`?reactShell=0` 已随 legacy Shell 一并删除。React 通过 `*-adapter.ts` 调 legacy 的 `selectSession` / 终端池。

手编源码：

- `src/web-ui/browser/*.ts` + `src/web-ui/react/*.tsx`
- `src/web-ui/content/styles.css`
- `scripts/` 下的 entry

生成产物（禁止手改）：

- `src/web-ui/content/scripts.js`（esbuild 打包两层 browser 代码，不入库）
- `src/web-ui/embedded-assets.ts`（压缩 base64 内嵌，不入库）
- `src/web-ui/content/vendor/xterm/*`、`content/vendor/qrcode/*`（vendor bundle）
- `dist/` 全部

```text
browser/*.ts + react/*.tsx -> scripts/bundle-browser.js -> content/scripts.js
                           -> scripts/generate-web-assets.js -> embedded-assets.ts
scripts/xterm-entry.js     -> scripts/bundle-xterm.js    -> content/vendor/xterm/*
scripts/qrcode-entry.js    -> scripts/bundle-qrcode.js   -> content/vendor/qrcode/*
```

升级 `@xterm/*` 或 `qrcode` 后要重跑对应 vendor bundler。`npm run build` 必须保持把 `src/web-ui/content/` 拷进 `dist/web-ui/`，否则打包版坏。

`src/web-ui/index.ts` 只返回轻量 no-store HTML；主脚本 `/assets/app.js?v=<内容指纹>`（含当前 configPath 与团队脚本地址）、合并样式 `/assets/app.css?v=<内容指纹>` 与 vendor 都单独请求，命中指纹后可浏览器缓存；JS 因包含实例路径用 `private`。`scripts.ts` / `styles.ts` 保留嵌入回退，保证 npm 自更新短暂删除磁盘产物时旧进程仍能服务。`scripts/check-bundle-budget.js`（`npm run check:bundle-budget`，构建末尾执行）分别约束复访 HTML、首次加载完整字节、主 JS/CSS、按需脚本，不能通过换成外部资源绕过预算；调高阈值必须在同一个提交说明首载/缓存影响。构建与 CI 的 Node 版本统一取 `.nvmrc`。

Raw PTY 输出和结构化聊天 turn 是同一会话的两种表示；渲染 bug 先查 provider parser / WS payload / `chat-render.ts`，别急着怪 CSS。

## 任务与输入状态的唯一所有权

- `wand_tasks` 拥有标题、状态、工作区归属、迭代与 Agent 元数据；`workspace_tasks` 拥有 cwd、worktree、layout、revision 与 last opened。通过 `storage` 的创建/修改/会话移动入口原子更新；旧侧栏/看板 DTO 从同一事实源投影，不得在 GET 或路由中重新增加双向同步/全表修复。
- 当前会话任务归属只看 `command_sessions.workspace_task_id`，历史关联表不决定独占归属。移动后刷新 SessionRegistry，runner checkpoint 不得回写旧归属；原进程、cwd、历史与输出继续保留。
- Web `browser/composer.ts` 拥有按会话的草稿、附件、提交恢复和队列 freshness；React、DOM、input 与 WebSocket 通过它的入口修改。异步优化/上传绑定会话与 revision，删除会话清理附件 URL，迟到结果不得复活会话或覆盖新输入。
- Android 会话级 `ChatComposer` 拥有提交锁、上传与发送反馈，`SessionDraftStore` 拥有按会话的未发送内容；`ChatStore` 仍拥有聊天、PTY/structured 协议、权限与队列。页面只投影状态，dispose 时取消 composer；语音/上传回调绑定启动时会话。
- 未知送达的已提交内容只留内存；部分 PTY chunk 已接受、成功 ack 后解析失败、5xx/408/409 都属于未知。只有输入被接受前的明确拒收或本地未发送才可恢复持久化；不得取消重复提交保护，也不得改变 native PTY 的分包契约。
- Android sherpa 只编译 `app/libs/sherpa-onnx-api-1.13.2.jar`；固定来源/hash 与复现工具见 Android README。完整 AAR 不入库，常规构建/单测不下载大产物。
- Android 工具折叠由 `isCollapsibleActivityTool` 按用途判定，不能用 `activity != null` 当资格；`activity` 只是服务端 compact 投影元数据。普通调用、旧格式调用与待办操作（含 `Pi/todo`）默认进入时间线，任务进度仍读取 `ToolUseSemantic.TaskList`；提问、子 Agent 派发与图片保持独立。活动段、外层回复头与探索分组复用同一资格判断，迟到的跨 turn 图片结果也要识别。

AI 团队改名：`ai_team_runs.team_json` 是执行快照，relay `ConversationTurn.author` 与正文是历史事实，不批量重写。`AiTeamRunner.detail().displayTeam` 按稳定成员 id 从当前团队定义投影名字/头像，删除定义或成员时退回运行快照；Web/Android 仅在渲染时替换署名，不改变消息指纹/去重/派工。团队 PUT/DELETE 用独立定义变更通知刷新展示与团队轻缓存，不能把进度通知当作配置变更。

群聊名固定为「任务标题 + 任务处理群」，不是团队名。新建 relay 标题与入群提示共用 `aiTeamChatTitle()`；已有群聊的列表与详情通过 `chatTitle` 只读投影当前任务标题（优先当前会话的任务归属），任务改名即跟随，不批量改历史消息或执行快照。Web 合并详情按独立的 `chatTitleUpdatedAt` 防止旧请求回退群名；Web/Android 页头使用该展示字段，团队名只表达团队身份。

团队成员成功交付报告时，群聊投递 `ConversationTurn.reportFile` 文件卡片，不重复整份报告正文。服务端在完成时从真实文件冻结有界 `preview`（标题最多100个字符、摘录最多240个字符/3行，优先结论/摘要），不额外调用模型；Web/Android 的列表只显示该投影，完整内容点击后走公共文件预览/下载。原文件保持完整，负责人交接照常读取文件；旧消息缺预览时只显示文件身份，不补造摘要、不批量改写历史。约定报告路径优先；成员明确交付其他报告链接时，只认可工作目录内、步骤开始后新产出且唯一可确认的本地 Markdown 文件（含 symlink 越界检查），步骤的实际报告路径与负责人交接一起落库，不能把「已写入」回复当作真实文件正文。

硅基员工定义由 `silicon_employees` 持有，按顺序保存结构化 CLI 候选；会话在创建时保存员工名字、头像、候选与实际候选下标的快照，删除定义后历史聊天仍按快照显示。员工候选只在 CLI 无法启动且首条输入尚未被接受时尝试下一位；已接受输入、运行中错误和未知送达不能自动重试。任务执行主体由 `wand_tasks.execution_subject_json` 持有，`employee` / `team` / `cli` 只用于结构化任务，PTY 始终只能选 CLI；任务路由与会话路由都要验证此边界，不能只靠客户端隐藏选项。Web/Android 的联系人与聊天署名从当前定义投影，历史消息正文不改写。

### 内置「系统运维」员工（Wand 自有 AI 的唯一执行者）

- 定义在代码里：`src/system-employee.ts`（名字「勤劳的初二」、职责、人设 Prompt、Tag「系统运维」），常量与 `isSystemSiliconEmployee` 放在 `ai-team-types.ts`（浏览器端要读 Tag，不能把依赖 `node:fs` 的模块拉进前端 bundle）。
- 存储：`silicon_employees.system_key = 'wand-ops'`（只加列，用户员工保持 NULL），`loadConfigWithStorage()` 里 `ensureSystemSiliconEmployee()` 幂等补齐，首次按用户已有的 `systemAiCli`/`systemAiModel`（没有则 `defaultProvider`）落首条候选；列表读取时内置员工永远排在最前。
- **名字/职责/人设/头像由服务端固定**：`PUT /api/silicon-employees/:id` 只接受 `agents`（锁定字段提交了不同值直接 400），`archive`/`unarchive`/`DELETE` 一律拒绝；只有执行候选（CLI 工具 + 模型 + 思考深度 + 顺序降级）由用户维护。
- Wand 自有 AI 调用一律由它执行：commit message / tag、快捷提交兜底执行器、会话与任务标题、提示词优化、员工起草。人设走 `AiTextRequest.system` 前缀（`withOpsPersona`，任务自己的输出格式必须排在后面），执行走它的候选链（`resolveSystemAiContext(…, systemEmployee)` → `cliCandidates`）：跳过没安装的 CLI、已安装的先试、按顺序降级，整条链 150s 预算（每次调用受剩余预算约束）。
- 一次性文本候选必须同时通过 CLI / 协议状态与业务结果校验；退出码 0 或非空文本不等于成功。标题、员工起草、提示词优化、commit/tag 的解析与校验放在 `callConfiguredAiText` 候选循环内，格式不可用继续下一位。逐候选日志只记顺序/provider/错误码，不记提示词、路径或原始响应；执行过工具或未知送达的员工任务仍不走这条无条件重试路径。
- 候选里「跟随默认模型」必须在选举时就换成 `getDefaultModelForProvider(config, provider)`：不能把「CLI 默认」的牌子转给下一个 provider，也不能让它停在某个 CLI 自己坏掉的默认模型上。
- `systemAiCli` / `systemAiModel` 降级为兼容字段：只作为「内置员工不存在」时的兜底与首次 seed 输入，设置页不再编辑它们（设置页只读投影候选链，候选在「AI 团队 → 硅基员工」里改）。

### 默认任务伙伴与用户短期记忆

- 默认伙伴「默契的初一」独立于系统运维「勤劳的初二」，由 `default-employee.ts` 定义，`silicon_employees.system_key='wand-default'` / `id='e_wand_default'`。`loadConfigWithStorage()` 初始化时幂等补齐；名字、基础职责与基础规则固定，不可归档/删除，用户可维护直接联系它时的结构化 CLI 候选。
- CLI 是执行器、默认伙伴是角色：交互式新建 CLI 对话与任务派发未选员工时注入默认角色；明确选择员工/团队、显式自带 systemPrompt、系统内部自动化、普通 shell 和恢复会话沿用自己的规则。用户已选的 provider/model/mode/thinkingEffort 不被角色替换；隐式默认角色不启用员工的候选重发。PTY 仍只选 CLI，角色仅通过 systemPrompt 注入，不改变文本 + 单独 `"\\r"` 分包。
- `user_memory_events` / `user_memory_state` 是每个配置目录内单一用户的短期知识库；只记录有效交互提示词（含 wand-task 用户提示词）及 allowlist 内成功的任务创建/编辑/派发、团队开工、模型/深度/模式切换、上传、快捷提交、worktree 合并和提示词优化。只收新发生的行为，不回填旧记录；不读取登录/密码库/配置/文件/工具正文。敏感行、凭据模式、链接与本机路径过滤后最多600字符，记录最多1000条/30天，串行有界异步写入，不给输入加 IO 或模型等待。
- `UserMemoryService` 启动后台补检、每小时检查；至少3条证据才整理，最多每天一次，无新证据不重复调用；手动整理最短间隔1分钟。生成只走系统运维员工的 `callConfiguredAiText` CLI 候选链（150s总预算、候选内校验），最多10条沟通/工作方式/近期关注，每条160字符并引用真实记录ID，不把旧生成物反馈为证据。基础规则、权限和本轮要求始终优先；知识随证据过期或淘汰，模型失败保留现有角色。
- 记忆状态用 revision CAS；暂停或清空使排队写入与迟到生成失效，更新时保留最新员工候选，不改已有会话快照、历史消息或其他员工。清空的是短期知识库，不是会话历史；后台关闭不等待整个模型调用，迟到结果不再读写已关闭DB。
- `/api/user-memory`（GET/PATCH/DELETE）与 `/refresh`（POST）受登录及 sessions scope 保护，不返回原始提示词记录。Web默认员工原位展开后才获取记忆，可查看、暂停/恢复、整理、清空；按钮原实例/尺寸/位置保持，结果与失败留在原位。过滤并不保证识别任意秘密，用户不应在提示词中提交凭据；整理后的有界记录会交给所配置的 CLI 模型，不新增直连API。
- 默认伙伴记忆面板仅进 `ai-teams.js` 按需 chunk，主包注册表共享仓储通知。实测新增后 lazy 41,649B gzip（原40,201B），门限41,000→42,000B；首载仅增加15B、仍为732.2KiB，首次/复访与内容指纹缓存契约保持，未外置资源规避预算。

### 每员工独立知识库（明确记忆）

- 每位硅基员工（含默认伙伴和系统运维）以稳定员工ID拥有独立 `employee_knowledge` 命名空间；空库可直接使用，改名/归档/换CLI/换会话不改变归属。明确的知识没有30天过期，最多200条×4000字符，满库报错，不偷偷淘汰；员工删除时仅其知识与工具访问随FK删除，历史聊天保留。`user_memory_*` 仍是默认伙伴短期习惯，不代替其他员工的知识库。
- 员工结构化对话在实际启动本轮runner时读取自己的知识，按关键词/近期记录提供最多12条、8000字符的有界上下文；`runtimeSystemPrompt` 只在runner边界使用，不进session_options/DTO，不改基础角色或历史。Claude/Qoder/Pi/Grok走各自系统提示开关；Codex/OpenCode/Gemini每轮含resume时追加实时知识，基础systemPrompt仍只在首轮兜底一次。
- 直接以「记一下/记住/存到你的知识库」开头的明确要求，由Wand本地原子保存并把真实成功/失败回执交给员工；只处理真正开始执行的员工输入，排队/重复请求不提前写。条件句/示例/日志任务/「记得跑测试」不当知识；其他自然表达由员工按明确授权调用知识工具。文本是资料，不是执行指令，保存失败不能说记住了。普通员工私有对话和明确记忆不进入默认伙伴的自动习惯学习；明确前缀也不进入共享迭代/commit摘要，操作统计只记功能，不抄这些任务正文。
- 新增员工工具命令：`knowledge:remember <text> | --stdin`、`knowledge:search [query]`、`knowledge:forget <entry-id>`。由 `startEmployeeKnowledgeRunner` 注入 `WAND_KNOWLEDGE_DB` / `WAND_KNOWLEDGE_TOKEN` 到子进程环境；token不进argv/提示词/DTO/日志，DB只存hash，按本次session.employeeId绑定、最长6h，完成/启动失败即撤销。不接受employee/config选择参数，不默认转存初一；继承来的凭据先剥离。清空某员工知识同时撤销其旧工具凭据，写入在事务内复验，迟到stdin不能复活已清空内容。无命令权限的CLI不得绕过权限；标准明确前缀仍由服务端处理。
- 所有读写走storage按employeeId过滤的原子入口；知识不拼入普通用户消息或写到cwd里的README/AGENTS。允许知识里的正常文档URL/路径，实际凭据拒存而不是假装存入；这不是敌对本地进程的文件系统沙箱，CLI原有文件权限不被提升或降低。
- 管理API `/api/silicon-employees/:id/knowledge`（GET/POST/DELETE）及条目DELETE受登录+sessions scope保护，URL归属不受请求体employeeId覆盖。Web每张员工卡原位展开自己的知识库，按需读取、搜索、刷新、二次确认清空，内容窗口固定240px、确认反馈占原有行，清空不使触发按钮移位；grid展开在reduce-motion下关闭transition；不预取所有员工的知识，不用知识更新通知重置未保存的角色表单。清空不影响其他员工、短期习惯或聊天历史，Escape/取消/再点卡头/筛选与页面卸载收起并使迟到请求失效。
- 知识搜索在SQL里先限于当前员工最多200条，再由JS做Unicode大小写字面匹配、匹配后应用结果limit，避免SQLite ASCII-only lower漏掉Équipe/西里尔字母；Web与CLI共用。
- 新知识面板只进ai-teams按需chunk；lazy 41649→42586B gzip（+937B），门限42000→43000B；主包/首载保持约732.2KiB和既有内容指纹缓存，不外置资源或关闭预算。

## State、Config 与目录

- Config 默认值与合并：`src/config.ts`。`loadConfigWithStorage()` 会把合并结果写回磁盘——改 config schema 必须同步它。
- SQLite 在配置文件旁边解析。迁移**只加列/加表，从不 DROP**。
- 状态分四桶：部署项（config.json）/ 偏好（SQLite pref:*）/ 密钥（SQLite，绝不回写 JSON）/ 大件（文件或 daemon 内存）。
- 上传写在 `<session.cwd>/.wand-uploads/`；worktree 在仓库根 `.wand-worktrees/`；分发文件默认 `<configDir>/android|macos|ios/`。

持久化看起来不一致时，同时查 `src/storage.ts` 和 `src/session-logger.ts`，它们互补而非冗余。

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

2026-09-28，用户指定本轮完成 Web/Android，其他端仅保留既有工作。详细本机日志在忽略目录 `output/architecture-stage2/WORKLOG.md` 与同目录验证输出；下次先读本节，保留全部未提交及外部提交，不 reset/clean。

- 第一轮：生产 lock 193→154项（少39项，当前本机文件少53.47 MiB）；npm发布与start只检出render-bin；生成vendor退出源码；内嵌备用资产gzip减少约2.90 MB；受限缓存清理回收2.77 GiB。签名、用户数据、Git历史与SourcePackages保留。
- 任务：storage统一规范投影与原子写入，移除wand-task-sync约205行协调链（剩自动命名）。GET无修复写入、单卡定点SQL。迁移入口 `WandStorage.constructor → migrateTaskRecords()`，SQLite标记 `pref:taskRecordsVersion=1`；按ID补齐、历史NULL迭代保留，无容器归档不复活，恢复在写事务内建新容器。
- Web：ComposerStore统一草稿/附件/提交；队列按会话revision/epoch处理过期HTTP与rollback。删除会话释放URL，迟到失败不得复活会话；提示词优化有revision CAS。移除AppState四个重复容器与全局queueEpoch。
- Android：固定会话ChatComposer + SessionDraftStore + ChatStore协议边界；ack前保留内容，失败保留新编辑，unknown不进入Saver，正常4xx拒收可持久化。picker/voice固定会话，dispose取消；PTY部分送达视为unknown。
- 语音：38,208,264 B AAR→547,634 B API jar，依赖本体少37,660,630 B（98.57%）；保留许可证/NOTICE、三层SHA与可复现工具。常规构建不下载AAR；小fixture测真实提取逻辑，可选官方AAR验证22 MB arm64库。Git历史不重写。
- 同族修复：团队开工项目使用公共WandSelect；三处textarea禁resize；lazy host注册公共选择器。最终截图发现Portal搜索被父级误判外点，提交 `f845f15` 为每行自己的popup标记边界；搜索/选项保留表单，外点/Escape关闭、输入保留，真实点击通过。保持既有交互与动效token。
- 送达保护：Web 与 Android 都将已接受部分 PTY chunk、成功 ack 后解析失败、5xx/408/409 视为 unknown；只有任何输入被接受前的明确拒收可恢复持久草稿。Web 最后修复提交 `82fdb05`，新增真实发送入口的7项行为测试，保留文本与单独 `"\r"` 两包。
- 已验证：`npm run check`、`npm test`、beta `npm run build` 全部成功；最终1553项，1543通过/10跳过/0失败。Android576项通过、0跳过（含可选官方AAR与PTY部分送达）；服务端定点184项、SQLite合同10项、Web定点128项也通过。
- 已安装服务：最终Web beta `4.77.0-debug.9282148` 已部署；生产依赖导入、真实PTY启动、全局服务重启后的健康检查与产物字节一致性通过。真实验收通过建任务、PTY提交、双DTO改名/状态/迭代投影、独占移动且cwd/输出/运行状态保留、草稿切换与刷新、结构化回复、附件上传及新编辑保护；桌面/390px窄屏无横向溢出，公共选择器搜索/键盘关闭通过。本轮两张QA任务已软归档，历史保留。
- Android分发：本轮构建 `4.77.0-debug.09282105`（9,697,830 B）；并发客户端更新后再次核对全局最新包 `4.77.0-debug.09282135`（9,717,074 B），SHA-256 `65394ed61e87ef09114c69b21347a18e121605c3ae4111166b80a8d5729bdd15`。metadata、版本标记、Beta更新端点均一致，APK不含sherpa JNI库。子仓库源码已push，主仓库指针可拉取；默认未安装/启动设备。
- 全局 Codex/Pi AGENTS 已更新规范所有权、unknown送达、轻量语音依赖、按需submodule和本文续接入口。Web设计契约合并在本文；strict审计仅剩固定DESIGN.md文件名提示，具体控件所有权问题已修复。
- 2026-09-29 Android 首页会话与任务列表改为下拉刷新；任务/会话长按进入多选，并修复任务内会话长按误选父任务。源码 `c30c6e7` 已推送 Android master，Beta `4.77.0-debug.09290500` 已部署并通过 metadata、版本标记和更新端点核对；默认未安装设备。详见 `output/architecture-stage2/WORKLOG.md`。
- 2026-09-29 AI Team 群聊在 Web/Android 增加真实步骤驱动的成员工位（当前任务、工作/待处理/完成状态、进入成员会话）；未知送达的群聊输入保留未确认行，明确拒收恢复草稿。Android 跟随同一 relay 群聊的新一轮 run，并停止后台详情轮询。Android 源码 `37db585` 已推送，主仓库实现至 `024695f`；最新 Beta APK `4.77.0-debug.09290537` 和已安装 Web Beta `4.77.0-debug.9290538` 已部署。完整验证与浏览器验收限制见 `output/architecture-stage2/WORKLOG.md`；原有未提交 `premium-audit.json` 保留。
- 2026-09-29 用户反馈 Android Team 首页仍是旧入口：已确认连接的模拟器安装版为 `1.0.0`，此前新工位只在运行群聊中。Android 现从 AI 团队列表展示最近群聊入口、每队最新协作；团队详情顶部展示最近协作与真实成员工位，点击进入群聊/成员会话。源码 `862d8ec` 已推送，Beta `4.77.0-debug.09290559` 已部署，Gradle、metadata、版本标记与已安装服务更新端点一致。并行的聊天卡片未提交修改保留；本轮默认未安装设备，详见 `output/architecture-stage2/WORKLOG.md`。
- 2026-09-29 工具调用折叠卡（显示/动效 + 自动折叠）按 `output/android-tool-card-design.md` v2 落地：折叠头 44dp、窗口 240dp、chip 净空派生式（`CHIP_CLEARANCE` 8dp → inset 42dp）、四列骨架与统一状态词表、去空展开、两层折叠改 `AnimatedVisibility` 正反放、`WandStatusIconSlot` 同实例变形；自动折叠改为 override 三态与派生默认值分离、fold key 只含会话与结构 scope（修掉新卡/新段到达后历史卡不自动折叠，以及思考块流式追加时 fold key 漂移清掉用户收放）。Android 源码 `99043c9` 已推送 master，Beta `4.77.0-debug.09290645`（9,790,846 B，SHA-256 `a4e668fec23301f86b45fbc4d730c918c1cfa59e84f0d48dc15f520f9adb855e`）已部署，端点四字段与 DEX 符号 `WandStatusIconSlot=14/cardFoldId=1/cardMessageScope=2/ACTIVITY_TAIL_CHIP_CLEARANCE=1/itemFoldScope=3` 均核对；`./gradlew test` 1204 项 / 0 失败 / 2 跳过。遗留：chip 像素净空 7.6–7.8dp、窗口内无 id 条目用组内下标（重排会重置该组 override）、`TodoProgressBar` 与回复级折叠待单独收敛；详见 `output/architecture-stage2/WORKLOG.md`。
- 2026-09-29 AI Team 群聊参考钉钉/飞书的消息优先层级收简：Web/Android 默认只显示群名与状态、一行任务公告、消息与输入；成员工位、任务清单、完整记录从同一详情入口原位展开，实时输出先缩成一行，发言行去掉反复出现的 CLI/模型签名。Web/Android 源码提交 `3d9d141` / `3235d2e`，Android Beta `4.77.0-debug.09290722`、已安装 Web Beta `4.77.0-debug.t09290726` 已部署；全量 Web 测试、Android 单测、APK 更新接口、已安装服务脚本字节均通过。CUA 无浏览器/模拟器窗口，设备视觉点击未验收，详见 `output/architecture-stage2/WORKLOG.md`。
- 2026-09-29 Android 连接页与开屏：参考 Web 登录插画的“信号汇入工作区→同步到手机”节奏，实现仅冷启动播放的短 Compose 动画；选服页改为已存服务器优先、新服务器独立表单、行内连接失败反馈，自动连接与深链/管理入口保留原有协议。Android 源码 `dc5a39b` + 死焦点清理 `bb31b41` 已推送，主仓库指针 `8dd28eb`；Beta `4.77.0-debug.09291046`（9,812,618 B，SHA-256 `826e92d1c5e0e22939f5bb21fb3abdec34cb158cefff8595e1b772910fa74d1c`）已部署并与 metadata、APK 内版本和更新端点一致。隔离工作树 Android 602 项 / 0 失败 / 1 跳过；本机未安装新包，设备动效视觉尚未验收。根 `npm run check` 通过，`npm test` 的唯一失败来自并行未提交 Web 群聊文件的 DOM 查询，详见工作日志。
- 2026-09-29 Android 选服页后续重设计：选服首屏直接显示已存服务器，完整开屏插画只在冷启动播放；“添加服务器”从列表末尾原位展开。服务器别名可在首次添加时填写、在列表行内编辑，留空恢复地址显示；别名仅作本机标签，URL/凭据/稳定 ID 不变，首页、聊天、终端与设置页统一显示别名。管理页仅改别名时首页原位刷新名称，保留导航与草稿；扫码/深链与已存服务器的输入草稿隔离。Android 源码 `c7a6c88`、`c74f16b` 已推送 master，Beta `4.77.0-debug.09291134`（9,832,758 B，SHA-256 `67e1b2455aeef12bdcbcedf5abaf11e7f07f80c643aa6e1c7d59be5316f64e89`）已部署，Gradle、metadata、APK 内版本与更新端点一致；隔离工作树 Android Debug/Release 各 607 项、各 1 跳过/0 失败。默认未安装/启动设备，设备视觉验收未执行，详见工作日志。
- 2026-09-29 Android 首页列表顶栏：服务器名称胶囊改为按内容占宽、最大 160dp，长名称单行截断，右侧操作靠右；移除首页搜索入口及其会话/任务共用查询、筛选状态和空态代码，保留“只看等你”与独立任务看板搜索。Android 源码 `2f56b7c` 已推送 master，Beta `4.77.0-debug.09291154`（9,817,650 B，SHA-256 `da57af43e746c8daf37d00ef2112e376a5b7ecfc54a1b27e410a0d351c822036`）由干净检出构建并部署；Debug/Release 各 607 项、各 1 跳过/0 失败，metadata、APK 内版本与已安装服务更新端点一致。并行未提交 Android 群聊/Web 改动保留；默认未安装设备，视觉点击未验收，详见工作日志。
- 2026-09-29 Web 团队对话页续接现有 v2 改动：同一 relay 新 run 保留草稿、未确认消息、消息身份与上滚位置；独立页的旧加载和旧发送回包不能覆盖新一轮。同 run 的详情/聊天快照只单调合入；成功 ACK 优先以服务端消息指纹确认，未知送达不靠时间猜；新一轮加载中暂禁提交，草稿仍可编辑。`npm run check`、`npm test`（1593 项、1583 通过/10 跳过/0 失败）、`npm run build` 及合成 Chrome 18 项通过。已安装 Web Beta `4.77.0-debug.t09291240` 的群聊资产和相关服务端产物与最终本机构建逐字节一致，真实服务路由/API 只读检查通过；CUA 无可用浏览器窗口，安装版页面未做真实点击视觉验收。Android 与审计文件原有未提交改动保留，详见工作日志。

- 2026-09-29 Android Team 对话收简：历史接手 notice 与新开工模板在渲染时转为成员第一人称「我开始处理「任务」这项工作。」；主群聊停止 /live 工具/终端文本轮询，进度归公告下的真实步骤摘要，授权/回答/异常保留当前成员会话入口；修复发布版 200 条窗口满后新尾消息不贴尾。Android `2150ade` + 纯删除 `2e64b64`（398 行）已推送，未提交 v2/Markdown/Web 工作保留。干净源码 Debug/Release 各 603 项、各 1 跳过/0 失败；Beta `4.77.0-debug.09291230`（9,806,278 B，SHA-256 `f061edc0c5522df97a215b9a7ba225939ff6f855edaf2c236014aec9aeca14e1`）已部署，metadata/APK 内版本/版本标记/已安装服务更新端点一致。真实服务脱敏样例解析通过；默认未安装设备，视觉未验收。并行工作树测试限制及完整记录见 `output/android-team-feed/REPORT.md` 和工作日志。
- 2026-09-29 AI Team 改名展示：保留 run.team 执行快照与历史 turn，detail.displayTeam 只按 id 投影当前名字/头像；会话列表群名 JOIN 当前定义，Web 独立定义变更通知/缓存防旧请求反灌，Web/Android 展示投影不改消息指纹。已安装服务 26 个改名历史 run、187 条旧作者只读核对；npm 全量1601项0失败、Android Debug/Release 全量通过，隔离 Chrome 真实 React 改名 DOM 通过。Android Beta `4.77.0-debug.09291423` 更新端点一致；安装版浏览器登录限流429未真实点击，默认未安装 Android。详细记录见工作日志；保留所有并行未提交工作。
- 2026-09-30 IM 与硅基员工：员工定义保存有序结构化 CLI 候选，任务执行主体可选员工/团队/CLI，PTY 仅 CLI；Web/Android 以联系人与最近对话作为入口，已有会话优先回访。最终 `npm run check`、`npm test` 1635 项/0 失败、`npm run build`，Android Debug/Release 各 636 项/0 失败；安装版 Chrome 桌面与 390px 点击及真实员工 Codex 回复通过。Web Beta `4.79.0-debug.t09301118`、Android Beta `4.79.0-debug.09301101` 已部署并通过更新端点核对；未安装 Android 设备。主仓与 Android 原有未提交工作保留，未代提交/推送或更新子模块指针。详细记录见 `output/architecture-stage2/WORKLOG.md`（本轮配套的 `output/im-transition/` 截图与日志目录已在 2026-10-01 整理忽略目录时删除）。
- 2026-09-30 Web 新建硅基员工改为「默认一个期望输入框」：手动字段（名字/头像/职责/Prompt/候选）收进可原位展开的「高级配置」，期望填完点「创建员工」由 `POST /api/silicon-employees/draft` 按系统 AI 通道（直连 API 优先、否则默认 CLI）起草名字/职责/角色设定与一个按已安装 CLI 选出的首选候选，再走原有落库入口；高级配置里手动填了名字则直接按手动值创建，「按期望生成」只填充字段不落库。`src/silicon-employee-draft.ts` 负责提示词、JSON 解析与 provider 兜底，`src/server-employee-routes.ts` 注入可测试的 `generateDraft`。展开/收起用 `0fr→1fr` 从触发按钮原位长出来，触发按钮尺寸不变（箭头同实例旋转），`is-wand-app` 下瞬时。验证：`npm run check`、`npm test` 1640 项 / 1630 通过 / 10 跳过 / 0 失败、`npm run build`（含 bundle 预算）与 `tests/helpers/run-employee-create-browser-harness.mjs`（真实 Chrome：默认态、自动创建、原位展开、AI 填充、手动创建不调模型、收起、reduce-motion）全部通过。未做已安装服务人工验收（本轮改动与并行未提交工作同在工作树），Android 原生创建页仍是手动表单、未跟随改造。
- 2026-09-30 系统层默认员工「勤劳的初二」：新增内置「系统运维」员工（`silicon_employees.system_key='wand-ops'`，只加列），名字/职责/人设/头像由服务端固定，不可归档、不可删除，只有执行候选（CLI 工具 + 模型 + 思考深度 + 顺序）可改；`loadConfigWithStorage()` 幂等补齐并按用户已有的 `systemAiCli`/`systemAiModel`（否则 `defaultProvider`）落首条候选，员工列表内置员工置顶。Wand 自有 AI（commit message/tag、快捷提交兜底、会话与任务标题、提示词优化、员工起草）改为统一由它执行：`withOpsPersona` 把角色设定作为系统提示前缀，`resolveSystemAiContext(..., systemEmployee)` 输出候选链，`callConfiguredAiText` 跳过未安装的 CLI、按顺序降级（150s 总预算），「跟随默认模型」在选举时固化为 `getDefaultModelForProvider`。设置页「系统 AI」改为只读投影执行者与候选链（`SystemAiOwnerSummary`），不再编辑 `systemAiCli`/`systemAiModel`（保留为员工缺失时的兼容兜底）。验证：`npm run check`、`npm test` 1650 项 / 1640 通过 / 10 跳过 / 0 失败、`npm run build`；`tests/system-employee.test.ts`（seed/锁定/候选链/人设顺序/真实假 CLI 降级）与真实 Chrome `tests/helpers/run-system-employee-browser-harness.mjs`（设置页投影、内置员工置顶与 Tag、锁定字段不可编辑、无归档/删除、保存只提交候选、普通员工不受影响）通过；隔离实例（`/tmp/wand-dev-sysops`，`node dist/cli.js web` 与 `tsx src/cli.ts`）真实 HTTP 核对 seed、改名/归档/删除 400、候选 PUT 200，并用真实 codex 候选跑通 `/api/optimize-prompt`。未做已安装服务人工验收（本轮改动与并行未提交工作同在工作树，详见 `output/architecture-stage2/WORKLOG.md`）；Android 原生员工页仍是完整编辑表单，未跟随锁定与 Tag（服务端会拒绝其改名/删除请求）。
- 2026-09-30 移除直连 API：`src/system-ai.ts`（411 行）与 `tests/system-ai.test.ts`（706 行）整体删除，`SystemAiConfig` / `SystemAiProtocol` / `CommitAiSource` / `Config.systemAi` / `Config.commitAiSource` 与 `pref:systemAi` / `pref:commitAiSource` 两个偏好键一并移除；设置页去掉「生成方式 CLI/直连 API」「直连 API 模型路由」（导入/测试线路、密钥、顺序、回退）与「Commit 生成」来源选择，`/api/settings/system-ai/import`、`/api/settings/system-ai/test`、配置 PATCH 的 systemAi 分支、`config:show` 的密钥脱敏分支全部删除，`resolveCommitAiContext` 与 `AiTextRequest` 归并到 `session-ai-context` / `types`。Wand 自有 AI 现在只有一条路：系统运维员工的 CLI 候选链（`callConfiguredAiText` → `callCliCandidates`）。顺手修掉同族 bug：`runQuickCommit` 原来逐字段抄一份 `QuickCommitAiOptions`，会静默丢掉后来新增的 `opsPersona` / `cliCandidates`（提交消息没有走人设与降级链），现在直接复用 `opts`。老库里的 `pref:systemAi`（含 API Key）与 `pref:commitAiSource` 值**保留但不读取**，不再出现在 `/api/settings`、`config:show` 或任何客户端投影里。验证：`npm run check`（server/browser/react 三套 tsc）、`npm test` 1627 项 / 1617 通过 / 10 跳过 / 0 失败、`npm run build` + bundle 预算（首载 730.2 KiB / 781.3 KiB）；真实 Chrome 隔离验收 `output/architecture-stage2/verify-system-employee-web.mjs`：设置页只剩「新会话默认 + 系统 AI 执行者投影」，`settings-system-ai-cli`、生成方式单选、Commit 来源单选、`.wand-settings-route-list` 全为 0，弹层内不再出现「直连 API / API 线路 / API Key」文案，控制台零错误，桌面与 390px 截图 `output/architecture-stage2/system-ai-{settings,owner}-{desktop,390}.png`。
- 2026-09-30 移除 Claude Agent SDK 与 skills 白名单：`@anthropic-ai/claude-agent-sdk` 依赖、`src/claude-sdk-runner.ts`（227 行）、`structured-session-manager` 的 SDK 流式路径与 `canUseTool` 审批桥（约 700 行，含 `pendingSdkQueries`/`pendingSdkAbort`/`pendingPermissions`/`turnApprovalMemory`）、`thinkingEffortToSdkBudget`、`buildClaudeSdkThinking`、设置页「结构化运行器 CLI/SDK」与 `WandConfig.structuredRunner` 一并删除；一次性 Claude 文本调用改成 spawn `claude -p --output-format text --tools "" --no-session-persistence --strict-mcp-config`（语言指令与任务规则走 `--append-system-prompt`，非零退出真的报错，空输出报 EMPTY_AI_MESSAGE）。skills 是 SDK-only（`supportsClaudeSkillSelection` 要求 `runner === "claude-sdk"`），随之整体移除：`src/claude-skills.ts`、`/api/claude-skills`、`react/composer-skills/*`、`browser/composer-skills-adapter.ts`、composer-config 的 skills 按钮、浏览器 skills 管线与 `SessionSnapshot.queuedMessageSkills`（`queued_message_skills` 列按只加不删保留，插入 NULL）。兼容：`runner: "claude-sdk"` 保留为历史值，`normalizeStructuredRunner()` 读路径归一为 `claude-cli-print`，旧会话照常可开可续。验证：`npm run check`、`npm test` 1617 项 / 1607 通过 / 10 跳过 / 0 失败、`npm run build` + bundle 预算（首载 724.8 KiB，比移除前少 5.4 KiB）、`tests/git-quick-commit-ai.test.ts` 新增真实假 CLI 用例覆盖 `claude -p` 参数/顺序/失败、两个浏览器 harness 与隔离实例验收重跑通过。施工期间发现同工作树另有一个会话在做同一件事（未被本会话编辑过的 skills 测试被删、SDK 测试被改写成 CLI runner seam），方向一致、合并后全绿；本会话未提交、未 reset/clean、未覆盖对方在编辑的文件。
- 2026-09-30 收尾（残留清理 + 本机 Beta 部署 + 已安装服务验收）：删掉 skills 移除后残留的 `.composer-skills-*`（`content/styles.css` 107 行）与直连 API 线路编辑器残留的 `.wand-settings-route-*`/`.wand-settings-clear-key`（`react/styles/features.ts`，只保留被系统 AI 候选链复用的 `.wand-settings-route-rank`）。部署本机 Beta `4.80.0-debug.t09301639`（tarball 5,662,189 B，SHA-256 `4208ef2ede724f4e45ef51ae32debccef1f1d00db6b455f24ba90bb5b8c89cd3`）并重启服务（PID 80604 → 75041，关键产物与本地构建逐字节一致）。已安装服务只读验收：版本与内置员工在线（候选链 `qoder → pi → pi`）、三个被删端点全 404、`app.js`/`app.css` 无任何旧控件标记且有新的系统 AI 投影、真实 Chrome 打开安装版设置页控制台 0 错误；受限 appToken 会话看不到 admin 的「AI 与模型」面板，该面板以资产逐字节一致 + 隔离实例真实点击截图作为等价证据（详见 `output/architecture-stage2/WORKLOG.md`）。原生客户端兼容核对：Android/iOS/macOS 新会话都发 `claude-cli-print`，无人读 `queuedMessageSkills` 或发 `skills`，不需要跟改。本轮未提交（工作树含并行会话改动）。
- 2026-09-30 群聊按任务命名：Web/Android 列表与页头统一为「任务标题 + 任务处理群」，新建 relay 与入群提示同名，已有群聊只读投影并跟随任务改名；不改团队定义、运行快照或历史消息。命名快照隔离验证 `npm run check`、全量 `npm test`（1634 项/1623 通过/11 跳过/0 失败）、`npm run build` 通过；Android Debug/Release 各 637 项/各 1 跳过/0 失败。Android `552eefb` 已 push，Beta `4.80.0-debug.09301915`（9,980,946 B）已部署，metadata/版本标记/更新端点/下载 SHA-256 一致；默认未安装设备。已安装 Web Beta `4.80.0-debug.t09301915` 的两个已有群聊列表与详情同名，真实 Chrome 桌面/390px/`reactUi=0`/原生壳页头正确且无横向溢出或运行异常。保留负责人开工与另一路实时刷新未提交工作；共享工作树全量测试含该并行未完成套件，未冒充全绿，详情见 `output/architecture-stage2/WORKLOG.md`、`output/group-chat-title/`。
- 2026-09-30 工具活动卡片：Web/Android 普通工具调用改为浅色摘要 → 分类菜单 → 单条详情，运行态使用轻呼吸动画；同一文件的多次调用计为一个文件。Web/Android 显式请求 compact 投影，服务端 HTTP/WS 只传分类与匿名文件键，详情点击后取 `/api/sessions/:id/tool-content/:toolUseId`；旧客户端维持原投影。完整验证、安装版传输与 Beta 包记录见 `output/architecture-stage2/WORKLOG.md` 的「工具活动摘要与按需详情」。
- 2026-09-30 工具活动后续修正：Web/Android 将相邻深度思考与普通工具合到同一行内摘要，当前未返回命令显示状态点和等待时长，命令数旁显示服务端首次观察该调用的本地时间；完成项与旧历史静止，旧记录缺时间时不编造。跨消息结果、流式空思考与展开状态均补了回归，未打开的工具详情继续按需加载。Web Beta `4.80.1-debug.t09302326`、Android Beta `4.80.1-debug.09302326` 已部署；全量 Web/Android 测试、已安装服务精简 HTTP/WS 与新命令时间、APK 更新端点均通过。浏览器与 Android 设备视觉点击未验收，详见工作日志。
- 2026-10-01 工具时间线：Web/Android 纯工具/思考消息移除外层 Wand 回复折叠头，直接显示小字摘要；展开为固定 240px/dp 的可滚动时间线，每次调用独立一行，文件名/工具名与真实时间由 bounded compact label 投影，input/result 仍为空，点单条才取详情，同文件多次调用不批量拉取。正文与问答/任务/子 Agent/图片的独立卡保持不变。Web 向上展开以保留底部消息流的触发点位置，两端关闭倒放、减少动效与原实例交互均保留。主仓 `5fed2f8`、纯删除旧分类样式 12 行 `ea27139`；Android `bebb1e6` 已 push。Web Beta `4.81.0-debug.t10010637`、Android Beta `4.81.0-debug.10010626` 已部署；check/build、Android Debug/Release 各 639 项/0 失败/1 跳过、新时间线真实 Chrome 六模式与已安装服务五模式真实点击/单条请求通过，APK metadata/更新端点/下载 SHA 一致，默认未安装 Android 设备。全量 Web 1714 项/1703 通过/10 跳过/1 失败：外部活跃的 focus helper 尚未等待新展开动效，B01 坐标点击未命中，未覆盖其文件或冒称全绿；并行 package/lock/helper 工作保留。详见 `output/architecture-stage2/WORKLOG.md` 与 `output/tool-timeline/`。
- 2026-10-01 时间线行首时间：Web/Android 每条工具调用改为「时间 → 文件/工具摘要 → 状态」，缺少真实时间仍不补造；Android 时间使用等宽字体。主仓 `c496616`、Android `dccd890` 已 push；Web Beta `4.81.0-debug.t10010653` 与 Android Beta `4.81.0-debug.10010650` 已部署。check/build、Android Debug/Release、源码 Chrome 六模式与已安装服务五模式的时间位于摘要左侧/固定高度/按需详情验证通过；APK 更新端点和下载 SHA 一致，默认未安装设备。共享全量仍为1714项/1703通过/10跳过/1个原有 B01 失败，外部 helper 未覆盖。证据见 `output/tool-timeline/time-leading/`。
- 2026-10-01 Android 工具漏折叠：用 native session id 精确核对当前已安装服务的 structured Pi 会话，最初180次调用中19次 `Pi/todo` 无 `activity`，误走旧卡片；另3次 Read 是应保留的图片。修复折叠/外层头/探索分组三处共同资格，不再把 compact 标记当折叠条件；待办与旧调用统一进入时间线，任务进度、问答、派发、图片保持有效，原始 `occurredAt` 与有限文件/工具标签支持旧格式。新增10项回归（7项先红），含安装版218次调用的脱敏样例：215折叠/3图片独立、21次无标记待办全折叠。Android `736cc60` 已 push；Debug/Release 各649项/0失败/1跳过。Beta `4.81.0-debug.10010720`（9,995,126 B，SHA-256 `7bcea95a9da4c4e5d088bdcce8380834203fe0a01384894c240078fee5c3f2fa`）已部署，Gradle metadata、APK内版本、版本标记、更新端点与下载SHA一致；安装版待办详情200，输入/结果和4个任务语义快照完整。默认未安装/启动设备，无ADB设备，原生视觉未验收；Web源码未改，原有并行 package/lock/focus helper 与共享B01阻塞保留。证据见 `output/tool-folding/`。
- 2026-10-01 系统员工候选链降级：修复一次性调用漏判「退出 0 但协议失败」及结果校验在链外导致首候选阻断备用的问题；会话/任务标题、员工起草、优化、commit/tag 校验均移入候选循环，补脱敏逐候选日志与剩余150s预算。17项新回归（初版12红/1绿、预算另先红）与定点115项通过，固定副本check/build通过；全量1731项/1718通过/12环境跳过/1个原有B01失败，移除本轮补丁仍复现，不冒称全绿或覆盖活跃helper。已安装Beta `4.81.0-debug.t10010826` 仅替换本轮5个JS模块及声明，原UI资产和其它dist逐字节保留；真实优化入口、真实CLI首候选本地拒绝→备用成功、真实JSON主题生成通过，员工配置未改，Render/terminald PID不变。旧系统内部调用缺逐候选日志，无法唯一还原用户所说那次失败；当前保存两条Pi候选，首条实测正常。未提交/推送、未改原生客户端；并行群聊/PTY/Android修改保留。详见 `output/system-employee-fallback/` 与工作日志。
- 2026-10-01 Android 平板双栏中缝：宽屏分栏原来在侧栏右缘画一条 1dp 实线（`WideSidebarPanel` 的 `bgElevated` 底块 + `drawLine`），从状态栏一路切到手势条；展开时它被子页面自己的背景盖住、只剩内容硬边，收起时露出浅色底块与实线，两栏看起来像两个页面拼起来。现在删掉该面板（背景与实线一并删除），改在画布左缘画 `paneSeam` 柔光：14dp 横向渐隐、上下收进 `WindowInsets.systemBars`，亮色用 `borderStrong`@0.18、暗色用 `border`@0.52（暗色下投影不可见）；侧栏展开态内容加 12dp 水平内边距，卡片不再贴着中缝被切；`PadLandingScreen` 落地页改用 `WandDetailTopBar`，标题与「新建任务」不再画进状态栏，两个栏目的顶栏基线对齐。验证：Debug/Release 各 655 项/0 失败/2 跳过；1600×2560@320（800×1280dp）模拟器实测展开/收起/横屏 914×495dp/深色/手机单栏五种形态，落地页与其它详情页顶栏一致、中缝不再压系统栏、窄屏不受影响。Android Beta `4.81.0-debug.10010844`（10,006,570 B，SHA-256 `90a7ff17f60c1725e75e3a963e821c5f241ad185c4332774f53006417698474c`）已部署到 `~/.wand/android/`，已安装服务更新端点返回同版本/同 SHA。未提交/推送、未改子模块指针；并行 Android 工具时间线与主仓改动保留。证据见 `output/android-tablet-pane/`。
- 2026-10-01 收起态工具摘要的行首时间：展开行上一轮已有行首时间，收起态摘要仍把时间放在「运行了 N 条命令」里面；本轮 Android 把它拆成行首时间段（等宽 10sp、textMuted，与展开行时间同一套样式），Web 把 `<time>` 挪到 `.chat-activity-meta` 第一个子元素并把颜色统一为 muted；「运行中 / 已等待」仍跟在命令计数后，旧历史无真实时间不插占位。新增 Android 纯函数 `toolActivitySummaryParts()` 与两项回归（各 655 项/0 失败/2 跳过），Web 渲染单测与真实 Chrome 六模式 harness 增加收起态断言。主仓 `260e1d6`、Android `8f575f6` 已 push；已安装 Beta `4.81.0-debug.t10010856` 与本机 dist 逐字节一致，安装版真实 Chrome 五模式核对收起态时间在摘要项之前。并行未提交的宽屏/落地页/群聊改动未动；Android Beta 由并行分发的 `4.81.0-debug.10010854` 已含本轮 DEX 符号，未另跑构建覆盖。详见 `output/architecture-stage2/WORKLOG.md` 与 `output/tool-summary-head-time/`。
- 2026-10-01 团队报告预览卡：Web/Android以真实报告标题、最多三行结论/摘录、文本缩略页和文件元信息投递，不铺全文、不额外调模型；点击才预览/下载。兼容成员明确交付的cwd内新报告（Markdown链接/代码路径），拒绝远程/陈旧/越界/歧义引用，实际报告路径与负责人交接一并落库。主仓`1d1e3e3`/`3ae3dfd`/`5c85f48`，Android`53090bc`已push；Web Beta`4.81.0-debug.t10011003`、Android Beta`4.81.0-debug.10010919`已部署，APK更新端点与下载SHA一致，本会话未安装设备。check/build、定点111项、Android各656项/0失败/2跳过、源码Chrome六模式与安装版真实Pi报告/五模式点击通过。全量1756项/1745通过/10跳过/1个原有B01失败，未覆盖活跃helper或冒称全绿。Lazy脚本仅+241B gzip，门限40→41KB，首载732.2KiB不变；相关说明在feature提交。详细记录与截图见`output/architecture-stage2/WORKLOG.md`、`output/team-report-preview/`；所有并行工作保留。
- 2026-10-01 默认伙伴与短期记忆：初始化新增「默契的初一」，CLI/未选员工的任务与交互会话默认注入其设定，不换用户的工具/模型/权限，不改员工/团队/自带规则、PTY分包或历史快照。30天/1000条有界脱敏知识库，至少3条证据、每日按系统运维CLI归纳沟通/工作方式/近期关注，暂停/清空和迟到生成有revision CAS；Web默认员工卡可查看/暂停/整理/清空。check/build、定点172项与权限/核心13项（有重叠）通过；共享全量1768项/1756通过/11跳过/1既有B01失败，未覆盖其活跃helper或称全绿。Beta `4.81.0-debug.t10011207`窄范围部署，315个其他dist/CSS/vendor保留，daemon PID不变；真实Pi任务/PTY、真实系统运维记忆归纳、旧快照不变与安装Chrome五模式通过。临时QA样本被模型正确判为0条偏好，已清空自身测试记忆，真实习惯从后续使用积累。原生未改、未commit/push，13份外部diff及Android工作保留。详情与截图见`output/default-employee-memory/`和工作日志。
- 2026-10-01 每员工独立知识库：普通/默认/系统运维硅基员工以稳定ID各自记知识，明确「记一下」原子保存，不随30天习惯过期；其他自然表达可调用真实scoped CLI知识工具，能力只入env且完成即撤销。每轮/resume仅提供自己的有界实时资料，不改基础Prompt/历史；明确记忆不进默认习惯/共享commit摘要。Web每员工按需搜索/刷新/双确认清空，240px固定窗与原位反馈；同族grid reduced-motion transition遗漏已补。check/build、133项及补充91/13项（有重叠）通过；最终全量1778/1767通过/10跳过/1既有B01失败，未动活跃helper。真实安装Pi甲/乙记周五/周一、新会话独立回忆、改名保留/清库隔离/工具撤销和Chrome五模式通过，QA定义与知识已清理。最终Beta `4.81.0-debug.t10011429`窄范围部署，主JS/CSS/vendor与外部模块保留、daemon PID不变。未改原生/未commit/push，23份外部diff及Android工作保留。详情见`output/employee-knowledge/`和工作日志。
- 2026-10-01 知识库续收尾：修Unicode大小写搜索，先红后绿，storage/真实scoped CLI/API员工隔离复验通过；定点24、check/build通过，全量1779/1768通过/10跳过/仅既有B01失败。窄部署检测到并行新版本后停止，安装Beta `4.81.0-debug.t10011606`已包含本轮storage且与固定产物逐字节一致，真实Unicode/字面匹配/隔离及QA清理验证通过；未认领他方部署或覆盖。第22独立复审B01候选仍未过，新增merge反例TR02，等待其负责人/设计师边界；未动活跃文件。41份其它diff/Android保留，无原生/commit/push。证据见`output/employee-knowledge/continuation/`。
- 2026-10-01 员工头像 CLI 角标：Web/Android 在头像右下角复用本地品牌 logo；员工配置/新建入口显示首选候选，联系人最近会话、聊天顶栏/资料/回复显示实际 provider，降级或员工配置改动不误标已有会话。上传头像与原尺寸/点击位置保持，未知 CLI 不冒充其它工具；Web 联系人状态点移至右上角避免遮挡。check/build、定点92项及源码Chrome通过，Android Debug/Release各659项/0失败/2跳过；最终Web全量1784项/1773通过/10跳过/仅既有B01失败，无本轮角标的HEAD副本也复现，未降低门禁或接管focus实现。Android `2593b96`已push，Beta `4.82.0-debug.10011700`（10,011,874 B）已部署，metadata/APK版本/更新端点/下载SHA一致，默认未安装设备。安装Web Beta `4.82.0-debug.t10011710`窄部署仅6个UI/内嵌回退/版本文件，350个其它dist保留、daemon PID不变；中途遇到并行4.82.0正式部署先停止，再确认其UI与本轮未改HEAD一致后叠加。真实Pi回复、首选Codex与实际Pi差异、7种logo及桌面/390px/原生壳/reactUi=0/reduce五模式真实点击通过，QA员工已清理、历史保留。截图与记录见`output/employee-cli-badge/`和工作日志。
