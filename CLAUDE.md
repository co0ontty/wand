# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install                # Install dependencies (requires Node.js >= 22.5.0)
npm run check              # Type-check only (tsc --noEmit)
npm run build              # Four steps: bundle wterm → bundle qrcode → tsc → copy src/web-ui/content into dist/web-ui/
npm run dev                # Run the CLI entrypoint directly from src/ via tsx
node dist/cli.js init      # Create or refresh config + SQLite files
node dist/cli.js web       # Start the packaged web server from dist/
wand config:path           # Print resolved config path
wand config:show           # Print merged runtime config
wand config:set host 0.0.0.0  # Update a simple config value
wand service:install          # Install + start as systemd (Linux) / launchd (macOS) service; --user for user-level
wand service:status           # Service state; also :start :stop :restart :logs :uninstall
```

`wand web` is single-instance per config: if a wand instance is already running, it **attaches** (TUI or banner) instead of starting a second server. In a TTY it renders a neo-blessed TUI dashboard; set `WAND_NO_TUI=1` to force the plain one-line banner. `wand service:*` flags: `--user`/`--system` (default system, needs root), `--verbose`, `--lines <N>` (for `service:logs`).

There is no automated test suite, no single-test command, and no lint/format script in this repo.

**Recommended validation after TS or UI changes:**
```bash
npm run check
npm run build
```

**Smoke test:**
```bash
npm run build && wand init && wand web
```

**Isolated dev server with disposable data:**
```bash
npm run dev -- -c /tmp/wand-test/config.json
```
This keeps config, database, and session artifacts under `/tmp/wand-test/`. The same `-c` flag also works with the compiled binary (`wand web -c /tmp/wand-test/config.json`).

**Testing server (use this for all QA / smoke tests):**
```bash
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```
The test config at `/tmp/wand-dev/config.json` should use its own port (edit the `port` field after first `init`). Working directory for test tasks: `/tmp/wand-dev/workspace/`. This keeps QA isolated from any other wand instance you happen to be running.

**Manual browser QA / release verification:** Open the test server in a browser and verify login, session creation, chat/terminal views, permission prompts, and resume.

**Install flow from README:**
```bash
npm install -g @co0ontty/wand
wand init
wand web
```
The runtime config file is `~/.wand/config.json` by default.

**Repo-specific notes:**
- `npm run dev` already runs `src/cli.ts web`; append CLI flags after `--`.
- `ensureConfig()` rewrites the config file with defaults merged in, so config-schema changes must also update `src/config.ts`.
- `npm run build` must keep copying `src/web-ui/content/` into `dist/web-ui/`; the packaged app depends on those static assets.
- `scripts/bundle-wterm.js` uses esbuild to bundle `@wterm/dom` into `src/web-ui/content/vendor/wterm/wterm.bundle.js` and copies `terminal.css` next to it. It also patches the renderer to strip an underline branch (`stripUnderlinePlugin`). After changing wterm-related code or upgrading `@wterm/dom`, you must re-run this script — `npm run dev` does not rebundle automatically. The committed bundle is what the browser loads.
- `scripts/bundle-qrcode.js` similarly bundles the `qrcode` npm package (entry `scripts/qrcode-entry.js`) into `src/web-ui/content/vendor/qrcode/qrcode.bundle.js`, used by the browser to render the mobile-connect QR code. Re-run it after upgrading `qrcode`. `npm run build` runs both bundlers before `tsc`.

## Android APK Build & Deployment

项目包含一个 Android WebView 壳应用，源码在 `android/` 目录。

**编译 APK：**
```bash
cd android
# 使用最新 git tag 作为版本号，加 debug 时间戳后缀
# versionCode 由 publish.sh 自动派生（major*10000+minor*100+patch）；手动构建时随便给一个递增整数即可
./gradlew assembleDebug \
  -PAPP_VERSION_NAME="$(git describe --tags --abbrev=0 | sed 's/^v//')-debug.$(date +%m%d%H%M)" \
  -PAPP_VERSION_CODE="$(git describe --tags --abbrev=0 | sed 's/^v//' | awk -F. '{printf \"%d%02d%02d\", $1,$2,$3}')"
