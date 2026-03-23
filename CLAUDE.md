# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install                # Install dependencies (Node.js >= 22.5.0)
npm run build              # Compile TypeScript to dist/
npm run check              # Type check without emitting
npm run dev                # Run web command directly with tsx
node dist/cli.js init      # Create default config at ~/.wand/config.json
node dist/cli.js web       # Start the web console server
```

**Requirements:**
- Node.js >= 22.5.0 (uses `node:sqlite`)
- OpenSSL or Node.js crypto for HTTPS certificate generation

**Smoke test after changes:**
```bash
npm run build && node dist/cli.js init && node dist/cli.js web
```

**Testing:**

```bash
npm run check              # Type check
npm run test               # Pre-release tests (scripts/pre-release-test.js)
npm run test:e2e           # Playwright E2E tests (starts server automatically)
npm run test:e2e:ui        # Playwright tests with UI inspector
npm run test:e2e:debug     # Playwright tests in debug mode
npm run test:e2e:report    # Show last Playwright test report
```

Playwright tests are in `tests/` and cover auth, sessions, chat, WebSocket, file explorer, and UI interactions. The test config (`playwright.config.ts`) auto-starts the web server and uses self-signed HTTPS certificates.

**Pre-release Checklist:**

⚠️ **IMPORTANT:** Before any release, all tests must pass and manual browser testing is required. See `RELEASE_CHECKLIST.md` for the full checklist.

Required manual tests:
1. Page loads without errors
2. Login works correctly
3. New session creation works
4. Chat mode displays messages bottom-to-top
5. No message flickering during streaming
6. Keyboard shortcuts work (Ctrl+C, Ctrl+D, etc.)
7. Floating control panel works
8. Session resume works (if claudeSessionId exists)
9. Draft persistence works after refresh

## Architecture Overview

`wand-cli` is a Node.js tool that exposes a web console for operating local CLI tools from a browser. It uses Express for HTTP, `node-pty` for PTY sessions, `xterm.js` for terminal rendering, and `node:sqlite` for persistence.

**Module responsibilities:**
- `cli.ts` — CLI entrypoint; parses commands (`init`, `web`, `config:*`)
- `server.ts` — Express server with REST API, WebSocket, and PWA support
- `process-manager.ts` — Manages PTY sessions; handles spawn, input, stop, output buffering, and auto-confirm logic
- `storage.ts` — SQLite persistence for sessions and auth tokens; handles schema migrations
- `config.ts` — Config loading with defaults and merge logic
- `auth.ts` — In-memory session token store with 12-hour TTL
- `cert.ts` — HTTPS certificate generation
- `types.ts` — Shared TypeScript types
- `message-parser.ts` — Parses PTY output into structured chat messages (strips ANSI, filters noise)
- `web-ui.ts` — Generates the browser HTML UI

**Execution modes:** `auto-edit`, `default`, `full-access`, `native`. Passed to child processes via environment variables (`WAND_MODE`, `WAND_AUTO_CONFIRM`, `WAND_AUTO_EDIT`).
- `full-access`: Auto-confirms prompts by detecting confirmation patterns and sending appropriate responses. Adds `--permission-mode acceptEdits` for Claude commands.
- `native`: Uses `claude -p --output-format stream-json` for structured JSON output instead of interactive PTY. Parses NDJSON events into `ConversationTurn` objects for the chat UI. No PTY involved — uses Node's `spawn` directly.

**Config:** Stored at `.wand/config.json` (or `~/.wand/config.json` by default). Includes host/port, password, shell, default working directory, startup commands, allowed command prefixes, and command presets for the web UI.

**Session persistence:** Sessions are stored in SQLite at `.wand/wand.db`. Schema migrations add columns as needed (e.g., `archived`, `archived_at`, `claude_session_id`). Session output is truncated to ~120KB.

**Claude session tracking:** When running Claude Code, the process manager extracts `session_id` from JSON output and stores it as `claudeSessionId`. This enables the "Resume" button in the UI which runs `claude --resume <session_id>`.

**WebSocket protocol:** Real-time updates are pushed via WebSocket at `/ws`. Clients send `{type: "subscribe", sessionId}` to receive updates. Server broadcasts `ProcessEvent` objects with types: `started`, `output`, `ended`, `status`. Output events are debounced (50ms) to reduce flicker. Backpressure control drops messages if client queue exceeds 500.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Serve web UI HTML |
| GET | `/manifest.json` | PWA manifest |
| GET | `/sw.js` | Service worker for offline support |
| POST | `/api/login` | Password auth, sets session cookie |
| POST | `/api/logout` | Revoke session |
| POST | `/api/set-password` | Set new password (requires auth) |
| GET | `/api/config` | Get config (presets, defaults) |
| GET | `/api/sessions` | List all session snapshots |
| GET | `/api/sessions/:id` | Get single session with output |
| POST | `/api/commands` | Start new PTY session |
| POST | `/api/sessions/:id/input` | Send input to PTY |
| POST | `/api/sessions/:id/resize` | Resize terminal (cols, rows) |
| POST | `/api/sessions/:id/stop` | Kill PTY session |
| DELETE | `/api/sessions/:id` | Delete session from storage |
| GET | `/api/path-suggestions?q=` | Directory path autocomplete |
| GET | `/api/directory` | Directory file listing (files tab) |
| GET | `/api/folders?q=` | Folder picker with parent navigation |
| GET | `/api/quick-paths` | Common paths (home, temp, cwd) |
| GET/POST/DELETE | `/api/favorite-paths` | User's saved favorite paths |
| GET/POST | `/api/recent-paths` | Recently used paths (max 10) |
| GET | `/api/validate-path?path=` | Validate path exists and is readable |
| GET | `/api/file-search?q=&cwd=` | Search files by name (recursive) |
| GET | `/ws` | WebSocket for real-time session updates |

## Code Style

TypeScript with ES modules, 2-space indentation, double quotes, semicolons. Use named imports from Node built-ins with `node:` prefix (e.g., `node:process`). Prefer small top-level functions with explicit return types on exports. Filenames are lowercase, single-purpose modules.

## Web UI Design

`web-ui.ts` generates a single HTML file with embedded CSS/JS. The design uses warm, earthy tones with cream/beige backgrounds (`#f6f1e8`) and burnt orange accent (`#c5653d`). Typography uses Inter for UI text and Geist Mono for code. CSS variables define the full theme in `:root`.

