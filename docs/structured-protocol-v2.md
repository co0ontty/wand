# Structured Render v2 protocol

The authoritative contract is in the Render submodule at
[`render/docs/structured-protocol-v2.md`](../render/docs/structured-protocol-v2.md).
This is independent of the frozen PTY v1 contract in `render/docs/render-protocol.md`.

## Deployment setting (development gate, not rollout approval)

`structured.processHost` is a deployment config field in `config.json` (not a SQLite
preference). It defaults to `"legacy"`. To route **new CLI runs only** through v2 after
installing a matching `wand-structured-renderd` binary, set:

```json
{ "structured": { "processHost": "rust" } }
```

The daemon accepts the CLI executable, argv, working directory, environment, and optional
single stdin input for the structured run. It does **not** run SDK sessions. The executable is
resolved from `WAND_STRUCTURED_RENDER_BIN`, local `render/target/{release,debug}`,
`<configDir>/bin`, `dist/native/<triple>`, or `PATH` (in that order). Explicit `rust` mode fails
if the binary, protocol, or credential is unavailable; it never retries a possibly-started
command in terminald. Changing back to `"legacy"` affects only future runs. Existing v2
runs continue under v2 ownership until they exit or are explicitly interrupted. **Do not enable
this on the installed service yet:** release staging, provider gates and installed-service
acceptance have not passed. Claude/Grok have only static/mock evidence and no live CLI signoff.
