# Repository Guidelines

## Project Structure & Module Organization
Source lives in `src/` and compiles to `dist/`. The entrypoint is `src/cli.ts`; HTTP and session handling are in `src/server.ts` and `src/process-manager.ts`; config, auth, and shared types live in `src/config.ts`, `src/auth.ts`, and `src/types.ts`. Browser UI markup is generated from `src/web-ui.ts`. Runtime config defaults to `.wand/config.json`.

## Build, Test, and Development Commands
- `npm install`: install Node 18+ dependencies.
- `npm run build`: compile TypeScript from `src/` into `dist/`.
- `npm run check`: run the TypeScript type checker without emitting files.
- `npm run dev`: start the web console directly from `src/cli.ts` with `tsx`.
- `node dist/cli.js init`: create the default config file.
- `node dist/cli.js web`: run the built CLI and start the local web server.

## Coding Style & Naming Conventions
Use TypeScript with strict typing and ES modules. Match the existing style: 2-space indentation, double quotes, semicolons, and named imports from Node built-ins such as `node:process`. Prefer small top-level functions, explicit return types on exported functions, and descriptive camelCase identifiers. Keep filenames lowercase; use short, single-purpose `.ts` modules, following patterns like `process-manager.ts` and `web-ui.ts`.

## Testing Guidelines
There is no test framework configured yet. Until one is added, treat `npm run check` and a manual smoke test as the minimum gate:
- `npm run build`
- `node dist/cli.js init`
- `node dist/cli.js web`

When adding tests, place them beside the feature or under a new `tests/` directory, and name them `*.test.ts`.

## Commit & Pull Request Guidelines
Git history is not available in this workspace, so no repository-specific commit pattern could be verified. Use short, imperative commit subjects such as `Add config path validation` and keep each commit scoped to one change. Pull requests should include a concise description, manual verification steps, linked issues if applicable, and screenshots or screen recordings for UI changes to the web console.

## Security & Configuration Tips
Do not commit real passwords or machine-specific paths from `.wand/config.json`. Keep `host` on `127.0.0.1` unless remote access is intentional, and document any new command execution permissions added to the config schema.
