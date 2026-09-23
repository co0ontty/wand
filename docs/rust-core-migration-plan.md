# Wand Rust 内核重构计划

状态：**草案，待评审**。本文只定义路线、门禁与验证方式，尚未开始实施。
目标读者：维护者。现状描述以 `master`（`6c641f4`）为准，所有量化数字来自本轮 grep / wc 实测。

---

## 0. 结论摘要

1. **必须先纠正一个前提**：Rust 不会去掉 WebView。去掉 WebView 靠的是**各端原生终端视图**；Rust 的作用是把「会话所有权 + 协议真源 + 客户端 SDK」下沉，从而消灭`每个平台手写一遍的 DTO 与传输适配层`——也就是「各种适配」的真正来源。客户端 UI/渲染/IME/快捷键必须保留原生实现，**「客户端也全部用 Rust」不可达**。
2. 用户所说的「丑陋的转发层和适配层」实际是**四个可独立推进的面**：PTY 与进程所有权、provider CLI 流解析、HTTP/WS 业务层、原生客户端（去 WebView）。它们的收益与风险严重不对称，**不能作为一个大爆炸迁移**。
3. **原生终端不是研究项目**：本仓 macOS 已经用 243 + 270 + 271 行 Swift（SwiftTerm）替掉了整个嵌入网页终端，`WKWebView` 只剩一条注释。iOS/Android 是**复制已验证模式**，不是从零探索（见 §5）。
4. **PTY + CLI 转发层（P0–P2）值得无条件做**：Rust 收益最大、风险最可控，直接干掉 `node-pty` 打包 hack、JSON 字符串承载的 PTY 帧、以及 1072 行屏幕抓取权限识别。
5. **整个服务端 Rust 化（P3–P5）是另一个数量级的工作**（server 侧 40,957 行 TS + 21 张表 + 212 个端点），且有真实生态缺口（`@anthropic-ai/claude-agent-sdk` 只有 Node 版）。计划把它设为**带客观门禁的决策点**，而不是默认路径。
6. 关键工程手段是**契约优先 + 双实现差分 + 单一 IDL codegen**：先把 REST/WS/DTO 契约冻结成单一真源，让 Rust 实现必须与 Node 实现产生**逐字段相同**的输出，再让四端消费生成代码。没有这层门禁，两套实现必然漂移。
7. **可并行的两条主轨**：内核轨（P0–P5）与原生客户端轨（N0–N3，见 §5）**互不依赖**，应并行推进；用户感知的「原生体验」主要来自 N0/N1，而不是 P3–P5。

---

## 1. 现状取证

### 1.1 规模

| 区域 | 实测行数 | 说明 |
| --- | --- | --- |
| `src/**/*.ts(x)`（不含生成产物） | 101,990 | 总量 |
| `src/*.ts`（服务端顶层） | 40,957 | 需要 Rust 化的核心体量 |
| `src/web-ui/react` | 36,081 | 前端，与本次无关 |
| `src/web-ui/browser` | 21,224 | 前端，与本次无关 |
| provider 适配／解析层 | 8,582 | `structured-*.ts` + `claude-pty-bridge.ts` + `pty-text-utils.ts` + `pty-terminal-state.ts` |
| `tests/*.test.ts` | 35,223 | 迁移期的等价性资产 |
| HTTP 端点 | 212 | 跨 15 个 `server-*-routes.ts`，`server-session-routes.ts` 占 62 |
| SQLite 表 | 21 | `src/storage.ts` |

### 1.2 三个「转发层」的具体形态

**A. PTY 与进程所有权**

- `node-pty` 只出现在两处：`src/terminal-host.ts`、`src/terminal-daemon-server.ts`。
- `src/ensure-node-pty-helper.ts`（196 行）存在的唯一原因是 node-pty 的 `spawn-helper` 常丢失可执行位：能 `chmod` 就 `chmod`，不能就把 helper 复制到可写缓存并**改 node-pty 内部的 `fork.helperPath`**。这是纯打包脆弱性，Rust 原生 `forkpty` 直接不存在这个问题。
- PTY 字节走 **newline-delimited JSON over Unix socket / named pipe**（`terminal-daemon-protocol.ts`，`JSON.stringify` 每帧），每帧被转义成 JSON 字符串再解码。带宽、GC、事件循环抖动都是白付的成本。
- 重连屏幕需要一台**服务端 JS 终端模拟器**：`src/pty-terminal-state.ts` 用 `@xterm/headless` + `SerializeAddon` 维护屏幕镜像，序列化一次 ~20ms、几百 KB，因此代码里有一整套 `CHECKPOINT_QUIET_MS` / `CHECKPOINT_PENDING_MAX_CHARS` 的节流启发式。
- 结构化 run 的恢复靠 daemon 内存里的 **8MB** stdout/stderr replay log（`STRUCTURED_RUN_LOG_MAX_CHARS`），Web 重启后重新喂 reducer。

**B. provider CLI 解析**

