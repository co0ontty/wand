# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install                # Install dependencies (requires Node.js >= 22.5.0)
npm run check              # Type-check only (tsc --noEmit) — always run after editing TS files
npm run build              # Compile TypeScript and copy web UI static assets to dist/
npm run dev                # Run the web server directly from src/ via tsx (no build needed)
node dist/cli.js init      # Create ~/.wand/config.json and ~/.wand/wand.db (after building)
node dist/cli.js web       # Start the packaged web server (after building)
```

**Smoke test after changes:**
```bash
npm run build && wand init && wand web
```

**Manual release / browser QA:** Follow `RELEASE_CHECKLIST.md`.

## Additional References

- `README.md` contains the end-user quick-start flow (`npm install -g @co0ontty/wand`, `wand init`, `wand web`).
- There is no `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` in this repo.

**No linter or formatter is configured.** Follow the code style conventions below exactly.

## Architecture

`wand` is a Node.js web console for local CLI tools (e.g. Claude Code) with Express REST + WebSocket APIs and server-rendered HTML/CSS/JS. Persistence is SQLite.

### Key modules (`src/`)

| File | Role |
|------|------|
| `cli.ts` | CLI entrypoint; commands: `init`, `web`, `config:*` |
| `server.ts` | Express server, REST API, WebSocket, PWA manifest |
| `process-manager.ts` | PTY session lifecycle, input/output routing, auto-confirm, archiving |
| `claude-pty-bridge.ts` | PTY output parser, permission detection, chat turn tracking |
| `storage.ts` | SQLite persistence (sessions, auth), schema migrations (add columns only) |
| `auth.ts` | In-memory session tokens (12h TTL) |
| `config.ts` | Config loading, defaults, merge |
| `message-parser.ts` | PTY output → structured `ChatMessage[]` |
| `session-logger.ts` | File-based session logging to `~/.wand/sessions/` |
| `session-lifecycle.ts` | Session state machine (initializing → running → idle → archived) |
| `cert.ts` | Self-signed HTTPS certificate generation |
| `types.ts` | All shared TypeScript types and interfaces |
| `web-ui/index.ts` | Server-side HTML renderer; combines CSS + JS |
| `web-ui/content/` | Static assets: `styles.css`, `scripts.js` (must be copied to dist/) |

### Execution modes

`assist`, `agent`, `agent-max`, `default`, `auto-edit`, `full-access`, `native`, `managed` — defined in `types.ts` + `config.ts`. All modes are policy profiles over the same PTY-backed execution model. `full-access` auto-confirms permission prompts; `native` is reserved. Trust current code over older comments — the JSON-native execution path was removed; everything goes through `node-pty` now.

### Persistence model

Config: `~/.wand/config.json` (default path in `config.ts`). Database: `~/.wand/wand.db`. `ensureConfig()` always rewrites the config with defaults merged, so config-schema changes must update `config.ts`. SQLite schema migrations add columns only — never drop tables.

### Server / UI boundary

The UI is not a separate SPA build pipeline. `src/server.ts` calls `renderApp()` from `src/web-ui/index.ts`, which assembles one HTML document from inlined CSS and JS. When changing frontend behavior, check both:
- `src/web-ui/index.ts`, `styles.ts`, `scripts.ts` (server-side assembly)
- `src/web-ui/content/scripts.js`, `content/styles.css` (browser runtime)

The `npm run build` step must copy `src/web-ui/content/` into `dist/web-ui/`.

### Output parsing

Two parallel representations of assistant output:
- Raw PTY output on the session snapshot (terminal view)
- Structured `ConversationTurn[]` (chat view)

`src/message-parser.ts` strips ANSI sequences and filters CLI noise to derive `ChatMessage[]`. `ClaudePtyBridge` tracks richer `ConversationTurn[]`. If chat rendering looks wrong, inspect both.

### WebSocket protocol

Clients connect to `/ws`, send `{type: "subscribe", sessionId}`, and receive `ProcessEvent` objects. Output is debounced at 50ms. Backpressure drops messages when the queue exceeds 500.

### REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/login` | No | Login with password |
| POST | `/api/logout` | No | Clear session cookie |
| POST | `/api/set-password` | Yes | Update password |
| GET | `/api/config` | Yes | Get public config |
| GET | `/api/sessions` | Yes | List all sessions |
| POST | `/api/commands` | Yes | Start new command |
| GET | `/api/sessions/:id` | Yes | Get session details |
| POST | `/api/sessions/:id/input` | Yes | Send input |
| POST | `/api/sessions/:id/resize` | Yes | Resize PTY |
| DELETE | `/api/sessions/:id` | Yes | Stop & delete session |
| GET | `/api/path-suggestions` | Yes | Path autocomplete |
| GET | `/api/directory` | Yes | Directory listing with git status |
| GET | `/api/file-preview` | Yes | File preview |
| GET | `/api/folders` | Yes | Folder picker |
| GET/POST/DELETE | `/api/favorite-paths` | Yes | Manage favorites |
| GET | `/api/quick-paths` | Yes | Common paths |

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
- Debounce frequent events (output 50ms, task 100ms)
- `appendWindow()` for memory-bounded output buffers
- Schema migrations: add columns, don't drop tables

## Commit Guidelines

Use short, imperative subjects (e.g., `Add config path validation`). One logical change per commit. For UI changes, include screenshots or screen recordings in PR descriptions.

## Security Notes

- Never commit real passwords or machine-specific paths from `~/.wand/config.json`
- Keep `host` on `127.0.0.1` unless remote access is intentional
- Document any new command execution permissions added to the config schema
