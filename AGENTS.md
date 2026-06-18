# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the TypeScript source. Key areas are `src/cli.ts` for the CLI entry, `src/server.ts` and `src/server-session-routes.ts` for the HTTP/WebSocket layer, `src/process-manager.ts` and `src/structured-session-manager.ts` for session execution, `src/tui/` for the terminal UI and service commands, `src/web-ui/` for browser assets and SSR helpers, and `src/middleware/` for request guards such as rate limiting and path safety. Build output goes to `dist/`. Utility scripts live in `scripts/`, docs and screenshots in `docs/`. The Android / macOS / iOS WebView shells live in `android/`, `macos/`, and `ios/` — all three are git submodules pointing at `co0ontty/wand-android`, `co0ontty/wand-macos`, and `co0ontty/wand-ios`; run `git submodule update --init` after cloning.

## Build, Test, and Development Commands
Use Node `>=22.5.0`.

- `npm install`: install dependencies.
- `npm run dev`: launch the app from source with `tsx` via `wand web`.
- `npm run dev -- -c /tmp/wand-test/config.json`: run against an isolated config for local testing.
- `npm run check`: run strict TypeScript type-checking without emitting files.
- `npm run build`: bundle vendor terminal/QR assets, compile TypeScript, and copy web content into `dist/`.
- `node dist/cli.js init`: create or refresh config and SQLite files after a build.
- `node dist/cli.js web -c /tmp/wand-dev/config.json`: run the packaged server with disposable QA data.

`wand web` is single-instance per config. If another instance is already live, it attaches to that process instead of starting a second server. In a TTY it renders the neo-blessed TUI dashboard; set `WAND_NO_TUI=1` to force the plain startup banner.

## Validation Guidelines
There is no formal automated test suite yet. Treat `npm run check` as the required baseline before opening a PR, and use `npm run build` for packaging, web UI, vendor asset, or release-flow changes. For UI or session-flow changes, smoke test with an isolated config and verify login, session creation, terminal/chat rendering, permission prompts, resume, and relevant TUI behavior.

For browser QA, prefer `/tmp/wand-dev/config.json` and `/tmp/wand-dev/workspace/` so config, database, sessions, uploads, and worktrees stay isolated from the user's real `~/.wand/` state.