- 六个 provider、两套完全独立的 runner（PTY / structured 共用类型与存储，**不共用执行代码**）。
- 最脏的一处是 `src/claude-pty-bridge.ts`（1072 行）+ `src/pty-text-utils.ts`（325 行）：**抓取 Claude Code 的 TUI 屏幕文本**来投影聊天、识别权限弹窗，`hasExplicitConfirmSyntax` / `hasPermissionActionContext` / `scorePermissionLikelihood` / `FALLBACK_SCORE_THRESHOLD` 是一套打分启发式，还配了 `FALLBACK_VERIFY_WINDOW_MS`、`IDLE_PROBE_DELAY_MS` 等容忍窗口。它本质上和 Claude Code 的 TUI 版本强耦合。
- 结构化侧则相对干净：`structured-{codex,pi,opencode,grok,qoder}-adapter.ts` 是「拼 argv + 解析 JSONL 流」。这部分搬到 Rust 是**机械工作**，不是难点。

**C. HTTP/WS 业务层**

- 212 个端点、21 张表、鉴权（cookie / appToken bearer / scope）、SSR 单 HTML 内联资产、TLS 自签、单实例 pidfile+IPC attach、`session:*` CLI、TUI（neo-blessed）、更新与分发通道、Android/iOS/macOS 分发端点。
- 客户端（Web / Android / iOS / macOS / 扩展 / JSON CLI）全部只依赖 **REST + `/ws`**，WS 帧类型为 `init` / `output` / `ping` / `resync_required` / `pty_error`。这是 `src/web-ui/browser/websocket.ts` 实测到的全集。
- 生态缺口：`@anthropic-ai/claude-agent-sdk` 只能跑在 Node，被 structured Claude runner（可选）和 `git-quick-commit`、`prompt-optimizer`、`task-title`、`system-ai` 等一次性调用共用（见 `src/claude-sdk-runner.ts`）。

### 1.3 现有可复用的迁移资产

- **假 CLI 脚本模式已经存在**：`tests/grok-structured.test.ts` 等把一条 shell 脚本写进临时目录、塞进 `PATH`，脚本按序打印录制好的 JSON 行，然后断言 manager 产出的 DTO。这套模式可以**原样变成 Rust/Node 双向差分夹具**。
- 但 `tests/fixtures/` 目前只有 1 个文件（`terminal-daemon-entry.ts`）。**没有真实 provider transcript 的录制夹具**，这是 P0 必须先补的。
- 仓库已有 `distribution-manager.ts`（sha256 校验）、GitHub connector、`install.sh`，二进制分发可复用其模型。

### 1.4 环境

- 本机：`rustc 1.98.1` / `cargo 1.98.1`，已装 target 仅 `aarch64-apple-darwin`（跨平台矩阵需要补 `x86_64-apple-darwin`、`x86_64/aarch64-unknown-linux-{gnu,musl}`、`x86_64-pc-windows-msvc`）。
- 分发载体目前是 npm 包，`files` 只含 `dist` + `browser-extension`，无 `postinstall`。

---

## 2. 目标、非目标、成功判据

### 2.1 目标

1. **PTY 原生化**：Rust 拥有 PTY 生命周期（`forkpty` / ConPTY、进程组与会话、`TIOCSWINSZ`、`SIGWINCH`、termios、信号转发），不再经过 `node-pty` 与其 helper hack。
2. **去掉一层序列化**：PTY 帧与结构化事件不再以 JSON 字符串承载，改为带版本的二进制/长度前缀帧（对客户端用 capability 协商暴露）。
3. **CLI 转发器合并为一个 Rust 运行时**：六 provider 的 argv 构造 + 流解析 + reducer 在同一个进程内，共享类型与错误模型，去掉 Node→daemon→CLI 三级转发。
4. **消灭屏幕抓取**：Claude 的聊天/权限语义改走机器可读的双向 `stream-json` 控制协议，删掉 `claude-pty-bridge.ts` 与 `pty-text-utils.ts`。
5. **（门禁后）服务端 Rust 化**：Rust 核心直接对四端提供现有 REST + WS 契约，Node 从「转发器」退化为不存在。
6. **原生终端体验**：iOS/Android 用原生终端视图替换 PTY 页的 WebView 嵌套，与 macOS 对齐（细节见 §5）。
7. **消灭客户端适配层**：同一份契约只维护一次，四端消费生成的 DTO 与帧编解码，不再各自手写 ~1,400–2,600 行模型与传输代码。

### 2.2 明确非目标

- **不破坏现有 wire 契约**：四端与扩展不改协议即可继续工作。新编码走 capability 协商，旧客户端走老格式。
- **不动 SQLite 语义**：schema「只加不删」的约定继续有效；不换数据库引擎；不要求客户端迁移数据。
- **不合并 PTY 与 structured 的语义边界**：`SessionRegistry.ownerOf` 的 `structured` / `pty` / `storage` 分派继续保留。
- **不在本次重写 Web 前端**（`web-ui/browser` + `react` 共 57k 行保持 TS）。
- **不追求「客户端也用 Rust」**：三端 UI/渲染/IME/快捷键保持 Swift/Kotlin 原生；共享 Rust VT 内核（UniFFI）是可选后续项，不进首期关键路径（见 §5.6）。
- **不拆除「网页版兜底」**：iOS `showWebFallback`、Android `MainActivity` 是有意的逃生舱，保留并降级为必要可见，不算技术债。
- **不做运行中 daemon 热接管**：Node daemon 与 Rust core 各自独立 socket 命名空间，互不领养（见 §4.3）。

