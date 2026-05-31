# Wand 代码整改方案

> 生成日期：2026-05-31
> 范围：`src/`（2 万行 TS / 51 文件）、前端 `web-ui/content`（scripts.js 21849 行 + styles.css 16358 行）、构建脚本、Android / macOS 壳。
> 方法：分 6 个维度独立审查 + grep 交叉验证。本文按优先级（P0 必做 → P3 锦上添花）组织，每项给出「问题 / 证据 / 动作 / 风险 / 收益」。

---

## 0. 一句话结论

代码本身质量不差（strict TS、0 个 `@ts-ignore`、热路径性能有认真处理），但攒下了三类债：

1. **仓库卫生**：把前端构建产物逐版本提交进 git，`.git` 已 **288 MB**，且 2.1 MB 的 `embedded-assets.ts` 让每次前端改动 diff 爆炸 —— **最高 ROI 的修复项**。
2. **死代码与重复**：前端 ~1000+ 行死函数、CSS ~22% 死 class、后端多处复制粘贴的 semver/error/path 工具与三个 runner 互抄 —— 体量大但删除/收敛风险低。
3. **巨型文件**：`structured-session-manager.ts`(3171) / `server.ts`(2699) / `process-manager.ts`(2264) 职责过载，且复制粘贴里藏了一个**真实功能 bug**。

外加一条立即可做的事：**当前工作区的 `NetUtils.java` 抽取是干净重构，建议先单独提交**（见 §6）。

---

## P0 — 必做（高 ROI、低风险，建议尽快）

### P0-1　停止把前端构建产物提交进 git ⭐ 最高优先

- **问题**：`src/web-ui/embedded-assets.ts`（**2.1 MB**，base64 内嵌 scripts.js + styles.css + 3 个 vendor bundle）、以及 `content/scripts.js` / `content/styles.css` 本身，都作为「构建产物」逐版本提交进了 git。
- **证据**：
  - `.git` 实测 **288 MB**；`embedded-assets.ts` 已入库（`git check-ignore` 未命中）。
  - `embedded-assets.ts` 历史 ~10 版 × 2.1 MB ≈ 20 MB；`scripts.js` ~180 版、`styles.css` ~130 版。base64 对 git delta 极不友好，前端任何小改都让整坨 base64 全变。
  - `build`/`check`/`dev` 三个脚本每次都重新生成 `embedded-assets.ts` —— 它本就是构建产物，没有任何理由入库。
  - `tsc`（`include: src/**/*.ts`）每次都要编译这个 2.1 MB 文件，纯浪费。
- **动作**（推荐方案，零行为变化）：
  1. 把 `src/web-ui/embedded-assets.ts` 加入 `.gitignore`，`git rm --cached` 移出索引。
  2. （评估后）把 `content/scripts.js`、`content/styles.css` 也改为「源在别处、构建产出」的产物 —— 注意它们目前**就是源文件**（`scripts.ts` 运行时 `readFileSync` 读它），所以这一步要先确定前端源码的「权威副本」放哪，不能直接 gitignore 掉源。**先只做 embedded-assets，scripts/styles 留到 §P2 前端结构整理时再定**。
  3. 确认 `npm publish` 走的是 `dist/`（CI 构建时生成），发布包不受影响。
- **关于已膨胀的历史**：停止提交后历史不再继续涨；若要回收已有 288 MB 需 `git filter-repo` 重写历史（**破坏性，需团队协调**），单独评估，不在本批。
- **风险**：低。需验证 CI（`npm-release.yml`）和本地 `build` 在干净 checkout 下能正常生成 `embedded-assets.ts`。
- **收益**：止住仓库膨胀；前端 PR diff 恢复可读；`tsc`/`check` 提速。

### P0-2　修复 SDK runner 的队列清空 bug ⭐ 唯一确认的功能 bug

- **问题**：`structured-session-manager.ts` 的 SDK runner 结束处理（约 **L2546**）写的是 `queuedMessages: interruptPrompt ? [] : ...`，**漏了** `!this.preserveQueueOnInterrupt.has(sessionId)` 判断（codex runner L1468、cli runner L2012 都有）。
- **后果**：用 SDK runner 时，排队条点「立即/插队」会**误清空剩余队列**；且 SDK 的 interrupt 分支（约 L2564）从不 `preserveQueueOnInterrupt.delete`，stale flag 污染下一次普通 interrupt。
- **根因**：三个 streaming runner 的 `child.on("close")` 收尾逻辑是复制粘贴的，改 cli/codex 两处时漏了 SDK 这处。
- **动作**：先补上判断止血；根治见 P2-1（抽统一收尾函数）。
- **风险**：低，对齐另外两个 runner 的既有行为。