**UI modes:** The UI supports Terminal mode (xterm.js rendering) and Chat mode (Markdown message bubbles). A sidebar drawer provides session history. Floating quick-input controls are available for mobile.

**Input behavior:** The textarea maintains per-session draft state in `state.drafts`. Enter sends; Shift+Enter inserts a newline.

**Recent additions:**
- Deep thinking card: Shows Claude's thinking state with rotating icon and pulse animation
- Prompt suggestion card: Displays Claude Code "Try..." suggestions with pulsing effect
- Improved ANSI escape sequence stripping for cleaner message parsing
- Debounced chat rendering to reduce flicker during rapid output updates

## Optimization Roadmap

Current focus:

- **Phase 1** (mostly complete): Chat-style interface, Markdown rendering, code syntax highlighting, copy buttons
- **Phase 2** (in progress): File browser, model selector, code review panel
- **Phase 3** (planned): Project management, session management
- **Phase 4** (planned): Settings panel, themes, notifications, MCP/LSP config

## Commit Guidelines

Use short, imperative commit subjects (e.g., `Add config path validation`). Keep each commit scoped to one change. For UI changes, include screenshots or screen recordings in the PR description.

## Security Notes

- Never commit real passwords or machine-specific paths from `~/.wand/config.json`
- Keep `host` on `127.0.0.1` unless remote access is intentional
- Document any new command execution permissions added to the config schema
