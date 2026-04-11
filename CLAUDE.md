# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install                # Install dependencies (requires Node.js >= 22.5.0)
npm run check              # Type-check only (tsc --noEmit)
npm run build              # Compile TypeScript and copy src/web-ui/content into dist/web-ui/
npm run dev                # Run the CLI entrypoint directly from src/ via tsx
node dist/cli.js init      # Create or refresh config + SQLite files
node dist/cli.js web       # Start the packaged web server from dist/
wand config:path           # Print resolved config path
wand config:show           # Print merged runtime config
wand config:set host 0.0.0.0  # Update a simple config value
```

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

**IMPORTANT: Do NOT touch port 8443.** That is the live production instance. Never kill, restart, or bind to port 8443 during development or testing.

**Testing server (use this for all QA / smoke tests):**
```bash
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```
The test config at `/tmp/wand-dev/config.json` should use port **9443** (edit the `port` field after first `init`). Working directory for test tasks: `/tmp/wand-dev/workspace/`. This keeps everything isolated from the production instance on 8443.

**Manual browser QA / release verification:** Follow `RELEASE_CHECKLIST.md`.

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

## Android APK Build & Deployment

项目包含一个 Android WebView 壳应用，源码在 `android/` 目录。

**编译 APK：**
```bash
cd android
# 使用最新 git tag 作为版本号，加 debug 时间戳后缀
./gradlew assembleDebug \
  -PAPP_VERSION_NAME="$(git describe --tags --abbrev=0 | sed 's/^v//')-debug.$(date +%m%d%H%M)" \
  -PAPP_VERSION_CODE=11302
```
产物：`android/app/build/outputs/apk/debug/app-debug.apk`

**部署 APK 供下载：**

服务端通过 `config.android.apkDir`（相对于 config 目录）查找 APK 文件，按修改时间取最新的。

| 环境 | Config 目录 | APK 目录 | 端口 |
|------|------------|---------|------|
| 生产 | `~/.wand/` | `~/.wand/android/` | 8443 |
| 开发 | `/tmp/wand-dev/` | `/tmp/wand-dev/android/` | 9443 |

**两个目录都要放！** 用户连的是生产服务器（8443），所以 APK 必须放到 `~/.wand/android/`。开发目录只是隔离测试用。

```bash
# 编译后同时部署到两个目录
cp android/app/build/outputs/apk/debug/app-debug.apk ~/.wand/android/wand-v<VERSION>.apk
cp android/app/build/outputs/apk/debug/app-debug.apk /tmp/wand-dev/android/wand-<VERSION>.apk
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

## Additional References

- `README.md` contains the end-user install/start flow (`npm install -g @co0ontty/wand`, `wand init`, `wand web`).
- There is no `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` in this repo.

## Architecture

`wand` is a Node.js web console for local CLI tools such as Claude Code. The app starts from a CLI command, serves a browser UI over Express + WebSocket, launches commands inside PTYs with `node-pty`, and persists session/auth state in SQLite under `~/.wand/`.

### Runtime flow

1. `src/cli.ts` is the only entrypoint. It parses `wand init`, `wand web`, and `config:*`, resolves `-c/--config`, and always ensures config + SQLite files exist before startup.
2. `src/server.ts` wires the whole application together: Express routes, auth/session APIs, file browser APIs, update endpoints, static assets, and the `/ws` WebSocket server.
3. `ProcessManager` in `src/process-manager.ts` is the core runtime owner for PTY-backed sessions. It launches commands, persists snapshots, handles resume/auto-recovery, watches for confirmation prompts, and bridges UI input back into the process.
4. `ClaudePtyBridge` in `src/claude-pty-bridge.ts` parses Claude PTY output into structured conversation turns, permission events, task/tool updates, and captured Claude session IDs while preserving raw terminal output in parallel.
5. The browser UI subscribes over `/ws` and renders the same session in two synchronized representations: terminal output and structured chat history.

When debugging a user-visible session bug, trace the full chain: `cli.ts` -> `server.ts` -> `process-manager.ts` -> `claude-pty-bridge.ts` -> web UI.

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

Any build or packaging change that forgets to copy `src/web-ui/content/` into `dist/web-ui/` will break the packaged app even if dev mode still works.

### Output parsing and transport

There are two parallel representations of assistant output:
- raw PTY output for terminal view
- structured conversation data for chat view

`src/message-parser.ts` derives simple `ChatMessage[]` from terminal text, while `ClaudePtyBridge` maintains richer block-based `ConversationTurn[]` with tool use/results. Bugs in chat rendering often come from drift between these two representations.

WebSocket clients connect to `/ws`, send `{type: "subscribe", sessionId}`, and receive debounced `ProcessEvent` updates. Output events are throttled to reduce churn, and oversized queues are dropped instead of backpressuring the server.

### Main modules worth knowing

| File | Role |
|------|------|
| `src/cli.ts` | CLI entrypoint and config-related commands |
| `src/server.ts` | Express server, REST API, WebSocket, PWA/service worker endpoints |
| `src/server-session-routes.ts` | Session/resume/history HTTP routes and shared API error helpers |
| `src/process-manager.ts` | PTY session orchestration, input/output routing, permission handling, resume/archive logic |
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
| `src/web-ui/` | Server-rendered HTML plus browser assets |
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