### 2.3 成功判据（可测量）

| 判据 | 现状基线 | 目标 |
| --- | --- | --- |
| PTY 帧传输 | 每帧 `JSON.stringify` 字符串 | 长度前缀二进制帧，实测吞吐 ≥ 5× |
| 冷启动到可服务 | 需加载 Node + 内联资产 | ≤ 100ms |
| 常驻内存（空载 + 4 个 PTY） | 待测基线（Node ~120MB 量级） | ≤ 30MB |
| 屏幕镜像序列化 | ~20ms / 几百 KB / 需节流启发式 | 增量快照，无节流常量 |
| Claude 权限识别 | 屏幕打分 + 容忍窗口 | 协议事件，零启发式 |
| 契约差分 | 不存在 | REST 端点 ≥ 90% 覆盖，provider 流 100% 覆盖 |
| 分发 | `ensure-node-pty-helper` 之类修复 | 无 per-install 二进制修复步骤 |

---

## 3. 目标架构

### 3.1 crate 分层

```text
wand-rs/                     (cargo workspace)
├─ wand-protocol     REST DTO / WS 帧 / 核心事件 / 错误语义；serde + 版本号；由 IDL 生成
├─ wand-term         PTY 原语：spawn(forkpty|ConPTY)、resize、信号、ring buffer + seq、
│                    VT 屏幕模型 + 增量快照序列化
├─ wand-runtime      provider runner trait + 六 provider 模块（argv 构造 + 流 reducer）
│                    进程监督、背压、checkpoint/replay
├─ wand-store        SQLite(rusqlite bundled) + 迁移(只加不删) + sessions 制品 + config.json
├─ wand-domain       tasks / workspaces / missions / iteration / git / worktree / github /
│                    password-vault / distribution
├─ wand-http         axum 路由 + 鉴权(cookie/appToken/scope) + WS 广播与流控 + TLS(rcgen) +
│                    内联 Web 资产(rust-embed) + 单实例 pidfile/IPC attach
├─ wand-cli          `wand web|serve|termd|session:*|service:*`
└─ wand-tui          ratatui attach/状态面板（P5）
```

### 3.2 进程模型（ADR-1）

推荐 **两个角色、一个二进制**：

- `wand core`（长生命周期）：持有 PTY、structured run、SQLite 连接、IDL 事件源。
- `wand serve`（可重启边缘）：HTTP/WS、鉴权、静态资产、内联 HTML。自更新时**只重启边缘**，PTY 与流不中断。

与现状的差别：现在 PTY 存活依赖 `terminald`，而 `terminald` 也是 Node；Rust 化后核心本身常驻，边缘重启不再需要「领养 + seq 补洞」这套跨进程协议来保命（协议保留，但变成同 binary 内部 IPC，可用二进制帧）。

备选方案（记录在案，不采用）：单进程 —— 每次自更新杀 PTY，破坏现有「web 重启不杀 shell」承诺。

### 3.3 客户端直连的形态

「直连」不等于换传输协议 —— 换传输要改 4 个客户端 + 扩展。**收益来自去掉中间的 Node 镜像与适配**，因此：

1. REST/WS 契约保持兼容（`WAND_PROTOCOL_VERSION` 递增 + capability 协商）。
2. 新增可选的二进制 PTY 通道（长度前缀帧 + `ack` 流控），客户端在 `subscribe` 时声明 capability，老客户端继续拿 JSON 帧。**原生终端（Swift/Kotlin）优先吃二进制帧；Web 的 xterm.js 继续用字符串帧**。
3. 保留 `resync_required` 语义；屏幕快照改由 Rust 增量序列化产出，客户端侧不改渲染（仍是「写进原生终端视图 / xterm」）。
4. 契约只维护一次：IDL → 生成 Swift / Kotlin / TS（见 §5.4）。
5. 本地客户端（macOS/Android 同机部署场景）可选走 Unix socket + `SCM_RIGHTS` 传递 PTY master fd，实现真正的零拷贝终端；这是后续可选项，不进关键路径。

### 3.4 客户端分层（原生壳 + 生成契约）

```
Rust core （唯一真源：forkpty / VT 屏幕模型 / runner / store / HTTP+WS）
   │
   │ IDL ── codegen ──┬─ TS    → Web（xterm.js，契约不变）
   │                  ├─ Swift → iOS + macOS（SwiftTerm）
   │                  └─ Kotlin→ Android（Kotlin 终端视图）
   └─ 二进制 PTY 帧 + ack 流控（原生终端）
```

