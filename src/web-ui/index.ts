// Main entry point for web-ui module
// Combines CSS and JavaScript into a single HTML document

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCSSStyles } from "./styles.js";
import { getScriptContent } from "./scripts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use String.fromCharCode to avoid template literal interpretation of </script>
const scriptClose = String.fromCharCode(60, 47) + "script>";
const scriptOpen = "<" + "script";

// Vendor assets are served with immutable cache headers, so the URL must
// change whenever the file content changes — otherwise the browser keeps the
// stale copy across upgrades. We append ?v=<sha-prefix> derived from the
// on-disk bundle so each new build busts the cache automatically.
const vendorHashCache = new Map<string, string>();
function vendorAssetUrl(relPath: string): string {
  if (!vendorHashCache.has(relPath)) {
    const fullPath = path.join(__dirname, "content", relPath);
    let hash = "0";
    try {
      if (existsSync(fullPath)) {
        const buf = readFileSync(fullPath);
        hash = createHash("md5").update(buf).digest("hex").slice(0, 8);
      }
    } catch {
      hash = String(Date.now()).slice(-8);
    }
    vendorHashCache.set(relPath, hash);
  }
  return `${relPath}?v=${vendorHashCache.get(relPath)}`;
}

export function renderApp(configPath: string): string {
  const cssStyles = getCSSStyles();
  const scriptContent = getScriptContent(configPath);
  const wtermSrc = vendorAssetUrl("/vendor/wterm/wterm.bundle.js");
  const qrcodeSrc = vendorAssetUrl("/vendor/qrcode/qrcode.bundle.js");
  const wtermCssHref = vendorAssetUrl("/vendor/wterm/terminal.css");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />
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
  <link rel="stylesheet" href="${wtermCssHref}" />
  <style>
${cssStyles}
  </style>
</head>
<body>
  <div id="app"></div>
${scriptOpen} src="${wtermSrc}">${scriptClose}
${scriptOpen} src="${qrcodeSrc}">${scriptClose}
${scriptOpen}>
${scriptContent}
${scriptClose}
</body>
</html>`;
}