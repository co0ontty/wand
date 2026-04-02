# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install                # Install dependencies (requires Node.js >= 22.5.0)
npm run check              # Type-check only (tsc --noEmit); run after editing TS files
npm run build              # Compile TypeScript and copy src/web-ui/content into dist/web-ui/
npm run dev                # Run the CLI entrypoint directly from src/ via tsx
node dist/cli.js init      # Create or refresh ~/.wand/config.json and ~/.wand/wand.db
node dist/cli.js web       # Start the packaged web server from dist/
wand config:show           # Print merged runtime config
wand config:path           # Print resolved config path
wand config:set host 0.0.0.0  # Update a simple config value
```

There is no test suite yet, and no linter or formatter is configured.

**Smoke test after changes:**
```bash
npm run build && wand init && wand web
```

**Manual release / browser QA:** Follow `RELEASE_CHECKLIST.md`.

## Additional References

- `README.md` contains the end-user install/start flow (`npm install -g @co0ontty/wand`, `wand init`, `wand web`).
- There is no `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` in this repo.

## Architecture

`wand` is a Node.js web console for local CLI tools such as Claude Code. The app starts from a CLI command, serves a browser UI over Express + WebSocket, launches commands inside PTYs with `node-pty`, and persists session/auth state in SQLite under `~/.wand/`.

### Runtime flow

1. `src/cli.ts` parses `wand init`, `wand web`, and `config:*`, resolves the config path, and ensures config + database files exist before the server starts.
2. `src/server.ts` creates the Express app, auth/session endpoints, file browser endpoints, and `/ws` fanout for live session updates.
3. `ProcessManager` in `src/process-manager.ts` owns PTY-backed command sessions, writes input, emits `ProcessEvent`s, tracks permission prompts, and coordinates resume/archive behavior.
4. `ClaudePtyBridge` in `src/claude-pty-bridge.ts` turns raw PTY output into structured chat events, permission events, task updates, and captured Claude session IDs.
5. The browser subscribes over `/ws` and renders the same session in two forms: raw terminal output and structured chat turns.

### State and persistence

- Config lives in `~/.wand/config.json`; `ensureConfig()` in `src/config.ts` always rewrites the file with defaults merged in, so config schema changes must be reflected there.
- SQLite lives in `~/.wand/wand.db`; `src/storage.ts` stores auth sessions, command sessions, Claude resume metadata, and serialized `ConversationTurn[]`.
- Schema migration policy is additive only: `ensureCommandSessionSchema()` adds missing columns and never drops old ones.
- `src/session-logger.ts` also writes per-session artifacts under `~/.wand/sessions/<sessionId>/` for PTY logs and structured message snapshots.

### Session model

A session is more than a child process. It combines:
- PTY state and raw buffered terminal output
- structured `ConversationTurn[]` for chat mode
- Claude session ID detection for `--resume`
- lifecycle/archival state from `src/session-lifecycle.ts`
- permission escalation metadata and auto-approval behavior by execution mode

If session recovery, resume buttons, or chat history look wrong, inspect `src/process-manager.ts`, `src/claude-pty-bridge.ts`, and `src/storage.ts` together.

### UI structure

The frontend is not a separate SPA build. `src/server.ts` serves one HTML document built by `renderApp()` in `src/web-ui/index.ts`, which inlines generated CSS and JavaScript.

When changing frontend behavior, check both layers:
- `src/web-ui/index.ts`, `styles.ts`, `scripts.ts` for server-assembled inline assets
- `src/web-ui/content/styles.css` and `src/web-ui/content/scripts.js` for copied browser assets used from `dist/`

Any build change that forgets to copy `src/web-ui/content/` will break the packaged app.

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
| `src/process-manager.ts` | PTY session orchestration, input/output routing, permission handling, resume/archive logic |
| `src/claude-pty-bridge.ts` | PTY output parser for structured chat, permissions, task tracking, and Claude session IDs |
| `src/storage.ts` | SQLite persistence and additive schema migration helpers |
| `src/config.ts` | Default config, merge logic, config path resolution |
| `src/session-lifecycle.ts` | Idle/thinking/waiting/archive state machine |
| `src/session-logger.ts` | File-based logs under `~/.wand/sessions/` |
| `src/web-ui/` | Server-rendered HTML plus browser assets |
| `src/types.ts` | Shared contracts across CLI, server, storage, PTY bridge, and UI |

### REST surface

The server exposes login/logout, config, session control, PTY input/resize, file browser, favorites, and quick-path endpoints from `src/server.ts`. If a frontend feature needs data, look for an existing `/api/*` route there before adding a new abstraction.

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
- Document any new command execution permissions added to the config schema