```
产物：`android/app/build/outputs/apk/debug/app-debug.apk`

**部署 APK 供下载：**

服务端通过 `config.android.apkDir`（相对于 config 目录）查找 APK 文件，按修改时间取最新的。

| 环境 | Config 目录 | APK 目录 |
|------|------------|---------|
| 默认 | `~/.wand/` | `~/.wand/android/` |
| 隔离测试 | `/tmp/wand-dev/` | `/tmp/wand-dev/android/` |

如果同时在跑默认实例和隔离测试实例，APK 两个目录都要放，否则切到哪个实例就只能下到那边的版本。

```bash
# 编译后同时部署到两个目录（按需）
cp android/app/build/outputs/apk/debug/app-debug.apk ~/.wand/android/wand-v<VERSION>.apk
cp android/app/build/outputs/apk/debug/app-debug.apk /tmp/wand-dev/android/wand-v<VERSION>.apk
```

**版本号规则：**
- 文件名中必须包含语义化版本号（如 `wand-v1.13.2.apk`），服务端通过正则 `(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)` 提取
- 版本号必须高于当前已安装版本，APK 端才会触发更新弹窗（`compareSemver` 比较）
- 开发调试时用 `-debug.MMDDHHMM` 后缀区分构建

**APK 下载来源优先级：**
1. 本地文件（`apkDir` 目录中最新的 `.apk`）→ source: `"local"`
2. GitHub Release 回退 → source: `"github"`

设置页面会显示来源标签（本地/线上）。

**图标切换：**
APK 支持运行时切换启动器图标（赛博虎妞 / 勤劳初二），通过 `AndroidManifest.xml` 中的 `<activity-alias>` 和 `PackageManager.setComponentEnabledSetting` 实现。相关 drawable 资源：
- `ic_launcher_foreground.xml` / `ic_launcher_background.xml` — 虎妞（灰猫）
- `ic_launcher_foreground_garfield.xml` / `ic_launcher_background_garfield.xml` — 初二（橙猫）

**签名 keystore（重要）：**
仓库根目录提交了 `android/wand-release.keystore`（密码 `wand-release`，alias `wand`），`app/build.gradle` 把它配成 debug 和 release 共用的 signingConfig。这样本地、`publish.sh`、GitHub Actions 三种构建出来的 APK 签名一致，用户在不同来源升级时不会撞上"签名冲突"。

**注意：** 这是自签名分发用 key，不是 Play Store 上传 key。也因此**绝不要换 keystore**——一旦换了，所有已安装的旧版 APK 都会因签名不匹配而无法升级，必须先卸载。

## macOS DMG Build & Deployment

项目包含一个 macOS WebView 壳应用（SwiftUI + WKWebView），源码在 `macos/` 目录。

**编译 DMG（仅 macOS）：**
```bash
cd macos
./build.sh 1.16.0
# 产物：build/Wand.app + dist/wand-v1.16.0.dmg
```

要求：macOS 12+、Xcode 15+ 命令行工具。**不需要 Apple Developer 账号**（ad-hoc 自签名）。

**部署 DMG 供下载：**

服务端通过 `config.macos.dmgDir`（相对于 config 目录）查找 DMG 文件，按修改时间取最新的。

| 环境 | Config 目录 | DMG 目录 |
|------|------------|---------|
| 默认 | `~/.wand/` | `~/.wand/macos/` |
| 隔离测试 | `/tmp/wand-dev/` | `/tmp/wand-dev/macos/` |

```bash
cp macos/dist/wand-v<VERSION>.dmg ~/.wand/macos/wand-v<VERSION>.dmg
cp macos/dist/wand-v<VERSION>.dmg /tmp/wand-dev/macos/wand-v<VERSION>.dmg
```

需要在 `config.json` 里把 `macos.enabled` 改成 `true` 才会启用下载入口：

```json
{
  "macos": {
    "enabled": true,
    "dmgDir": "macos",
    "currentDmgFile": ""
  }
}
```

**版本号规则：**
- 文件名中必须包含语义化版本号（如 `wand-v1.16.0.dmg`），服务端正则 `(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)` 提取
- 版本号必须高于已安装版本，macOS 端才会触发自动更新弹窗

**DMG 下载来源优先级：**
1. 本地文件（`dmgDir` 目录中最新的 `.dmg`）→ source: `"local"`
2. GitHub Release 回退 → source: `"github"`

设置页面会显示来源标签（本地/线上），等同 Android APK 段。

**签名 keystore（重要）：**
macOS 端使用 **ad-hoc 自签名**（`codesign --sign -`），等同 Android 自签名 keystore，不需要 Apple Developer 账号。

用户首次打开 `Wand.app` 必须**右键 → 打开 → 打开**（不要双击），系统会一次性允许"未公证开发者"的应用。

**注意：** 一旦换签名身份（比如未来上 Developer ID），所有已安装的旧版用户升级时会撞"代码签名变化"被 Gatekeeper 拦截。如果换签名，必须卸载旧版后重装。

**为什么不用 Sparkle / 公证：**
- Sparkle 引入第三方依赖与 EdDSA 签名密钥管理
- 公证（notarization）需要 Apple Developer Program（$99/年）+ `notarytool` 凭据
- 与"自分发 ad-hoc"目标不符 — 用"首次右键打开"换取零依赖、零账号成本

**架构：Universal Binary**

`build.sh` 输出 arm64 + x86_64 Universal Binary，在 Apple Silicon 与 Intel Mac 上都原生运行。

**自动更新流程：**

App 启动 5 秒后异步调 `/api/macos-dmg-update?currentVersion=<X>` → 弹 `NSAlert`（立即更新/稍后/跳过）→ `URLSession.downloadTask` 下载到 `~/Library/Application Support/Wand/` → `hdiutil attach -nobrowse -mountpoint` 挂载 → `NSWorkspace.open` 在 Finder 显示挂载点 → 用户拖拽 Wand.app 到 Applications。

对称 Android 的 `Intent.ACTION_VIEW`：把"实际安装"交回系统/用户决策，避免覆盖运行中的 `/Applications/Wand.app` 带来的权限与重启问题。

## Publishing & Release

版本号由 git tag 驱动。**发布全部交给 GitHub Actions**——push 一个 `v*` tag 即可：

```bash
git tag v1.15.0
git push origin v1.15.0
```

push tag 后三个 workflow 并行触发：
- `.github/workflows/npm-release.yml`（`ubuntu-latest`）：从 tag 同步版本号到 `package.json` → `npm ci` → `npm run build` → `npm publish --access public`。需要仓库 secret **`NPM_TOKEN`**（npm Automation / Granular Access token，对 `@co0ontty/wand` 有读写权限）。
- `.github/workflows/android-release.yml`（`ubuntu-latest`）：构建 APK 上传到对应 Release。
- `.github/workflows/macos-release.yml`（`macos-latest`）：构建 DMG 上传到对应 Release。

`publish.sh` 现在**只做本地构建 + 把 APK/DMG 部署到 `~/.wand/{android,macos}/`** 供本地实例分发，**不再 `npm publish`**（避免和 CI 撞 "version already exists"）。本地日常用 `start.sh`，正式发版用「打 tag + push」。

`install.sh` 是面向终端用户的一键安装脚本（自动装 Node.js 22+，然后 `npm install -g`）。

## Additional References

- `README.md` contains the end-user install/start flow (`npm install -g @co0ontty/wand`, `wand init`, `wand web`).
- There is no `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` in this repo.
- `.github/workflows/npm-release.yml` handles GitHub Actions npm publish on tag push (needs `NPM_TOKEN` secret).
- `.github/workflows/android-release.yml` handles GitHub Actions APK builds on tag push.
- `.github/workflows/macos-release.yml` handles GitHub Actions DMG builds on tag push (runs on `macos-latest`).

## Architecture

`wand` is a Node.js web console for local CLI tools such as Claude Code and Codex. The app starts from a CLI command, serves a browser UI over Express + WebSocket, launches commands inside PTYs with `node-pty` (or as one-shot streamed processes for the structured runner), and persists session/auth state in SQLite under `~/.wand/`. A single session is tagged with a `SessionRunner` (`claude` / `codex` / etc.) and an `ExecutionMode` that picks between the PTY runner and the structured runner — see "Two session runners" below.

### Runtime flow

1. `src/cli.ts` is the only entrypoint. It parses `wand init`, `wand web`, `config:*`, and `service:*`, resolves `-c/--config`, and always ensures config + SQLite files exist before startup. `wand web` is single-instance: if `pidfile.ts` reports a live instance it attaches over the IPC socket instead of starting a second server.
2. `src/server.ts` wires the whole application together: Express routes, auth/session APIs, file browser APIs, update endpoints, static assets, and the `/ws` WebSocket server.
3. `ProcessManager` in `src/process-manager.ts` is the core runtime owner for PTY-backed sessions. It launches commands, persists snapshots, handles resume/auto-recovery, watches for confirmation prompts, and bridges UI input back into the process.
4. `ClaudePtyBridge` in `src/claude-pty-bridge.ts` parses Claude PTY output into structured conversation turns, permission events, task/tool updates, and captured Claude session IDs while preserving raw terminal output in parallel.
5. The browser UI subscribes over `/ws` and renders the same session in two synchronized representations: terminal output and structured chat history.

When debugging a user-visible session bug, trace the full chain: `cli.ts` -> `server.ts` -> `process-manager.ts` -> `claude-pty-bridge.ts` -> web UI.

### Two session runners

A session can run in one of two modes, owned by different managers:

- **PTY runner** (`src/process-manager.ts`) — interactive PTY-backed sessions for `claude` / `codex` / shells. This is the default and drives both the terminal view and (via `ClaudePtyBridge`) the structured chat view. Permission prompts, resume, archive/idle transitions and most lifecycle logic live here.
- **Structured runner** (`src/structured-session-manager.ts`) — non-PTY sessions for prompts that don't need an interactive terminal. It runs Claude two ways: the CLI runner (`claude -p --output-format stream-json`) and the **Agent SDK** (`query()` from `@anthropic-ai/claude-agent-sdk`, with live handles tracked in `pendingSdkQueries` so a run can be interrupted). Both paths consume streamed JSON output; output debounce is 16 ms (`STREAM_EMIT_DEBOUNCE_MS`). It shares `WandStorage`, `SessionSnapshot`, and `ProcessEvent` types with the PTY runner, and can also use git worktrees via `prepareSessionWorktree()`. These runs are non-interactive — there is no permission prompt, so `mcp__*` tools fail rather than escalate.

When debugging session behavior, first check which runner owns the session — they share types but execute on independent code paths.

### Process model: single instance, TUI, and system service

`wand web` runs as one instance per config. On launch it checks `pidfile.ts` for a live instance:
- **No instance** → start the Express/WebSocket server, write a pidfile, and start an IPC server over a unix socket (`src/tui/ipc-server.ts`). In a TTY it then renders the neo-blessed TUI dashboard (`src/tui/index.ts`); otherwise it prints a one-line startup banner (`WAND_NO_TUI=1` forces the banner).
- **Live instance** → *attach* over the IPC socket (`src/tui/attach.ts`) instead of starting a second server.

`src/tui/` is a self-contained subsystem: the dashboard/attach UI, the IPC protocol/client/server, and the **system-service** commands (`commands.ts`) behind `wand service:*` — systemd units on Linux (`/etc/systemd/system` for `--system`, `~/.config/systemd/user` for `--user`) and launchd plists on macOS. Because a service unit freezes `PATH` at install time, `src/path-repair.ts` re-derives `PATH` at runtime so a spawned `claude` keeps resolving after the user switches Node versions (nvm/fnm/volta) or reinstalls without re-running `service:install`.

Auxiliary Claude features — quick-commit messages (`git-quick-commit.ts`) and prompt optimization (`prompt-optimizer.ts`) — use neither session runner; they call `claude-sdk-runner.ts`'s one-shot `runClaudePrint()` through the Agent SDK.

### API and UI boundary

`src/server.ts` is also the backend surface for the app. It serves:
- the single HTML shell from `renderApp()` in `src/web-ui/index.ts`
- REST endpoints for auth, config/settings, sessions, path browsing/search, favorites/recent paths, command launch, resume, PTY input/resize, permission decisions, and updates
- the `/ws` fanout used for live session state

Session-specific HTTP routes live in `src/server-session-routes.ts`; `src/server.ts` remains the composition root that injects `ProcessManager`, storage, auth, and broadcast plumbing.

Before adding a new abstraction, check whether the needed data can fit into an existing `/api/*` route or `ProcessEvent` payload.

### State and persistence

- Config lives in `~/.wand/config.json`; `ensureConfig()` in `src/config.ts` loads the file, merges defaults, and writes the normalized result back to disk.
- SQLite lives beside the config (`resolveDatabasePath(configPath)`), usually `~/.wand/wand.db`; `src/storage.ts` stores auth sessions, command sessions, app config overrides, Claude resume metadata, and serialized `ConversationTurn[]`.
- Schema migration policy is additive only: `ensureCommandSessionSchema()` adds missing columns and never drops old ones.
- `src/session-logger.ts` writes per-session artifacts under `~/.wand/sessions/<sessionId>/`, including rotating PTY logs, structured messages, metadata, native stream events, and shortcut interaction logs.
- Two more directories live **inside the session's working directory**, not under `~/.wand/`:
  - `<session.cwd>/.wand-uploads/` — uploaded files written by `src/upload-routes.ts` (10 MB per file, max 5 files per request, filenames sanitized to `[a-zA-Z0-9._-]`).
  - `.wand-worktrees/` (at the repo root when worktree mode is enabled) — per-session git worktrees created and cleaned up by `src/git-worktree.ts`. Snapshots store the worktree handle on `SessionSnapshot.worktree`.

If persistence looks inconsistent, inspect both SQLite (`src/storage.ts`) and file-based session artifacts (`src/session-logger.ts`); they are complementary, not redundant.

### Session and resume model

A session is not just a child process. `SessionSnapshot` in `src/types.ts` combines PTY state, buffered output, structured messages, lifecycle state, permission/escalation state, and optional Claude resume linkage (`claudeSessionId`, resumed-from/to fields, auto-recovery flags).

Resume behavior is split across multiple layers:
- `ProcessManager` decides when a session is resumable, restores snapshots, and scans Claude project JSONL history under `~/.claude/projects/`
- `ClaudePtyBridge` captures Claude session UUIDs from PTY output
- `resume-policy.ts` contains the heuristics for binding stored Claude history to wand sessions
- `storage.ts` persists both raw output and structured messages
- server routes expose session resume and Claude-history resume actions

If resume buttons, recovered sessions, or chat history look wrong, inspect those files together.

### Lifecycle and permissions

Two cross-cutting systems shape session behavior:
- `src/session-lifecycle.ts` marks sessions as initializing/running/thinking/waiting-input/idle/archived and performs timeout-driven idle/archive transitions.
- `ProcessManager` + `ClaudePtyBridge` detect permission prompts, track approval policy (`ask-every-time`, `approve-once`, `remember-this-turn`), keep per-session approval stats, and convert Claude CLI prompt text into structured escalation state for the UI.

A bug around blocked input, idle/archive transitions, or wrong permission state is usually not just a UI issue; check lifecycle state and permission detection before changing rendering.

### UI structure

The frontend is server-rendered, not a separate SPA build. `src/server.ts` serves one HTML document built by `renderApp()` in `src/web-ui/index.ts`, which inlines generated CSS and JavaScript and also references vendor assets.

When changing frontend behavior, check both layers:
- `src/web-ui/index.ts`, `styles.ts`, `scripts.ts` for server-assembled inline assets
- `src/web-ui/content/styles.css` and `src/web-ui/content/scripts.js` for copied browser assets used from `dist/`
- `src/web-ui/content/vendor/wterm/wterm.bundle.js` + `terminal.css` — the wterm terminal renderer, regenerated by `scripts/bundle-wterm.js`. Don't hand-edit the bundle; change source or upgrade `@wterm/dom`, then re-run the script.

Any build or packaging change that forgets to copy `src/web-ui/content/` into `dist/web-ui/` will break the packaged app even if dev mode still works.

### Output parsing and transport

There are two parallel representations of assistant output:
- raw PTY output for terminal view
- structured conversation data for chat view

`ClaudePtyBridge` maintains the richer block-based `ConversationTurn[]` (with tool use/results) that backs the chat view, derived from the same raw PTY stream that drives the terminal view. Bugs in chat rendering often come from drift between these two representations.

WebSocket clients connect to `/ws`, send `{type: "subscribe", sessionId}`, and receive debounced `ProcessEvent` updates. Output events are throttled to reduce churn, and oversized queues are dropped instead of backpressuring the server.

### Main modules worth knowing

| File | Role |
|------|------|
| `src/cli.ts` | CLI entrypoint and config-related commands |
| `src/server.ts` | Express server, REST API, WebSocket, PWA/service worker endpoints |
| `src/server-session-routes.ts` | Session/resume/history HTTP routes and shared API error helpers |
| `src/process-manager.ts` | PTY session orchestration, input/output routing, permission handling, resume/archive logic |
| `src/structured-session-manager.ts` | Non-PTY runner that spawns `claude -p` and streams JSON output |
| `src/claude-pty-bridge.ts` | PTY output parser for structured chat, permissions, task tracking, and Claude session IDs |
| `src/resume-policy.ts` | Heuristics for mapping Claude history/resume data back onto wand sessions |
| `src/storage.ts` | SQLite persistence and additive schema migration helpers |
| `src/config.ts` | Default config, merge logic, config path resolution |
| `src/session-lifecycle.ts` | Idle/thinking/waiting/archive state machine |
| `src/session-logger.ts` | File-based logs under `~/.wand/sessions/` |
| `src/auth.ts` | Session token creation, validation, and revocation |
| `src/cert.ts` | Self-signed HTTPS certificate generation and loading |
| `src/ws-broadcast.ts` | WebSocket broadcast manager for `/ws` fanout |
| `src/pwa.ts` | PWA manifest and service worker script generation |
| `src/git-worktree.ts` | Per-session git worktree create/merge/cleanup, backs `.wand-worktrees/` |
| `src/upload-routes.ts` | `POST /api/sessions/:id/upload` — multer-backed uploads to `<cwd>/.wand-uploads/` |
| `src/models.ts` | Built-in Claude model list, `claude --version` probing, model cache |
| `src/claude-sdk-runner.ts` | One-shot `runClaudePrint()` via the Agent SDK; resolves the native `claude` binary (musl/glibc aware). Backs quick-commit + prompt-optimizer |
| `src/git-quick-commit.ts` | Git status, quick commit (AI-generated message via `claude-sdk-runner`), tag, and push; wired into `server-session-routes.ts` |
| `src/prompt-optimizer.ts` | One-shot prompt rewrite via `claude-sdk-runner`, exposed by a `server.ts` route |
| `src/env-utils.ts` | Child-process env assembly; minimal whitelist when "inherit env" is off, to keep API keys/tokens out of spawned tools |
| `src/path-repair.ts` | Runtime PATH self-repair so service-installed instances still find `claude` after Node-version/reinstall changes |
| `src/pidfile.ts` | Single-instance pidfile + IPC unix-socket path that back the attach/TUI model |
| `src/npm-update-utils.ts` | npm global self-update + leftover cleanup, shared by server and TUI |
| `src/ensure-node-pty-helper.ts` | Marks the bundled node-pty helper binary executable before server start |
| `src/tui/` | neo-blessed dashboard, IPC client/server (over the pidfile socket), and systemd/launchd service commands (`commands.ts`) behind `wand service:*` |
| `src/middleware/path-safety.ts` | Path-traversal guard for the file browser API |
| `src/middleware/rate-limit.ts` | Login / sensitive endpoint rate limiting |
| `src/pty-text-utils.ts` | ANSI / control-sequence helpers for terminal output processing |
| `src/message-truncator.ts` | Long-message truncation for chat persistence and broadcast |
| `src/avatar.ts` | Pixel-cat avatar generation (赛博虎妞 / 勤劳初二) |
| `src/web-ui/` | Server-rendered HTML + browser assets. Terminal rendering loads `content/vendor/wterm/wterm.bundle.js`, generated by `scripts/bundle-wterm.js` — do not hand-edit |
| `src/types.ts` | Shared contracts across CLI, server, storage, PTY bridge, and UI |

### REST surface

The server exposes login/logout, config, session control, PTY input/resize, file browser, favorites, and quick-path endpoints from `src/server.ts` plus resume/history routes from `src/server-session-routes.ts`. If a frontend feature needs data, look for an existing `/api/*` route there before adding a new abstraction.

## Code Style

### Formatting
- **2-space indentation**, no tabs
- **Double quotes** for all strings
- **Semicolons** at end of statements
- Lines ~100 chars soft limit

### Imports
- Node built-ins: `node:` prefix, named imports where available, `.js` extension for ES modules
  ```ts
  import { existsSync } from "node:fs";
  import { EventEmitter } from "node:events";
  import path from "node:path";
  ```
- Third-party: default imports
  ```ts
  import express from "express";
  ```

### Naming
- Files: lowercase kebab-case (`process-manager.ts`)
- Types/Interfaces: PascalCase (`WandConfig`, `SessionSnapshot`)
- Functions/Variables: camelCase (`ensureConfig`, `appendWindow`)
- Constants: UPPER_SNAKE_CASE (`MAX_SESSIONS`, `OUTPUT_MAX_SIZE`)
- Classes: PascalCase, use `private` keyword for internals

### Functions & Types
- Prefer small top-level functions; add explicit return types on exports
- Use `readonly` on non-mutating properties
- Stateful managers: classes extending `EventEmitter`
- Pure utilities: standalone functions (e.g., `parseMessages`)
- Error handling: catch `unknown`, use a shared `getErrorMessage()` helper
- HTTP errors: `res.status(400).json({ error: "..." })`

### Patterns
- Module-level constants at top of files
- Debounce frequent events (output 16ms, task 100ms)
- `appendWindow()` for memory-bounded output buffers
- Schema migrations: add columns, don't drop tables

## Commit Guidelines

Use short, imperative subjects (e.g., `Add config path validation`). One logical change per commit. For UI changes, include screenshots or screen recordings in PR descriptions.

## Security Notes

- Never commit real passwords or machine-specific paths from `~/.wand/config.json`
- Keep `host` on `127.0.0.1` unless remote access is intentional
- HTTPS is off by default (`https: false`); enable it only when needed and keep `host` restricted
- Document any new command execution permissions added to the config schema
