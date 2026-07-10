# agent.md

This file is the short operational guide for coding agents working in this
repository. Read `CLAUDE.md` when a task needs the detailed architecture,
release, or native-client notes; it is the long-form source of truth.

## Project Snapshot

`wand` is a Node.js web console for local CLI tools such as Claude Code and
Codex. Express and WebSocket serve the browser UI, sessions run through PTYs or
structured non-PTY processes, and config, auth, and session state are persisted
under the directory containing the active Wand config file.

- Runtime: Node.js `>=22.5.0`, TypeScript, ESM.
- Default config: `~/.wand/config.json`.
- Default SQLite database: `~/.wand/wand.db`.
- Default session artifacts: `~/.wand/sessions/<sessionId>/`.
- `-c /path/to/config.json` isolates all three under that config directory.

The native clients are git submodules:

| Path | Repository |
| --- | --- |
| `android/` | `co0ontty/wand-android` |
| `ios/` | `co0ontty/wand-ios` |
| `macos/` | `co0ontty/wand-macos` |

After cloning, run `git submodule update --init` before building a native
client.

## Common Commands

```bash
npm install
npm run check
npm run build
npm test
npm run dev -- -c /tmp/wand-test/config.json
```

Useful targeted commands:

```bash
node --test --import tsx tests/password-manager.test.ts
node --test --import tsx --test-name-pattern "vaults" tests/password-manager.test.ts
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```

`npm run check` bundles browser code, regenerates embedded web assets, and
type-checks the server and browser TypeScript projects. `npm run build` also
rebundles vendor assets, compiles the packaged application, copies/minifies web
content into `dist/`, and stamps `dist/build-info.json`.

There is no lint or formatter script. Tests use `node:test` via `tsx` and live
under `tests/*.test.ts`.

## Runtime Map

Start with these paths when debugging:

```text
CLI/startup:       src/cli.ts -> src/server.ts
PTY sessions:      src/server.ts -> src/process-manager.ts
Claude PTY chat:   src/process-manager.ts -> src/claude-pty-bridge.ts
Structured runs:   src/server-session-routes.ts -> src/structured-session-manager.ts
Browser updates:   src/ws-broadcast.ts -> src/web-ui/browser/*
```

Main ownership boundaries:

| Area | Files |
| --- | --- |
| CLI, single-instance attach, and config/service commands | `src/cli.ts`, `src/pidfile.ts`, `src/tui/*` |
| Express composition, general REST routes, static UI, WebSocket | `src/server.ts` |
| Session, resume, history, model, and quick-commit routes | `src/server-session-routes.ts` |
| PTY-backed sessions | `src/process-manager.ts` |
| Structured non-PTY sessions | `src/structured-session-manager.ts` |
| Claude PTY parsing and structured turns | `src/claude-pty-bridge.ts` |
| Session/resume matching heuristics | `src/resume-policy.ts` |
| SQLite persistence and additive migrations | `src/storage.ts` |
| File-based session artifacts | `src/session-logger.ts` |
| Lifecycle and archive transitions | `src/process-manager.ts`, `src/structured-session-manager.ts` |
| WebSocket fanout | `src/ws-broadcast.ts` |
| Shared contracts | `src/types.ts` |

## Session Runners and Resume

There are two independent execution paths:

- PTY runner (`src/process-manager.ts`): interactive Claude, Codex, and shell
  sessions. It owns terminal I/O, permission prompts, lifecycle, persistence,
  archive behavior, and PTY resume/recovery.
- Structured runner (`src/structured-session-manager.ts`): streamed non-PTY
  sessions. Claude can use `claude -p --output-format stream-json` or the Agent
  SDK; Codex uses `codex exec --json`. The manager normalizes provider events
  into shared `ConversationTurn` and tool blocks for the browser/native clients.

Always establish which runner owns a session before changing behavior. They
share types and storage, but fixes in one path do not automatically affect the
other. Structured runs are non-interactive; tool permission escalation is not
available there.

`SessionSnapshot.claudeSessionId` stores the native resume identifier for both
providers: a Claude session ID or a Codex thread ID. Recovery spans
`process-manager.ts`, `structured-session-manager.ts`, `resume-policy.ts`,
`storage.ts`, Claude project JSONL under `~/.claude/projects/`, and Codex rollout
history. Treat session-ID matching conservatively: time-window fallback should
only bind an unambiguous candidate.

## Web UI and Generated Files

The frontend is not a separate SPA. `src/web-ui/index.ts` renders one HTML shell
and the server inlines generated assets.

Edit source files here:

- `src/web-ui/browser/*.ts` (entry: `main.ts`)
- `src/web-ui/content/styles.css`
- source scripts under `scripts/`

Do not hand-edit generated outputs:

- `src/web-ui/content/scripts.js`
- `src/web-ui/embedded-assets.ts`
- `src/web-ui/content/vendor/wterm/*`
- `src/web-ui/content/vendor/qrcode/*`
- files under `dist/`

Generation flow:

```text
src/web-ui/browser/*.ts
  -> scripts/bundle-browser.js
  -> src/web-ui/content/scripts.js
  -> scripts/generate-web-assets.js
  -> src/web-ui/embedded-assets.ts
```

`npm run dev` and `npm run check` rebuild browser scripts and embedded assets,
but do not rebundle wterm or qrcode. `npm run build` runs the full vendor and app
asset pipeline. Generated tracked files may change after these commands; keep
them synchronized with their sources rather than editing them directly.

Raw PTY output and structured chat turns are parallel representations of the
same session. For rendering bugs, inspect the provider parser/event normalizer,
the WebSocket payload, and `src/web-ui/browser/chat-render.ts` before assuming
the problem is CSS-only.

## State, Config, and Files

- Config defaults and normalization live in `src/config.ts`.
  `loadConfigWithStorage()` merges defaults and rewrites the normalized config.
- SQLite is resolved beside the active config file. Migrations must be additive:
  add columns or tables without discarding existing user data.
- Session logs and native stream artifacts are stored in
  `<configDir>/sessions/<sessionId>/`.
- Uploads are written inside the session working directory at `.wand-uploads/`.
- Git worktree sessions use `.wand-worktrees/` at the repository root.
- Distribution files default to `<configDir>/android/` and
  `<configDir>/macos/`; update endpoints refresh those config fields from disk.

If persisted state looks inconsistent, inspect both `src/storage.ts` and
`src/session-logger.ts`; they are complementary.

## Browser Extension

The Manifest V3 password-manager extension lives in `browser-extension/`, and
its backend domain logic lives in `src/password-manager.ts` plus the
`/api/browser-extension/*` routes in `src/server.ts`. Read
`docs/browser-extension.md` before changing authentication, vaults, TOTP,
autofill, or passkey behavior.

The extension receives an app token from `POST /api/login` when
`client: "browser-extension"`. Changing the Wand password invalidates existing
extension tokens. Run `tests/password-manager.test.ts` for backend changes.

## Native Client Workflow

When changing Android, iOS, or macOS code:

1. Commit and push inside the submodule repository.
2. Return to the root repository.
3. Commit the updated submodule pointer.

Do not leave the root pointing at an unpushed submodule commit; CI cannot fetch
it. Avoid changing unrelated dirty submodules.

Android smoke build:

```bash
cd android
./gradlew :app:assembleDebug
adb install -r -d app/build/outputs/apk/debug/app-debug.apk
```

macOS and iOS builds are version-argument driven:

```bash
cd macos && ./build.sh <version>
cd ios && ./build.sh <version>
```

For mobile UI changes, follow the cross-platform interaction notes in
`CLAUDE.md` and visually verify the affected screen on a real device or
simulator.

## Releases and Updates

Formal releases are tag-driven. Push a `v*` tag; GitHub Actions builds and
publishes the applicable artifacts.

Relevant workflows:

- `.github/workflows/npm-release.yml`
- `.github/workflows/android-release.yml`
- `.github/workflows/macos-release.yml`
- `.github/workflows/ios-build.yml`
- `.github/workflows/release-notes.yml`
- `.github/workflows/beta-branch.yml`
- `.github/workflows/cleanup-old-releases.yml`

`release-notes.yml` is the sole owner of the GitHub Release body. Client build
workflows must not also write or append it. `publish.sh` is for local builds and
local APK/DMG deployment only; it does not publish npm packages.

## Style and Safety

- Use 2-space indentation, double quotes, and semicolons.
- Use `node:` imports for Node built-ins and `.js` extensions for ESM imports.
- Prefer small top-level helpers and explicit return types on exports.
- Catch `unknown`; use `getErrorMessage()` from `src/error-utils.ts`.
- Keep memory-heavy output bounded and debounce high-frequency events.
- Preserve unrelated user changes in the root and all submodules.
- Never commit real config secrets, passwords, app tokens, private keys, or
  machine-local credentials.
- Keep `host` on `127.0.0.1` unless remote access is intentional.
- Document any new command-execution permission exposed through config or API.

## Validation

For TypeScript, backend, or web UI changes, normally run:

```bash
npm run check
npm test
npm run build
```

For narrow logic, run the relevant test file while iterating, then use the full
suite before handoff. For user-visible session or UI behavior, start an isolated
packaged server:

```bash
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```

Verify the affected flows: login, session creation, provider/model selection,
terminal and structured chat, permission prompts, reconnect/resume, uploads,
quick commit, and extension/native behavior when the task touches those areas.