### P0-3　删除「已双重确认」的后端死代码

> 以下均经 grep 复核为「仅定义处出现」或「无调用方」。**执行时仍逐个 grep 复核**（同名方法陷阱真实存在 —— 见下方 ⚠️）。

| 符号 | 位置 | 核验 |
|------|------|------|
| `isGitRepo` | `server.ts:499` | grep 仅 1 次 ✅ |
| `hasRealConversationMessages`（含 `REAL_CONVERSATION_MIN_MESSAGES`） | `resume-policy.ts:8` | grep 仅 1 次 ✅ |
| `getModelsForProvider` / `knownModelIds` / `isKnownModel`（永远 `return true`） | `models.ts:103/109/114` | 前两个 grep 仅 1 次 ✅ |
| `hasAppSecret` | `storage.ts:384` | grep 仅 1 次 ✅ |
| `NPM_UPDATE_PACKAGE_NAME` | `npm-update-utils.ts:446` | 导出零引用 |
| `safeSliceTail` 的 `export` | `pty-text-utils.ts:104` | 仅同文件内部用，去掉 export 即可 |

- ⚠️ **需复核（同名陷阱）**：
  - `structured-session-manager.ts` 的 `approvePermission`/`denyPermission`/`resolvePermission` 被报为死代码，**但 `process-manager.ts:1798/1802` 的同名方法是活的**（`server-session-routes.ts:834/851` 调用）。删前务必确认删的是 structured 那一份、且 structured 实例确实没暴露这些路由。
  - `process-manager.ts:2139` `isClaudeCommand` 报为死代码，但全仓 `isClaudeCommand` 出现 8 次（多为 `claude-pty-bridge` 的 field/option 同名）—— 复核后再删。
- **风险**：低（删确认项）/ 中（同名项，必须复核）。
- **收益**：减噪，降低「哪个该用」的困惑。

### P0-4　删除前端 scripts.js 的死代码（~1000+ 行）

- **问题**：`web-ui/content/scripts.js` 有 **46 个死函数**（全文件仅出现 1 次=定义处），其中最大一块是一整套 ~18 个 `*InputViewport*` / `syncInputBox*` 函数 —— 被 `setupVisualViewportHandlers`（活的）取代后忘删的旧 IME/viewport 稳定子系统；外加半删除的 mini-keyboard 特性（`hideMiniKeyboard` 活、`show/toggle/setVisible/handleClick` 全死）。
- **动作**：整段删除，预计净减 **800–1200 行**。删前 `grep -c '\bname\b'` 复核，并确认不在 `window.__X` 暴露表（子代理已确认这批都不在）。
- **风险**：低（已逐个核为零调用），但建议删后做一次浏览器冒烟（登录/会话/聊天/终端/设置/快速提交）。
- **收益**：21849 行可降到 ~18000 行，后续维护与拆分都更轻。

### P0-5　删除 CSS 死代码（~22% 体积）

- **问题**：`content/styles.css` 1187 个 class 里约 **257 个（22%）** 在 `scripts.js`+`index.ts` 完全无引用（含无前缀拼接），是近期 UI 重构后没跟着删的死规则；另有一整套 27 个 Tailwind 风格原子类（`.mt-sm`/`.px-*`/`.opacity-70` 等）26 个是死的。
- **动作**：用 PurgeCSS（以 `scripts.js`+`index.ts` 为内容源）扫描批量删；保守起见先删确认无动态拼接的整段（`.blank-chat-*`、`.chat-handoff*`、`.btn-pill-*`、`.composer-pill-*`、`.skeleton-*`、整套原子类）。
- **风险**：中（CSS 可能有 JS 动态拼接 class 名）—— **必须 PurgeCSS + 人工抽查 + 浏览器视觉回归**，不要纯手工。
- **收益**：CSS 体积降约 1/5。

### P0-6　清理调试 `console.log` 残留

- **证据**（实测）：`server-session-routes.ts` **8 处** `[WAND]` 请求级日志（L195/201/219/295/648/651/701/778）、`scripts.js` **24 处**、`structured-session-manager.ts` **1 处**（L694 幂等命中）。这些是开发残留（真错误用 `console.error`），TUI 模式下还会被 `log-bus` 截获刷屏。
- **动作**：删除，或收敛到 `WAND_DEBUG` 门控的 `debugLog()` / 前端 `dbg()`。保留 `scripts.js` 顶部 SW 注册那 2 条合理降级提示。
- **风险**：极低。

---

## P1 — 重点（值得做，中等投入）

