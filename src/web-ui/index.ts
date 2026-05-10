// Main entry point for web-ui module
// Combines CSS and JavaScript into a single HTML document

import { getCSSStyles } from "./styles.js";
import { getScriptContent } from "./scripts.js";

// Use String.fromCharCode to avoid template literal interpretation of </script>
const scriptClose = String.fromCharCode(60, 47) + "script>";
const scriptOpen = "<" + "script";

export function renderApp(configPath: string): string {
  const cssStyles = getCSSStyles();
  const scriptContent = getScriptContent(configPath);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Wand Console</title>
  <meta name="description" content="Local CLI Console for Vibe Coding - Manage terminal sessions from your browser" />
  <meta name="theme-color" content="#f6f1e8" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#1f1b17" media="(prefers-color-scheme: dark)" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="Wand" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="application-name" content="Wand" />
  <meta name="format-detection" content="telephone=no" />
  <meta name="msapplication-TileColor" content="#c5653d" />
  <meta name="msapplication-tap-highlight" content="no" />
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icon.svg" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="stylesheet" href="/vendor/wterm/terminal.css" />
  <style>
${cssStyles}
  </style>
</head>
<body>
  <div id="app"></div>
${scriptOpen} src="/vendor/wterm/wterm.bundle.js">${scriptClose}
${scriptOpen} src="/vendor/qrcode/qrcode.bundle.js">${scriptClose}
${scriptOpen}>
${scriptContent}
${scriptClose}
</body>
</html>`;
}