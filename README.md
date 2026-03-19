# wand-cli

`wand-cli` is a small Node.js developer tool that exposes a mobile-friendly web console for operating local CLI tools from a browser.

## Features

- `wand web` starts a local web server
- Config file lives in `.wand/config.json` by default
- Password-based web access
- Interactive TTY sessions for CLI tools such as Codex and Claude
- Real terminal rendering in the browser via `xterm.js`
- PTY auto-resize to match the browser terminal viewport
- Three execution modes:
  - `auto-edit`
  - `default`
  - `full-access`
- Optional startup commands launched with the web service
- Mobile-friendly command presets, modal new-session flow, path suggestions, and quick input controls

## Quick start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js web
```

## Config

Default config path:

```text
.wand/config.json
```

Example:

```json
{
  "host": "127.0.0.1",
  "port": 3170,
  "password": "change-me",
  "defaultMode": "default",
  "shell": "/bin/bash",
  "defaultCwd": "/path/to/project",
  "startupCommands": [],
  "allowedCommandPrefixes": [],
  "commandPresets": [
    {
      "label": "Codex",
      "command": "codex",
      "mode": "default"
    },
    {
      "label": "Claude",
      "command": "claude",
      "mode": "default"
    }
  ]
}
```

## Mobile usage

Set `host` to `0.0.0.0` if you want to open the web console from your phone on the same network.

```bash
node dist/cli.js config:set host 0.0.0.0
node dist/cli.js config:set password your-password
node dist/cli.js web
```

Then open `http://<your-machine-ip>:3170` on your phone.

## Publish

```bash
npm run build
npm publish
```
