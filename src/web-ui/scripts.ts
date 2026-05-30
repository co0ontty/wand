import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _scriptCache: string | null = null;
let _scriptCacheMtimeMs = 0;

export function getScriptContent(configPath: string): string {
  const scriptPath = path.join(__dirname, "content", "scripts.js");
  try {
    const stat = fs.statSync(scriptPath);
    if (_scriptCache === null || stat.mtimeMs !== _scriptCacheMtimeMs) {
      _scriptCache = fs.readFileSync(scriptPath, "utf-8");
      _scriptCacheMtimeMs = stat.mtimeMs;
    }
  } catch {
    // During self-update npm can briefly replace the global package directory.
    // Keep serving the already-loaded UI until /api/restart switches process.
    if (_scriptCache === null) {
      _scriptCache = fs.readFileSync(scriptPath, "utf-8");
    }
  }

  // Inject the config path
  return _scriptCache.replace("${escapeHtml(configPath)}", escapeHtml(configPath));
}