原生壳保留：UI、渲染、IME/中文候选、快捷键、无障碍、剪贴板策略。详见 §5。

---

## 4. 关键设计决策

| ID | 决策 | 结论 | 状态 |
| --- | --- | --- | --- |
| ADR-1 | 进程模型 | 核心常驻 + 边缘可重启，一个二进制两个角色 | 建议采纳 |
| ADR-2 | wire 契约 | 不改协议形态，用 capability 协商加二进制帧 | 建议采纳 |
| ADR-3 | VT 屏幕模型 | 用 Rust VT crate（`wezterm-term` / `vt100`）替换 `@xterm/headless` + serialize；产出必须是「写进客户端 xterm 后屏幕等价」，用截图/pyte 级断言校验 | 需 spike 择一 |
| ADR-4 | daemon 命名空间 | Rust core 用独立 socket/pidfile/token 后缀，**禁止**与 Node terminald 互相领养；未完成迁移时两套并存但不混用 | 建议采纳 |
| ADR-5 | `claude-sdk` | Rust 无等价物。选项：(a) Claude structured 只保留 `claude-cli-print` / 双向 stream-json；(b) 保留一个小 Node sidecar 专供 SDK 与一次性 AI 调用。**推荐 (a)**，把一次性调用（commit message / 标题 / 优化提示词）统一改走 CLI，理由是同一个传输、少一个运行时 | 需你拍板 |
| ADR-6 | 迁移顺序 | 先 PTY（P1）→ 再 provider（P2）→ 最后 HTTP/业务（P3+），每期独立可回滚 | 建议采纳 |
| ADR-7 | 一致性门禁 | 契约 IDL 单一真源 + 双实现差分跑，未过门禁不进下一期 | 必须 |
| ADR-8 | 去 WebView 的路径 | 客户端层面解决，不指望 Rust：iOS 用 SwiftTerm（与 macOS 同库）、Android 用 Kotlin 终端视图（候选 Termux `terminal-view`）；服务端保持 VT 权威 + 下发版本化 ANSI 快照，客户端被动渲染 | 建议采纳 |
| ADR-9 | 客户端是否内嵌 Rust | 首期不嵌。UI/渲染/IME 必须原生；共享 Rust 会话/VT 内核（UniFFI）列为 N3 可选，等 N0/N1 与服务端 VT 内核稳定后再评估 | 建议采纳 |
| ADR-10 | 适配层的收敛手段 | 单一 IDL + codegen 生成 Swift/Kotlin/TS，而非让四端继续手写 DTO；UniFFI 只用于 N3 的共享逻辑 | 建议采纳 |

---

## 5. 原生客户端轨道：去 WebView 与消灭适配层

这一节回答「不要丑陋的 WebView 嵌套和各种适配」，也是用户感知最直接的一块。

### 5.1 现状：macOS 已经跑通，iOS/Android 没跟上

实测证据：

| 端 | 当前终端实现 | 证据 |
| --- | --- | --- |
| iOS | WKWebView 嵌网页终端 | `SessionDestinationView.swift:89` → `WebContainerView(embedTerminal: true, embedNativeInput: true)`；`WebContainerView.swift` 824 行 + `WebBridge.swift`；`Package.swift` 无 SwiftTerm |
| Android | Compose + WebView | `PtyTerminalScreen.kt` 1249 行，`WebView(context)` 在 `:1032`；`MainActivity.java` 仍是 WebView 壳（popup 列表、CookieManager 全局清理） |
| macOS | **原生 SwiftTerm** | `NativeTerminalView.swift` 243 + `PtyTerminalStore.swift` 270 + `WandSocket.swift` 271；`WKWebView` 仅出现在一条注释（描述旧壳） |

macOS 的做法、约束与验收清单已写在 `macos/docs/native-terminal.md`（订阅 `capabilities.ptyAck`、快照重放顺序、resize 去抖 80ms、输入按 UTF-8 标量 ≤16KiB 分帧、中文预编辑隔离、OSC 52 默认禁止、回滚 5000 行、单帧 16MiB），并有 `macos/WandTests/NativeTerminalTests.swift` 与 `native-terminal-2026-09-23/verification.md`。

**结论：去 WebView 是把 macOS 已验证的模式复制到另外两端，不是研究项目。**

### 5.2 「各种适配」的真正成本在客户端

同一份契约被手写多遍（实测行数）：

| 端 | 手写 DTO / 传输 | 体量 |
| --- | --- | --- |
| iOS | `WandModels.swift` 1627 + `WandAPI.swift` 988 | ~2,600 |
| macOS | `WandModels.swift` 1092 + `WandSocket.swift` 271 | ~1,400 |
| Android | `data/WandApi.kt` + 各屏模型 + `WandWebSession.kt` | 同数量级 |
| Web | `types.ts` 800 + `session-transport.ts` + `structured-client-protocol.ts` | ~1,500 |

这才是「丑陋的适配层」的主要组成部分（比服务端是 Node 还是 Rust 更相关），而且**只有在协议 IDL + codegen 之后才会消失**。

