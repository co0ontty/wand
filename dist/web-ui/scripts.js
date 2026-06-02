import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WEB_ASSETS } from "./embedded-assets.js";
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _scriptCache = EMBEDDED_WEB_ASSETS.scriptsJs;
let _scriptCacheMtimeMs = 0;
export function getScriptContent(configPath) {
    const scriptPath = path.join(__dirname, "content", "scripts.js");
    try {
        const stat = fs.statSync(scriptPath);
        if (_scriptCache === null || stat.mtimeMs !== _scriptCacheMtimeMs) {
            _scriptCache = fs.readFileSync(scriptPath, "utf-8");
            _scriptCacheMtimeMs = stat.mtimeMs;
        }
    }
    catch {
        // During self-update npm can replace the global package directory while the
        // old process is still serving requests. The embedded build asset keeps the
        // app shell renderable even when dist/web-ui/content has disappeared.
    }
    // Inject the config path
    return _scriptCache.replace("${escapeHtml(configPath)}", escapeHtml(configPath));
}
