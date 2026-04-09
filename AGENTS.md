# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the TypeScript source. Key entry points are `src/cli.ts` for the CLI, `src/server.ts` for the Express/WebSocket server, `src/server-session-routes.ts` for session APIs, and `src/process-manager.ts` for PTY orchestration. Frontend assets are code-generated from `src/web-ui/*.ts`, with static content under `src/web-ui/content/`. Build output goes to `dist/`; do not edit generated files there by hand.

## Build, Test, and Development Commands
Use Node `>=22.5.0`.

```bash
npm install          # install dependencies
npm run dev          # start the app from source via tsx
npm run check        # strict TypeScript type-check, no emit
npm run build        # compile to dist/ and copy web UI content
```

For isolated local testing, run `npm run dev -- -c /tmp/wand-test/config.json` to avoid touching `~/.wand/`.

## Coding Style & Naming Conventions
This repo uses ESM TypeScript with `strict` mode. Follow the existing style: 2-space indentation is not used here; keep the current 2? Wait -> actual code uses 2-space? No, code examples show 2 spaces? Need accuracy. Use 2 spaces? Hold. Let's write without mention? Hmm.