### 5.3 保留项（不算技术债）

iOS `showWebFallback`（`NativeRootView.swift:119`）与 Android `MainActivity` 的「网页版兜底」是有意的逃生舱（旧版服务端、加载失败、网页侧设置/回退入口）。建议保留并降级为「仅在必要时可见」，本轮不拆。

### 5.4 分轨任务

| 轨道 | 内容 | 依赖 | 人周 |
| --- | --- | --- | --- |
| N0 | iOS 原生终端：SwiftTerm 视图 + 原生 WS（照 macOS 模式），去掉 `embedTerminal` 路径 | 无（可立即做） | 2–3 |
| N1 | Android 原生终端：Kotlin 终端视图替换 `PtyTerminalScreen` 的 WebView | 无 | 3–5 |
| N2 | IDL + codegen：消灭四端手写 DTO/帧编解码 | P0 契约冻结 | 1–2 |
| N3（可选） | UniFFI 共享 Rust 会话/VT 内核给三端 | P1 + N2 | 4–8 |

N0/N1 与内核轨 P0–P2 **完全并行**，不互为前置。

### 5.5 关键技术判断

1. **iOS 用 SwiftTerm 是首选**：同一库已在本仓 macOS 落地，行为、边界情况与验收清单可直接复用；自研 iOS VT 渲染不划算。
2. **Android 没有 SwiftTerm 等价物**：Termux 的 `terminal-emulator` + `terminal-view`（Kotlin）是最成熟方案（终端语义、鼠标、IME 都有实践），代价是引入第三方依赖与其许可、以及 Compose 互操作包装；自研 VT（含 CJK 宽度、备用屏幕、重绘优化）不建议。
3. **不让客户端承担 VT 解析正确性**：保持 macOS 现有路径 —— 服务端 VT 权威 + 下发版本化 ANSI 快照，客户端被动写入。语义风险留在服务端，客户端只需要一个正确的 VT 解析器渲染，**不需要理解会话历史**。
4. **UniFFI 共享内核值得做但不该首期做**：收益是「一套终端语义」，成本是客户端要么自绘（巨大）要么仍本端 VT（重复）。等服务端 VT 内核稳定后再评估。
5. **Rust 对原生的真实贡献是字节流与契约**：原生终端要的是未被 `JSON.stringify` 转义的字节，以及单一真源生成的 DTO/帧编解码器；它不是「去 WebView」的手段。

### 5.6 验收基线（三端共享）

把 macOS 的清单升级为跨端契约，每端必须过：

- **快照重放顺序**：先写 `data`，再严格按序重放 `pending` 的 data/resize，最后 fit 当前尺寸；不得用会 soft-reset 的视图 resize 丢失粘贴/备用屏幕模式。
- **增量与流控**：消费 `output.data.chunk` 后 ACK `ptyBytes`；`seq` 缺口 / `resync_required` / 重连一律重建快照，等待期丢弃并 ACK 旧增量，避免背压锁死。
- **输入契约**：普通 Return 是独立 `"\r"` 且标 `enter_text`；粘贴不自动附回车；中文组词期间候选键不发远端；断线期间不发输入、不缓存待重连执行、写入失败不重试用户字节。
- **边界与安全**：回滚上限、单帧上限、待发送队列上限、resize 去抖数值对齐（可各自调优但要记录）；OSC 52 读/写剪贴板默认禁止；链接只允许 http/https/mailto。
- **真机**：中文/ANSI、TUI 重绘、备用屏幕、选区与滚动、`stty` 尺寸、resync、重连。
- **验收方式**：按项目记忆，最终验收用本机已安装的 Wand 服务 + `~/.wand/acceptance-connection.json` 连接码（凭据不入库/入日志/入截图）。

---

## 6. 契约优先的工程方法（P0 的全部内容）

这是整个计划里**唯一不能省**的部分。

1. **契约文档 `docs/rust-core-contract.md`**：REST 端点（方法/路径/参数/响应/错误码）、WS 帧全集、`SessionSnapshot` / `ConversationTurn` / `ContentBlock` / DTO、daemon framing、鉴权与 scope 语义、输入拆包契约（文本包 + 独立 `"\r"`）、错误消息语义。以现有 TypeScript 类型与 212 个端点为准逐条固化。
2. **单一 IDL**：从 IDL 生成 Rust `serde` 类型与 TS 类型，禁止两侧手写同名结构。
3. **录制夹具**：扩展现有「PATH 上假 CLI」模式为**录制器**——对每个 provider 录下真实 argv、stdout/stderr 字节流（或 PTY 字节流）、退出码、CLI 版本号，存进 `fixtures/<provider>/<场景>.jsonl` + `meta.json`。覆盖：正常回复、工具调用、工具结果含图、`AskUserQuestion`、权限弹窗（Claude）、resume、CLI 报错、空结果、超长输出截断、UTF-8 跨块切分。
4. **差分跑 `tools/conformance/`**：同一夹具分别驱动 Node 实现与 Rust 实现 → 归一化 DTO → 逐字段 diff（明确忽略的时间戳/随机 id 白名单）。CI 里作为**门禁**：任一侧漂移即失败。
5. **回放器**：把真实 HTTP 请求/WS 会话录成可回放脚本，供 P3 使用。