### P1-1　统一 semver 比较 / 提取到单一真源

- **问题**：semver **比较 3 份且行为不一致** —— `server.ts:114`（最严谨，处理 prerelease + `-debug.MMDDHHMM` 后缀）、`tui/commands.ts:752`（简版，把 `1.2.3-rc1` 当 4 段数字比）、`path-repair.ts:160`（同简版）。semver **提取正则 4 份**（`models.ts:38`、`server.ts:716`、`git-quick-commit.ts:379`、`path-repair.ts:152`）。
- **风险点**：带 `-debug` 后缀的版本号，server 版与 tui 版排序可能相反 —— 真实潜在 bug。
- **动作**：新建 `src/version-utils.ts`，导出最严谨的 `compareSemver` + `SEMVER_PATTERN` 常量 + `extractSemver()`，三/四处统一 import。
- **收益**：消除排序不一致风险，CLAUDE.md 提到的版本正则也有了单一真源。

### P1-2　修正 npm 依赖划分

- **动作**：
  - **删 `@types/cookie`**：`cookie` 运行时包根本不在依赖里（auth.ts 手写 `split(";")` 解析），这是悬空死类型包。✅ grep 确认 0 引用。
  - `@wterm/dom` 从 `dependencies` → `devDependencies`：src 0 引用，仅构建期被 esbuild 打进 bundle，不该污染用户 `npm install -g` 运行时树。
  - `@types/compression`、`@types/multer` → `devDependencies`（类型包不进 runtime deps）。
- **风险**：低，验证 `npm ci && npm run build` 通过即可。
- **收益**：终端用户少装一棵 `@wterm/dom` 子树。

### P1-3　抽取跨文件重复工具

| 重复 | 分布 | 统一到 |
|------|------|--------|
| `err instanceof Error ? .message : String()` 内联 **17 处** | npm-update-utils ×6、path-repair、service-self-repair、cli、claude-sdk-runner… | 新增 `toErrorMessage(err)`（注意：`server-session-routes.ts:17 getErrorMessage` 语义是「带兜底文案」，**不能混用**，保留为 HTTP 专用） |
| `which`/`where` 命令解析 **3 份** | `npm-update-utils:434`、`path-repair:405 whichSync`、`tui/commands:511`（**漏 Windows `where`**） | 导出 `path-repair` 的 `whichSync`，三处复用，顺手修 tui 的 Windows 缺口 |
| 「常见 Unix bin 路径」清单 **3 份** | path-repair、npm-update-utils `COMMON_UNIX_PATHS`、tui/commands | 收敛到 path-repair 导出常量 |
| managed 中英双语 prompt **逐字 2 份** | `process-manager.ts:2239` + `structured-session-manager.ts:456` | 抽共享 `buildManagedAutonomyDirective(isChinese)`，否则改文案必漏一处 |
| `isRunningAsRoot` **2 份**（行为还不一致，process-manager 少 geteuid 判断） | process-manager:26、structured:226 | 抽到 `env-utils.ts` / 新 `os-utils.ts` |

- **收益**：消除漂移源（尤其 prompt 和 semver 这种「改一处漏一处」的）。

### P1-4　前端资产加构建期 minify

- **问题**：`styles.css` / `scripts.js` 未经压缩就直接服务 + 内嵌（仅 server 端 `compression` gzip）；而 wterm/qrcode 走了 esbuild `minify:true`。
- **动作**：构建链加一道 CSS/JS minify（esbuild 即可，已是依赖）。与 P0-1/P0-4/P0-5 叠加，能同时缩小服务体积和内嵌副本体积。
- **风险**：低，但要保证 source 仍可读、minify 只作用于 dist 产物。

### P1-5　前端抽 fetch / DOM helper + 修监听器泄漏

- **问题**：
  - `scripts.js` 有 **87 处 fetch**，41 处 `JSON.stringify`、45 处手写 `Content-Type`、82 处 `.then(r=>r.json())`、反复手写 `credentials` 和 401→logout、瞬时网络错误判断 —— 零封装。
  - `attachEventListeners`（**1135 行**，L6053–7187）每次全量 `render()` 都重跑，内含匿名 `document.addEventListener("click", function(){})`（L6220/6224/6683/6694/7031）**每次叠加、无 removeEventListener、无去重守卫** → 监听器泄漏。
- **动作**：
  1. 抽 `apiGet(path)`/`apiPost(path,body)`：统一塞 `credentials`、`Content-Type`、401→logout、吞瞬时错误。一个 helper 消掉数百行。
  2. 全局监听（document/click、window/resize）挪到只跑一次的 `initOnce()`，或具名函数 + 绑定前 removeEventListener；用事件委托替代逐元素绑定。
