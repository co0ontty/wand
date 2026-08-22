# AGENTS.md

本文件是本仓库所有编码 agent 的**唯一操作指南**。原 `CLAUDE.md` 已删除，其内容已并入本文；深入的行为分析见 `docs/`（服务端 `docs/server-logic-analysis.md`、客户端 `docs/client-logic-analysis.md`、优化排期 `docs/optimization-plan.md`）。

## Project Snapshot

`wand` 是本机 AI CLI 工具的 Node.js Web 控制台，支持 Claude Code、Codex、OpenCode、Grok、Qoder、Pi 六个 provider。Express + WebSocket 服务浏览器 UI；会话跑在 PTY 或结构化非 PTY 进程里；PTY 由**独立的 terminal daemon**（`wand terminald`）持有，web 重启 / 自更新不杀 shell。配置、鉴权、会话状态持久化在激活配置文件所在目录。

- Runtime: Node.js `>=22.5.0`, TypeScript, ESM。
- 默认 config: `~/.wand/config.json`；SQLite: `~/.wand/wand.db`；会话制品: `~/.wand/sessions/<sessionId>/`。
- `-c /path/to/config.json` 隔离以上全部（隔离测试统一用 `/tmp/wand-dev/`）。
- 单实例按 config 路径隔离：已有实例时 `wand web` 走 IPC attach，不开第二个 server。

原生客户端是 git submodule：

| Path | Repository |
| --- | --- |
| `android/` | `co0ontty/wand-android` |
| `ios/` | `co0ontty/wand-ios` |
| `macos/` | `co0ontty/wand-macos` |

克隆后先 `git submodule update --init`。

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

两套 runner 共享类型和存储，**不共享执行代码**；改一边不会自动影响另一边。Structured 是非交互的，没有运行时权限提示。

## Session 输入契约（最容易写错）

PTY 输入服务端原样写入终端，客户端必须拆成**先文本、后单独 `"\r"`** 两包（快捷键回车标 `shortcutKey = "enter_text"`）；不要用 `text + "\n"` 代替回车。参考实现：Web `getTerminalSubmitChunks`、iOS `sendPtyInput`、Android `PtyTerminalScreen.sendPtyDraft`。详见 `docs/client-logic-analysis.md` §6。

`SessionSnapshot.claudeSessionId` 名不副实：存的是各 provider 的原生 resume 标识（Claude UUID、Codex thread、OpenCode/Grok/Qoder ID）。恢复逻辑横跨 `process-manager.ts`、`resume-policy.ts`、`storage.ts` 和各 provider 历史目录，时间窗兜底只在候选唯一时绑定。

## Web UI 与生成文件

前端是服务端渲染的单 HTML shell + 内联资产，浏览器侧有**两层并存**：

- Legacy vanilla-TS 层：`src/web-ui/browser/*.ts`（entry `main.ts`）— 终端、聊天渲染、WS、输入
- React 层：`src/web-ui/react/*.tsx` — Shell、新建会话、设置、工作空间、任务、文件预览/编辑器等

回滚开关：`?reactUi=0` 关整个 React UI/Shell；`?reactShell=0` 只回退 Shell（对话框保留）。React 通过 `*-adapter.ts` 调 legacy 的 `selectSession` / 终端池。

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

Raw PTY 输出和结构化聊天 turn 是同一会话的两种表示；渲染 bug 先查 provider parser / WS payload / `chat-render.ts`，别急着怪 CSS。

## State、Config 与目录

- Config 默认值与合并：`src/config.ts`。`loadConfigWithStorage()` 会把合并结果写回磁盘——改 config schema 必须同步它。
- SQLite 在配置文件旁边解析。迁移**只加列/加表，从不 DROP**。
- 状态分四桶：部署项（config.json）/ 偏好（SQLite pref:*）/ 密钥（SQLite，绝不回写 JSON）/ 大件（文件或 daemon 内存）。
- 上传写在 `<session.cwd>/.wand-uploads/`；worktree 在仓库根 `.wand-worktrees/`；分发文件默认 `<configDir>/android|macos|ios/`。

持久化看起来不一致时，同时查 `src/storage.ts` 和 `src/session-logger.ts`，它们互补而非冗余。

## Browser Extension

