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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Wand Console</title>
  <meta name="description" content="Local CLI Console for Vibe Coding - Manage terminal sessions from your browser" />
  <meta name="theme-color" content="#f6f1e8" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#1f1b17" media="(prefers-color-scheme: dark)" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Wand" />
  <link rel="apple-touch-icon" href="/icon-192.png" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="stylesheet" href="/vendor/xterm/css/xterm.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
${cssStyles}
  </style>
</head>
<body>
  <div id="app"></div>
${scriptOpen} src="/vendor/xterm/lib/xterm.js">${scriptClose}
${scriptOpen} src="/vendor/xterm-addon-fit/lib/addon-fit.js">${scriptClose}
${scriptOpen}>
${scriptContent}
${scriptClose}
</body>
</html>`;
}