- **风险**：中（触及事件绑定核心路径）—— 需充分冒烟。
- **收益**：消掉数百行噪音 + 修掉真实内存泄漏。

---

## P2 — 结构性重构（分阶段，按子系统逐个 PR）

> 这些是大手术，**不要一次性做**。每个拆分为纯重排、不改行为，配合冒烟逐个落地。

### P2-1　`structured-session-manager.ts`（3171 → ~1800）

- 三个 runner（`runClaudeStreaming` ~556 行 / `runClaudeSdkStreaming` ~495 行 / `runCodexStreaming` ~290 行）的 `scheduleEmit`/`flushEmit`/`syncSnapshot`、"replace-or-append 末尾 assistant turn"（全文出现 8 次）、interrupt-and-send 回滚、ExitPlanMode 自续接、finalize 收尾几乎逐行复制 → 抽 `StreamingTurnDriver` / 共享私有方法（`upsertLastAssistantTurn`、`finalizeSuccess/Failure`、`rollbackToIdle`、`finalizeTurnSuccess`）。**P0-2 的 bug 根治即在此**。
- 8 个模块级纯函数（thinking/permission/subagent/mcp helpers，L42-497）外移到 `structured-runner-helpers.ts`。
- 删 structured 的 `approvePermission`/`denyPermission`/`resolvePermission`（确认死后，见 P0-3）。
- `extractUsage`/`extractSdkUsage`/`extractCodexUsage` 三合一为 `pickNumericUsage(source, fieldMap)`。

### P2-2　`server.ts`（2699 → ~1000）

- **APK vs DMG 六对平行函数 + 两套 interface** 几乎逐字相同（仅扩展名/config 键/下载路径不同）→ 抽 `src/mobile-assets.ts` 的 `createPlatformAssetResolver({ext, configKey, downloadUrl, ghAssetMatcher})`，APK/DMG 各实例化一次，砍 ~250 行。
- `startServer`（~1608 行）按域拆 `registerSettingsRoutes`/`registerFileBrowserRoutes`/`registerUpdateRoutes`/`registerMobileAssetRoutes`（仿现有 `registerSessionRoutes`），`startServer` 只做装配。
- HTTP Range 解析重复 2 遍（`/android/download` L1318、`/api/file-raw` L2099，macos download 反而没做）→ 抽 `streamFileWithRange()`。
- 扩展名→MIME 在 3 处各列一份（`map`/`TEXT_PREVIEWABLE_EXTS`/`MIME_BY_EXT`）→ 复用 `MIME_BY_EXT`；删 L1169 的 7 层三元嵌套。
- `compareSemver` 移走（见 P1-1）；`normalizePersonaName`/`normalizePersonaAvatar` 字节级相同 → 合并。

### P2-3　`process-manager.ts`（2264 → ~1600）

- 模块级 Claude/Codex 历史扫描函数群（L131-630，~500 行 JSONL/rollout 解析）与 PTY 编排无关 → 外移到 `claude-history-scanner.ts` + `codex-history-scanner.ts`。
- constructor 两个恢复分支（L764/L811）~40 字段里 ~35 相同 → 抽 `buildRestoredRecord(snapshot, provider, {markExited})`。
- 计时器清理 4 连块在 4 处重复 → 抽 `clearRecordTimers(record)`。
- `delete` 复用 `cleanupRecord` 再追加持久化清理。
- 删 `isClaudeCommand`（复核后，P0-3）；核实 `autoConfirmWithRecord`（已 `@deprecated` 且调用条件自相矛盾）是否可整段删。

### P2-4　类型清理

- `cli.ts:291-292` `FullServerHandle` 的 `processManager: any` / `structuredSessions: any` → 用 type-only `import("./server.js").ServerHandle` 或复用 `ServerHandleForBanner` 的 `listSlim()` 结构形状。**高价值零风险**。
- 删 `types.ts` 的 `ChatMessage`（被 ConversationTurn 取代）、`SessionCreateKind`（与 `SessionKind` 字面量完全相同）—— 均零引用。
- 抽 `export type ThinkingEffort = "off"|"standard"|"deep"|"max"`，消除 `types.ts:264/474` 逐字重复。
- 合并 `GitCommandError`（`git-quick-commit.ts:19` + `git-worktree.ts:26`，仅差 `code?`）到共享位置。
- `server.ts:2212 catch(error: any)` → `unknown` + `getErrorMessage`（仓库唯一漏网的 `catch...: any`）。
- `PermissionResolution`（pty-bridge）声明为 `Exclude<EscalationResolution, "fallback_manual">`，显式表达子集关系。