退出标准：Claude / Codex / Pi 三条主流的夹具能稳定回放，Node 侧基线全绿，差分工具可运行。

---

## 7. 分期路线图

每期格式：范围 → 交付物 → 退出标准 → 验证 → 回滚。

### P0 契约冻结与差分夹具（1–2 人周）

- **范围**：§6 全部；不写任何 Rust 业务代码。
- **交付物**：`docs/rust-core-contract.md`、IDL、录制器、`fixtures/`、`tools/conformance/`、CI 门禁。
- **退出标准**：三条主流 provider 夹具可回放；Node 基线差分全绿；契约文档经你确认。
- **验证**：`npm test` 全绿 + 差分工具自检（故意改一个字段必须报差异）。
- **回滚**：纯增量，无运行时影响。

### P1 Rust PTY 内核（2–3 人周）

- **范围**：`wand-protocol` + `wand-term`；实现 terminald 协议 v2 的等价物（含 `seq` 补洞、`reattach`、衰减逻辑），先用 JSONL 保兼容，二进制帧留到 P3；VT 屏幕模型 spike（ADR-3）。
- **交付物**：`wand-rs/` workspace、`wand termd`、Node `TerminalHost` 增加 `rust` 后端、config `core.ptyEngine = "node" | "rust"`。
- **退出标准**：`npm test` 中 terminal-daemon / process-manager / pty-terminal-state 相关用例在 Rust 后端下全绿；真机验收通过（见 §10）；性能判据达标。
- **验证**：差分（PTY 字节流逐字节比对 + 快照等价性）；真机多 provider TUI；`wand web` 重启后 shell 存活；resize/乱码/中文宽字符；attached/detached。
- **回滚**：`core.ptyEngine = "node"` 即回到现状；两套 socket 隔离，不产生半迁移状态。

### P2 Structured runner 迁到 Rust（3–5 人周）

- **范围**：`wand-runtime` 的 `ProviderRunner` trait + 六 provider 模块；先做 Claude 双向 `stream-json` 控制协议 spike（替代屏幕抓取），再按 provider 逐个切换。
- **交付物**：Rust runner、per-provider 开关、`claude-pty-bridge` 降级为 fallback（默认走协议路径）。
- **退出标准**：六 provider 夹具差分 100% 全绿；权限弹窗、`AskUserQuestion`/escalation、resume、thinking effort、model 选择行为与现状一致；屏幕抓取路径仅作为开关保留。
- **验证**：diff 门禁 + 真机逐 provider 验收（含权限批准/拒绝、提问作答、resume、超长输出、工具图片）。
- **回滚**：per-provider 开关回退到 Node runner。
- **依赖**：ADR-5 必须在此期前拍板。

### P3 HTTP/WS 边缘 Rust 化 —— **决策门禁**

- **门禁（必须先满足，再动工）**：
  1. P1+P2 交付后，真机验收连续 2 周无回归；
  2. 差分门禁覆盖 ≥ 90% REST 端点；
  3. 明确接受 40,957 行服务端业务代码的重写成本（约 6–10 人周）。
- **范围**：axum 路由与鉴权、WS 广播与流控（含 `PTY_UNACKED_HIGH_WATER` 等价策略）、内联 HTML/资产、TLS 自签、单实例 attach、`session:*` CLI、二进制 PTY 帧 + capability 协商。
- **交付物**：`wand-http`、`wand-cli`、双栈并行开关 `WAND_ENGINE=node|rust`。
- **退出标准**：录制回放差分全绿；四端 + 扩展真机验收通过；`/api/android-apk-update`、`/api/ios-ipa-update`、`/ios/manifest.plist` 等分发通道行为不变。
- **验证**：HTTP 回放差分 + WS 帧差分 + 真机矩阵 + `?reactUi=0` 等回退开关仍有效。
- **回滚**：`WAND_ENGINE=node`。

### P4 存储与业务域（5–8 人周）

- **范围**：21 张表（rusqlite bundled）、`config.json` 字节级兼容、`sessions/` 制品格式不变、password vault（AES-256-GCM / HMAC-SHA1 TOTP / `timingSafeEqual` 等价常量时间比较）、任务/工作空间/mission/迭代/git/worktree/github/distribution。
- **退出标准**：同一份真实 `~/.wand/wand.db` 副本被两侧交叉读写后数据一致；加密条目互解；迁移只加不删。
- **验证**：真实 DB 副本交叉测试；`session-logger` 制品对比；`npm test` 中存储相关用例移植为 Rust 测试并保持语义。

### P5 分发、TUI、退役（2–3 人周）

