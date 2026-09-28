import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WEB_ASSETS } from "./embedded-assets.js";
import { versionWebAsset, type VersionedWebAsset } from "./asset-version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _scriptCache = EMBEDDED_WEB_ASSETS.scriptsJs;
let _scriptCacheKey = "";
let _scriptAsset: (VersionedWebAsset & { source: string; configPath: string; chunkHash: string }) | null = null;
let _embeddedScriptAsset: (VersionedWebAsset & { configPath: string }) | null = null;

function readScriptCache(): void {
  const scriptPath = path.join(__dirname, "content", "scripts.js");
  try {
    const stat = fs.statSync(scriptPath);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== _scriptCacheKey) {
      _scriptCache = fs.readFileSync(scriptPath, "utf-8");
      _scriptCacheKey = key;
    }
  } catch {
    // An in-flight npm update can remove content/ before the old process exits.
    // Retain the last disk read, or fall back to the embedded copy.
  }
}

function injectRuntimeValues(source: string, configPath: string, chunkHash: string): string {
  return source
    // This is a JS string literal, not HTML text. JSON escaping also handles
    // quotes, backslashes and newlines in nonstandard configuration paths.
    .replace('"${wandConfigPath}"', JSON.stringify(configPath))
    .replace("${aiTeamsChunkSrc}", `/assets/ai-teams.js?v=${chunkHash}`);
}

export function getScriptAsset(configPath: string, requestedHash?: string): VersionedWebAsset {
  readScriptCache();
  const chunkHash = getAiTeamsChunk().hash;
  if (!_scriptAsset || _scriptAsset.source !== _scriptCache
    || _scriptAsset.configPath !== configPath || _scriptAsset.chunkHash !== chunkHash) {
    _scriptAsset = {
      ...versionWebAsset(injectRuntimeValues(_scriptCache, configPath, chunkHash)),
      source: _scriptCache, configPath, chunkHash,
    };
  }
  if (requestedHash && requestedHash !== _scriptAsset.hash) {
    if (!_embeddedScriptAsset || _embeddedScriptAsset.configPath !== configPath) {
      _embeddedScriptAsset = {
        ...versionWebAsset(injectRuntimeValues(
          EMBEDDED_WEB_ASSETS.scriptsJs, configPath, embeddedAiTeamsChunk.hash,
        )),
        configPath,
      };
    }
    if (requestedHash === _embeddedScriptAsset.hash) return _embeddedScriptAsset;
  }
  return _scriptAsset;
}

export function getScriptContent(configPath: string): string {
  return getScriptAsset(configPath).content;
}

const embeddedAiTeamsChunk = withHash(EMBEDDED_WEB_ASSETS.aiTeamsJs);
let _aiTeamsChunk = embeddedAiTeamsChunk;
let _aiTeamsChunkKey = "";

function withHash(content: string): { content: string; hash: string } {
  return { content, hash: createHash("md5").update(content).digest("hex").slice(0, 8) };
}

/**
 * 按需加载的 AI 团队脚本（content/ai-teams.js）。与 scripts.js 一样优先读磁盘上的新产物，
 * 自更新期间目录消失时退回内嵌副本；hash 进页面 meta 里的地址，长缓存按它失效。
 */
export function getAiTeamsChunk(requestedHash?: string): { content: string; hash: string } {
  const chunkPath = path.join(__dirname, "content", "ai-teams.js");
  try {
    const stat = fs.statSync(chunkPath);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== _aiTeamsChunkKey) {
      _aiTeamsChunk = withHash(fs.readFileSync(chunkPath, "utf-8"));
      _aiTeamsChunkKey = key;
    }
  } catch {
    // Same fallback as the main script during self-update.
  }
  if (requestedHash === embeddedAiTeamsChunk.hash) return embeddedAiTeamsChunk;
  return _aiTeamsChunk;
}