### P2-5　原生壳收敛（与本次 NetUtils 抽取同一目标）

- **macOS**：`SelfSignedSession.swift:36-60` 的 `onProgress`/`onFinish`/`onFail` + 3 个 download delegate 方法是**死代码**（`DmgInstaller` 自建 session，从不读）→ 删，协议收回到 `URLSessionDelegate`。`DmgInstaller.swift` 重复实现了 server-trust 挑战处理 → 二选一收敛。
- **Android**（潜在 bug，中）：`MainActivity.java:1267-1277` 处理 301/302 重定向时，对重定向后的新连接**没调 `NetUtils.trustSelfSigned`** → 补一行，与首次连接对齐。
- `NotificationBridge` 内 6 处 `new ServerStore(...)` → 持字段复用。

---

## P3 — 锦上添花（低优先，有空再做）

- CSS：出现 ≥3 次的硬编码色值提 CSS 变量（`#fff`×37、品牌四色、语义红绿、`rgba()` 阴影体系）；抽 3-5 个布局基类（`display:flex`×251、`align-items:center`×246 高频重复）。
- `tsconfig.json` 评估开启 `noUncheckedIndexedAccess`（strict 外），分批消化告警，暴露 PTY 解析/流式 block 的潜在越界。
- `scripts/bundle-wterm.js` 的两个正则 patch 失配时 `console.warn` → 升级为 `process.exit(1)`，避免升级 `@wterm/dom` 后补丁静默失效。
- 前端 `t()`/i18n 是半成品（只覆盖 ~15 个 key，其余硬编码中文）→ 要么承认单语言删掉 `t()`，要么真正迁移文案，别两头不到岸。
- `models.ts` 的 `probeCodexModels`/`probeClaudeVersion` 用 `exec`(shell) → 对齐全仓 `execFile`/`spawnSync` 习惯。
- `git-quick-commit.ts`：`runGitAllowEmpty` 与 `runGit` 仅差 `.trim()` → 合并；三个 AI 生成函数抽 `buildTagHint`/`collectDiffForAI`。
- `tui/session-formatter.ts` 与 `storage.ts` 同名 `SessionRow`（结构不同）→ 改名 `TuiSessionRow`/`DbSessionRow` 避免 grep 混淆。
- 跨端 versionCode 公式不一致（Android `build.gradle` 用 `*1e6/*1e4/*100`，CLAUDE.md/手动命令与 macOS `build.sh` 用 `*1e4/*100/*1`）→ 统一文档与脚本。
- Android `AndroidManifest.xml` 的 `POST_PROMOTED_NOTIFICATIONS` 权限疑似未用 → 确认后移除或加注释。

---

## 6. 当前工作区改动处理

`MainActivity.java`(改) + `NetUtils.java`(新)：把 `MainActivity` 和 `ConnectActivity` 里**逐字相同**的 `trustSelfSigned()` 抽成共享 `NetUtils`，删了孤儿方法和 4 个 SSL import，调用点全切换。审查确认是**干净的零行为重构、无遗留**。
**建议**：先单独提交（`抽取 trustSelfSigned 到 NetUtils 共享工具类`），与本方案其余改动解耦。提交时注意 `ConnectActivity.java` 也被改了，一并纳入。

---

## 7. 推荐执行批次

| 批次 | 内容 | 风险 | 验证 |
|------|------|------|------|
| **批 0** | 提交 NetUtils 重构（§6） | 极低 | `gradlew assembleDebug` |
| **批 1** | P0-1 embedded-assets 移出 git + P0-2 SDK bug + P0-6 console.log | 低 | `npm run check && npm run build`，干净 checkout 构建 |
| **批 2** | P0-3 后端死代码 + P0-4 前端死函数 + P0-5 死 CSS | 低-中 | `npm run build` + 浏览器全流程冒烟 |
| **批 3** | P1-1 semver 统一 + P1-2 依赖 + P1-3 工具去重 + P1-4 minify | 低-中 | `npm ci && npm run build` |
| **批 4** | P1-5 前端 fetch helper + 监听器泄漏 | 中 | 重点冒烟事件交互 |
| **批 5+** | P2 结构性重构，按子系统逐个 PR | 中 | 每个独立冒烟 |
| 随手 | P3 项穿插在相关改动里 | 低 | — |

**每批后必跑**：`npm run check && npm run build`；触及前端/UI 的批次额外做浏览器 QA（登录、会话创建、聊天/终端、权限提示、resume、快速提交、设置）。