- **范围**：二进制分发（优先 npm `optionalDependencies` 按平台三元组发布，与 `npm-release.yml`/`publish.sh` 对齐；备选 GitHub Releases + `checksums.txt` + sha256 校验）、`install.sh`、systemd/launchd unit 重写、self-update 与 `repairServiceUnitAfterUpdate` 等价物、`wand-tui`（ratatui）。
- **退出标准**：干净机器安装 → 升级 → 回滚演练通过；stable/beta 双通道正常；重启后 PTY 存活。
- **退役**：删除 TS 实现（一个提交只做删除，附 `npm run check` + `npm test` + 真机核对结果）。

---

## 8. 分发与运维

**已落地（本轮实现）**：Render 拆成两个仓库，均以 submodule 引入主仓库：

| submodule | 仓库 | 内容 |
| --- | --- | --- |
| `render/` | `co0ontty/wand-render` | Rust 源码 + 协议 + 四平台打包脚本 + Release workflow |
| `render-bin/` | `co0ontty/wand-render-bin` | 各平台二进制 + `manifest.json`（sha256/size/protocolVersion） |

契约、发版编舞与回滚细节见 [`render-upgrade-path.md`](render-upgrade-path.md)；协议在 `render/docs/render-protocol.md`。

- 平台矩阵：`darwin-arm64` / `darwin-x64`（各自独立 triple，不做 Universal 合并）、
  `linux-x64` / `linux-arm64`（**静态 musl**，避免旧发行版 glibc 符号缺失），
  `win32-x64` 预留但第一阶段不实现（需要命名管道 + ConPTY + 信号语义重写）。
  每个平台在**原生 runner** 上构建（不能交叉编译糊过去）；`manifest.json` 记录 sha256，主仓库 stage 时校验。
- 版本与兼容：`manifest.json` 记录 `protocolVersion` 与 `minServerVersion`；
  **版本不匹配必须拒绝启动而不是降级运行**；二进制自报协议版本与源码常量在打包时交叉校验。
- 升级：Server 重启不影响 Render 与 PTY（已实测）；Render 自身热升级（fd 交接）未实现，
  当前做法是工程上无运行中会话时直接换。
- 回滚：配置切 `render.engine = legacy`，不需要回滚数据（DB schema 未变、config.json 只加键）。

---

## 9. 数据与安全兼容清单

| 项 | 要求 |
| --- | --- |
| `~/.wand/wand.db` | 两侧可交叉打开；迁移只加不删；不新增破坏性约束 |
| `config.json` | 合并与写回语义与 `loadConfigWithStorage()` 一致；新增 `core.*` 字段需默认值且不改变既有键 |
| `sessions/<id>/` 制品 | 文件名与格式不变（原始输出、结构化流事件、诊断材料） |
| `-c <path>` 隔离 | config / DB / socket / pidfile / token 全部按路径派生，保持单实例语义 |
| 密钥 | appToken 派生、cookie 会话、vault AES-256-GCM、TOTP HMAC-SHA1、常量时间比较；绝不回写 JSON |
| 日志 | 不记录连接码、appToken、私钥、机器本地路径 |
| 输入契约 | PTY 输入必须「先文本、后单独 `"\r"`」，`shortcutKey = "enter_text"` 保留 |

---

## 10. 验证矩阵

沿用项目记忆：**最终验收必须用本机已安装的 Wand 服务 + `~/.wand/acceptance-connection.json` 连接码**（连接码不得入库/入日志/入截图）。隔离实例只用于开发期冒烟。

| 层面 | 手段 | 期 |
| --- | --- | --- |
| DTO / provider 流 | 夹具差分门禁 | P0–P2 |
| PTY 字节与快照 | 逐字节比对 + 写入客户端 xterm 后屏幕等价（截图/快照断言） | P1 |
| REST / WS | 录制回放差分 | P3 |
| 存储 | 真实 DB 副本交叉读写 | P4 |
| 端到端 | 四端真机：登录、建会话、provider/model 切换、终端、结构化聊天、权限弹窗、重连/resume、上传、快捷提交、扩展行为 | P1 起每期 |
| 性能 | 吞吐 / 内存 / 冷启动 / 重连延迟基准（脚本化，进 CI 报告） | P1 起 |
| 分发 | 干净机器安装/升级/回滚 | P5 |
| 原生终端（iOS/Android） | 三端共享验收基线（§5.6）：快照重放顺序、ACK/缺口、输入拆包、中文 IME、备用屏幕、选区、`stty` 尺寸 | N0–N1 |
| 客户端契约一致性 | 同一 IDL 生成的 Swift/Kotlin/TS codec 对同一夹具产出一致 | N2 |

---

