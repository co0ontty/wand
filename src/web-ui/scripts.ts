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

// Cache the script content
let _scriptCache: string | null = null;

export function getScriptContent(configPath: string): string {
  if (!_scriptCache) {
    const scriptPath = path.join(__dirname, "content", "scripts.js");
    _scriptCache = fs.readFileSync(scriptPath, "utf-8");
  }

  // Inject the config path
  return _scriptCache.replace("${escapeHtml(configPath)}", escapeHtml(configPath));
}