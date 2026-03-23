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
npm run test               # Pre-release browser tests (requires Puppeteer)
```

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
- `server.ts` — Express server with REST API for sessions, auth, and commands
- `process-manager.ts` — Manages PTY sessions; handles spawn, input, stop, output buffering, and auto-confirm logic
- `storage.ts` — SQLite persistence for sessions and auth tokens; handles schema migrations
- `config.ts` — Config loading with defaults and merge logic
- `auth.ts` — In-memory session token store with 12-hour TTL
- `cert.ts` — HTTPS certificate generation
- `types.ts` — Shared TypeScript types
- `web-ui.ts` — Generates the browser HTML UI

**Execution modes:** `auto-edit`, `default`, `full-access`, `native`. Passed to child processes via environment variables (`WAND_MODE`, `WAND_AUTO_CONFIRM`, `WAND_AUTO_EDIT`). In `full-access` mode, the process manager auto-confirms prompts by detecting confirmation patterns and sending appropriate responses. In `native` mode, Claude runs with `--print` flag to return structured code output instead of interactive terminal.

**Config:** Stored at `.wand/config.json` (or `~/.wand/config.json` by default). Includes host/port, password, shell, default working directory, startup commands, allowed command prefixes, and command presets for the web UI.

**Session persistence:** Sessions are stored in SQLite at `.wand/wand.db`. Schema migrations add columns as needed (e.g., `archived`, `archived_at`, `claude_session_id`). Session output is truncated to ~120KB.

**Claude session tracking:** When running Claude Code, the process manager extracts `session_id` from JSON output and stores it as `claudeSessionId`. This enables the "Resume" button in the UI which runs `claude --resume <session_id>`.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Serve web UI HTML |
| POST | `/api/login` | Password auth, sets session cookie |
| POST | `/api/logout` | Revoke session |
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

See `OPTIMIZATION_PLAN.md` for the full roadmap. Current focus:

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