## 11. 风险登记

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | Claude 权限/聊天语义目前**只能靠 TUI 屏幕抓取**，端口到协议有未知 | 高 | P2 先做双向 `stream-json` spike（官方 CLI 支持 `--input-format stream-json`，SDK 侧存在 control protocol 与 `canUseTool` 语义），行为对齐前默认仍走旧路径，保留 fallback 开关 |
| 2 | 两套实现漂移 | 高 | IDL 单一真源 + 差分门禁 + 每期单一 owner 写入；未过门禁不进下一期 |
| 3 | Rust 生态缺口（claude-sdk、neo-blessed TUI、xterm serialize） | 中 | ADR-5 拍板；(a) 统一走 CLI；TUI 迁 ratatui；VT 用 ADR-3 spike 择一 |
| 4 | 跨平台分发（musl/glibc、Universal、Windows ConPTY） | 中 | 平台矩阵进 CI；ConPTY 单独验收；先只发 macOS/Linux，Windows 延后 |
| 5 | 迁移期 daemon 语义冲突（旧 Node daemon 持有 PTY 时切 Rust） | 中 | ADR-4 独立命名空间 + 明确「不热接管」；切换时若无会话则直接切换，有会话则提示重启 |
| 6 | 用户可见回归集中在权限、恢复、输入拆包 | 高 | 每期真机矩阵；差分门禁覆盖这三条路径 |
| 7 | 工作量与收益错配（P3+ 可能吃掉大部分预算而收益边际） | 高 | P3 设客观门禁；允许在 P2 后停止并长期维持「Rust 内核 + Node 边缘」双栈 |
| 8 | `npm run build` / bundle 预算与生成产物链路被破坏 | 中 | 迁移期不改 `scripts/` 与 `content/` 生成链路；Rust 侧只消费既有产物 |
| 9 | 原生终端在 iOS/Android 的行为矩阵（中文 IME、选区、鼠标、备用屏幕、重绘）是新实现的回归高发区 | 高 | 以 `macos/docs/native-terminal.md` 清单作为三端共享基线；N0 通过后再开 N1，不并行做两个新终端 |
| 10 | Android 终端视图依赖第三方（Termux `terminal-view`）的许可、维护状况与 Compose 互操作成本 | 中 | N1 先做 1 周 spike（许可/构建/IME/鼠标四项验证）；不通过则退为只做渲染层的最小自研 VT |
| 11 | 把「客户端也用 Rust」当成目标会导致 UI 层白费工 | 中 | ADR-9 明确首期客户端不嵌 Rust；UniFFI 仅作 N3 可选 |

---

## 12. 工作量

### 内核轨

| 期 | 人周（1 名熟悉本仓库的 Rust 开发者） | 累计 |
| --- | --- | --- |
| P0 | 1–2 | 2 |
| P1 | 2–3 | 5 |
| P2 | 3–5 | 10 |
| P3（门禁后） | 6–10 | 20 |
| P4 | 5–8 | 28 |
| P5 | 2–3 | 31 |

### 原生客户端轨（与内核轨并行，不互相阻塞）

| 轨道 | 人周 |
| --- | --- |
| N0 iOS 原生终端 | 2–3 |
| N1 Android 原生终端 | 3–5（含 1 周 spike） |
| N2 IDL + codegen | 1–2（依赖 P0） |
| 小计 | 6–10 |
| N3（可选）UniFFI 共享内核 | 4–8 |

**建议承诺**：

1. **N0–N2（约 6–10 人周）优先** —— 这是用户感知到的「原生而非 WebView 嵌套」的直接来源，且 macOS 已验证。
2. **P0–P2（约 10 人周）无条件执行** —— 覆盖 Rust 侧的真正痛点（PTY 原生化、转发器合并、屏幕抓取删除）。
3. 两条轨可并行：若只有一个人，顺序为 P0 → N2 → P1 → N0（P0/N2 同时锁定契约，后续两侧都在上面跑）。
4. **P3+ 按门禁逐期评审**，允许在 P2 后长期维持「Rust 内核 + Node 边缘」双栈。

---

## 13. 下一步（本周可执行）

**决策（需你拍板）**

1. ADR-1 进程模型 / ADR-4 daemon 命名空间 / ADR-5 `claude-sdk`。
2. ADR-8/9/10：确认「去 WebView 是客户端工程，Rust 负责字节流与契约，不为客户端嵌 Rust」。

**可直接开工**

3. 写 `docs/rust-core-contract.md`，从 WS 帧全集与 provider DTO 开始（两处最易漂移，也是 N2 codegen 的输入）。
4. 建 `tools/record-fixture/`：包装现有假 CLI 模式，对 `claude-cli-print` / `codex exec` / `pi --mode json` 各录一条真实 transcript。
5. 建 `wand-rs/` workspace 骨架：`wand-protocol` + `wand-term`，先只做 `forkpty` + 字节转发，跑通 `seq` 语义的单测。
6. **N0 开工**：在 iOS 复制 macOS 的 `NativeTerminalView` + `PtyTerminalStore` + `WandSocket` 模式（SwiftTerm 跨 iOS/macOS，同一库），先替换 `SessionDestinationView` 的 `embedTerminal` 路径，用 §5.6 清单验收。
7. **N1 spike**：验证 Termux `terminal-view` 的许可、构建、中文 IME、鼠标四项；不过则重新评估 Android 路径。
8. 补 `x86_64-apple-darwin` 与 Linux target，跑一次 CI 交叉编译，确认分发路径可行。
