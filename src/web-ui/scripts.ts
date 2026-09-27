import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WEB_ASSETS } from "./embedded-assets.js";

function escapeHtml(value: string): string {
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

export function getScriptContent(configPath: string): string {
  const scriptPath = path.join(__dirname, "content", "scripts.js");
  try {
    const stat = fs.statSync(scriptPath);
    if (_scriptCache === null || stat.mtimeMs !== _scriptCacheMtimeMs) {
      _scriptCache = fs.readFileSync(scriptPath, "utf-8");
      _scriptCacheMtimeMs = stat.mtimeMs;
    }
  } catch {
    // During self-update npm can replace the global package directory while the
    // old process is still serving requests. The embedded build asset keeps the
    // app shell renderable even when dist/web-ui/content has disappeared.
  }

  // Inject the config path and the hashed on-demand AI teams script URL
  return _scriptCache
    .replace("${escapeHtml(configPath)}", escapeHtml(configPath))
    .replace("${aiTeamsChunkSrc}", `/assets/ai-teams.js?v=${getAiTeamsChunk().hash}`);
}

let _aiTeamsChunk = withHash(EMBEDDED_WEB_ASSETS.aiTeamsJs);
let _aiTeamsChunkMtimeMs = 0;

function withHash(content: string): { content: string; hash: string } {
  return { content, hash: createHash("md5").update(content).digest("hex").slice(0, 8) };
}

/**
 * 按需加载的 AI 团队脚本（content/ai-teams.js）。与 scripts.js 一样优先读磁盘上的新产物，
 * 自更新期间目录消失时退回内嵌副本；hash 进页面 meta 里的地址，长缓存按它失效。
 */
export function getAiTeamsChunk(): { content: string; hash: string } {
  const chunkPath = path.join(__dirname, "content", "ai-teams.js");
  try {
    const stat = fs.statSync(chunkPath);
    if (stat.mtimeMs !== _aiTeamsChunkMtimeMs) {
      _aiTeamsChunk = withHash(fs.readFileSync(chunkPath, "utf-8"));
      _aiTeamsChunkMtimeMs = stat.mtimeMs;
    }
  } catch {
    // 同 getScriptContent：用内嵌副本兜底。
  }
  return _aiTeamsChunk;
}
