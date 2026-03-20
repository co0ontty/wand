# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install                # Install dependencies (Node 18+)
npm run build              # Compile TypeScript to dist/
npm run check              # Type check without emitting
npm run dev                # Run web command directly with tsx
node dist/cli.js init      # Create default config at .wand/config.json
node dist/cli.js web       # Start the web console server
```

## Architecture Overview

`wand-cli` is a Node.js tool that exposes a web console for operating local CLI tools from a browser. It uses Express for HTTP, `node-pty` for PTY sessions, `xterm.js` for terminal rendering, and `node:sqlite` for persistence.

**Module responsibilities:**
- `cli.ts` — CLI entrypoint; parses commands (`init`, `web`, `config:*`)
- `server.ts` — Express server with REST API for sessions, auth, and commands
- `process-manager.ts` — Manages PTY sessions; handles spawn, input, stop, output buffering, and auto-confirm logic
- `storage.ts` — SQLite persistence for sessions and auth tokens; handles schema migrations
- `config.ts` — Config loading with defaults and merge logic
- `auth.ts` — In-memory session token store with 12-hour TTL
- `types.ts` — Shared TypeScript types
- `web-ui.ts` — Generates the browser HTML UI

**Execution modes:** `auto-edit`, `default`, `full-access`. These are passed to child processes via environment variables (`WAND_MODE`, `WAND_AUTO_CONFIRM`, `WAND_AUTO_EDIT`). In `full-access` mode, the process manager auto-confirms prompts by detecting confirmation patterns and sending appropriate responses.

**Config:** Stored at `.wand/config.json`. Includes host/port, password, shell, default working directory, startup commands, allowed command prefixes, and command presets for the web UI.

**Session persistence:** Sessions are stored in SQLite at `.wand/wand.db`. The storage module handles schema migrations for new columns (e.g., `archived`, `archived_at`, `claude_session_id`). Session output is truncated to ~120KB to avoid memory issues.

**Claude session tracking:** When running Claude Code, the process manager extracts the `session_id` from JSON output and stores it as `claudeSessionId`. This enables the "Resume" button in the UI which runs `claude --resume <session_id>`.

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

## Code Style

TypeScript with ES modules, 2-space indentation, double quotes, semicolons. Use named imports from Node built-ins with `node:` prefix (e.g., `node:process`). Prefer small top-level functions with explicit return types on exports.

## Web UI Design

`web-ui.ts` generates a single HTML file with embedded CSS/JS. The design uses warm, earthy tones with cream/beige backgrounds (`#f6f1e8`) and burnt orange accent (`#c5653d`). Typography uses Inter for UI text and Geist Mono for code. CSS variables define the full theme in `:root`. The UI includes a sidebar drawer for session history, floating quick-input controls for mobile, and session resume functionality for Claude sessions.

**Input box behavior:** The "Send to session" textarea maintains per-session draft state in `state.drafts`. Character input uses natural browser behavior with async state sync. Enter/Send transmits the full line to PTY and clears the draft.