MV3 密码库扩展在 `browser-extension/`，后端在 `src/password-manager.ts` + `/api/browser-extension/*`。改鉴权、保险库、TOTP、自动填充前先读 `docs/browser-extension.md`。扩展通过 `POST /api/login { client: "browser-extension" }` 拿 appToken；改密码会使旧 token 失效。后端改动跑 `tests/password-manager.test.ts`。

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
cd ios   && ./build.sh <version>    # 未签名 IPA（CODE_SIGNING_ALLOWED=NO），sideload 安装
```

- macOS ad-hoc 自签，无公证；换签名身份会让老用户被 Gatekeeper 拦截。
- iOS 不签名、无应用内更新；模拟器设备用真实存在的名字（`Wand Debug`、`Wand Live Activity QA`、`Wand iPad Debug`，见 `xcrun simctl list devices`），编译验证加 `CODE_SIGNING_ALLOWED=NO`。
- 分发目录：默认实例 `~/.wand/macos|ios/`，隔离测试 `/tmp/wand-dev/macos|ios/`。macOS 需在 config 开 `macos.enabled`。

### Mobile UX 对齐规范

移动端开发优先对齐 iOS 已验证布局与 `android/docs/ios-mobile-updates-reference-2026-06-18.md`，要点：

- PTY 页是原生外壳（原生顶栏 + `embed=terminal&nativeInput=1` WebView + 原生底栏），网页输入栏隐藏。
- Chat/PTY 快速提交共用 GitChangesButton / QuickCommitStore / QuickCommitSheet。
- 外观模式持久化为 `wand.appearanceMode`（light/dark/system）。
- Android 嵌入终端「乱码」多是列宽/字号问题，不是 UTF-8；注入 CSS 后触发重新 fit。

## Update Channels & Releases

- 更新通道存 SQLite `updateChannel`（stable/beta）。stable → `@co0ontty/wand@latest`；beta → `@beta`（beta 分支 CI 带 prebuilt dist）。更新判定用 `npm view` 比版本；`dist/build-info.json` 只给 UI 展示。
- 更新后自修复：`repairServiceUnitAfterUpdate()` 重写 systemd/launchd unit；重启策略见 `src/relaunch.ts`。
- APK beta 通道走 `?channel=beta`（本地 apkDir 是唯一 beta 来源）；macOS beta 走 GitHub prerelease 清单校验。

正式发布全部由 tag 驱动：push 一个 `v*` tag，GitHub Actions 并行出 npm 包 / APK / DMG / release notes。相关 workflow：`npm-release.yml`、`android-release.yml`、`macos-release.yml`、`macos-beta.yml`、`ios-build.yml`、`release-notes.yml`、`beta-branch.yml`、`cleanup-old-releases.yml`。

`release-notes.yml` 是 GitHub Release body 的唯一写入者，其他 workflow 不得碰 body。`publish.sh` 只做本地构建 + 本地分发部署，**不发布 npm**。

## Style and Safety

- 2 空格缩进、双引号、分号；行宽 ~100 字符软上限。
- Node built-in 用 `node:` 前缀 + 具名导入；ESM 相对导入带 `.js` 扩展名。
- 文件 kebab-case、类型 PascalCase、函数 camelCase、常量 UPPER_SNAKE_CASE。
- 导出函数尽量显式返回类型；错误捕获 `unknown` 并用 `src/error-utils.ts` 的 `getErrorMessage()`。
- 高频事件防抖（输出 16ms、任务 100ms）；大输出用有界缓冲。
- Commit：短祈使句 subject，一次一个逻辑变更；UI 改动附截图/录屏。
- Schema 迁移只加不删；不合并两套 runner；不在 PTY bridge 伪造 tool block。
- 绝不提交真实密码、appToken、私钥或机器本地路径；`host` 默认 `127.0.0.1`，除非有意远程访问。
- 新增命令执行类配置项必须在文档写明。

## Validation

TS / 后端 / web UI 改动常规验证：

```bash
npm run check
npm test
npm run build
```

迭代期先跑相关单测文件，交付前跑全量。用户可见的会话/UI 行为改动，起隔离打包服务器人工验证受影响的流程（登录、建会话、provider/model 切换、终端与结构化聊天、权限弹窗、重连/resume、上传、快捷提交、扩展/原生行为）：

```bash
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```

会话 / DTO / 权限相关改动补针对 `session-transport`、`server-session-routes`、`password-manager` 的单测。
