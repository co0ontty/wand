# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the TypeScript source. Key areas are `src/cli.ts` for the CLI entry, `src/server.ts` and `src/server-session-routes.ts` for the HTTP/WebSocket layer, `src/tui/` for the terminal UI, `src/web-ui/` for browser assets and SSR helpers, and `src/middleware/` for request guards such as rate limiting and path safety. Build output goes to `dist/`. Utility scripts live in `scripts/`, docs and screenshots in `docs/`, and the Android WebView shell in `android/`.

## Build, Test, and Development Commands
Use Node `>=22.5.0`.

- `npm install`: install dependencies.
- `npm run dev`: launch the app from source with `tsx` via `wand web`.
- `npm run dev -- -c /tmp/wand-test/config.json`: run against an isolated config for local testing.
- `npm run check`: run strict TypeScript type-checking without emitting files.
- `npm run build`: bundle vendor terminal assets, compile TypeScript, and copy web content into `dist/`.

## Coding Style & Naming Conventions
This project uses strict TypeScript with ES modules and `NodeNext`. Follow the existing style: 2-space indentation, semicolons, single quotes, and named exports where practical. Use `kebab-case` for standalone script filenames, `camelCase` for functions and variables, and descriptive `PascalCase` only for types/classes. Keep modules focused; place web-only code under `src/web-ui/` and terminal-only code under `src/tui/`.

## Testing Guidelines
There is no formal automated test suite yet. Treat `npm run check` as the required baseline before opening a PR, and verify behavior manually with `npm run dev`. For UI or session-flow changes, test both browser and terminal paths when relevant. If you add automated coverage, keep tests near the feature or under `tests/` and name files `*.test.ts`.

## Commit & Pull Request Guidelines
Recent history favors short, imperative commit subjects in Chinese, for example `修复终端双路写入重叠` or `重构快捷提交并优化会话切换体验`. Keep commits scoped to one change. PRs should include the user-visible impact, affected areas such as `web-ui`, `tui`, or `android`, linked issues when applicable, and screenshots for UI changes.

## Security & Configuration Tips
Do not commit real secrets or local state from `~/.wand/`. Use temporary config paths for development and review changes touching auth, file access, PTY management, or upload routes carefully, since those areas directly affect local-system exposure.