## Coding Style & Naming Conventions
This project uses strict TypeScript with ES modules and `NodeNext`. Follow the existing style: 2-space indentation, semicolons, double quotes, `node:` imports for built-ins, `.js` extensions for local ESM imports, and named exports where practical. Use `kebab-case` for standalone script filenames, `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for module constants, and descriptive `PascalCase` for types/classes. Keep modules focused; place web-only code under `src/web-ui/` and terminal-only code under `src/tui/`.

Prefer small top-level helpers with explicit return types on exports. Keep schema migrations additive: add missing columns or tables without dropping existing user data. Use shared helpers such as `getErrorMessage()` for `unknown` errors and existing bounded-buffer/debounce utilities for high-volume output paths.

## Runtime Architecture Notes
`src/cli.ts` is the only CLI entrypoint. `src/server.ts` wires Express routes, auth/session APIs, file browser APIs, update endpoints, static assets, and the `/ws` WebSocket server. Session-specific HTTP routes live in `src/server-session-routes.ts`.

There are two execution paths:

- PTY runner: `src/process-manager.ts` owns interactive PTY sessions for Claude, Codex, and shells. It handles input/output routing, snapshots, lifecycle state, permissions, resume, archive/idle transitions, and terminal-backed sessions.
- Structured runner: `src/structured-session-manager.ts` owns non-PTY structured runs. It streams JSON output from Claude CLI or the Agent SDK and shares storage/snapshot types with the PTY runner.

When debugging user-visible session behavior, first identify which runner owns the session, then trace the path through `cli.ts`, `server.ts`, the relevant manager, storage, WebSocket events, and `src/web-ui/`.

## Frontend and Assets
The frontend is server-rendered, not a separate SPA build. `src/web-ui/index.ts` assembles the HTML document and inlines generated CSS/JS while also referencing copied static assets under `src/web-ui/content/`.

Do not hand-edit generated vendor bundles under `src/web-ui/content/vendor/`. `scripts/bundle-wterm.js` bundles `@wterm/dom` and copies terminal CSS; `scripts/bundle-qrcode.js` bundles the QR library. `npm run build` runs both bundlers before `tsc`, then copies `src/web-ui/content/` into `dist/web-ui/`. Packaged app behavior depends on that copy step even when dev mode appears to work.

## Android, macOS, and iOS Shells
Android sources live in `android/`; macOS sources live in `macos/`; iOS sources live in `ios/`. All three directories are git submodules — commit and push changes inside the submodule repo first, then bump the submodule pointer in this repo. Android/macOS shells are self-distributed update artifacts served by the Node app.

- Android APKs are discovered from `config.android.apkDir`, usually `~/.wand/android/` or `/tmp/wand-dev/android/`.
- macOS DMGs are discovered from `config.macos.dmgDir`, usually `~/.wand/macos/` or `/tmp/wand-dev/macos/`.
- Artifact filenames must include a semantic version such as `wand-v1.37.0.apk` or `wand-v1.37.0.dmg`.
- Do not change the Android release keystore or macOS signing identity casually; installed clients depend on signature continuity for upgrades.

### Mobile Client UX Reference
For Android mobile UI work, first consult `android/docs/ios-mobile-updates-reference-2026-06-18.md` and mirror the verified iOS interaction model unless there is a platform-specific reason not to. Current Android conventions established from that reference:

- PTY uses a native shell: native top bar, dark embedded terminal WebView, native bottom input. Load the WebView with `embed=terminal&nativeInput=1`, hide the web input panel, and submit PTY input as text followed by `"\r"` with `shortcutKey = "enter_text"`.
- Chat and PTY quick commit share the same `GitChangesButton`, `QuickCommitStore`, and `QuickCommitSheet`; keep the sheet half-expandable with a standard drag handle.
- Appearance mode is persisted as `wand.appearanceMode` with `light`, `dark`, or `system`; settings should expose 明亮 / 黑暗 / 跟随系统 and `WandTheme` should honor it.
- Session-list header follows the iOS inline toolbar pattern: centered segmented scope switcher, left-side overflow/settings menu, right-side create or clear action. Do not reintroduce a large title header.
- Session cards use a left rail and right content column: provider logo top-left, `终端` / `聊天` chip bottom-left, title top-right, path bottom-right aligned vertically with the chip, and one-unit duration chip at top-right.
- Duration chips show one unit only: `刚刚`, `N分钟`, `N小时`, or `N天`.
- Keep Android visual treatment quiet and dense: neutral dark/light surfaces, restrained borders/shadows, compact icon buttons, no heavy circular toolbar cluster.
- Embedded-terminal display issues are usually width/font fit problems, not UTF-8 decoding. In `embed=terminal`, prefer smaller monospace font, tighter padding, Android mono/symbol font fallbacks, and trigger terminal refit after injected CSS changes.

After Android UI changes, validate on device with `cd android && ./gradlew :app:assembleDebug` and `adb install -r -d app/build/outputs/apk/debug/app-debug.apk`, then inspect screenshots for header, cards, PTY terminal, and input alignment.

## State, Security, and Configuration
Do not commit real secrets, local state, or machine-specific paths from `~/.wand/`. Config defaults are defined in `src/config.ts`; `ensureConfig()` merges defaults and rewrites the normalized config, so config-schema changes must update that file carefully. SQLite lives beside the resolved config path and is managed by `src/storage.ts`.

Review changes touching auth, file access, PTY management, upload routes, command execution, update/download routes, or path traversal guards carefully. Keep `host` on `127.0.0.1` unless remote access is intentional, and avoid broadening environment-variable inheritance without a clear reason.

## Commit & Pull Request Guidelines
Recent history favors short, imperative commit subjects in Chinese, for example `修复终端双路写入重叠` or `重构快捷提交并优化会话切换体验`. Keep commits scoped to one logical change. PRs should include user-visible impact, affected areas such as `web-ui`, `tui`, `android`, or `macos`, linked issues when applicable, validation performed, and screenshots or recordings for UI changes.
