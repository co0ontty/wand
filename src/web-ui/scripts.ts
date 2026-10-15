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

function injectRuntimeValues(source: string, configPath: string, chunkHash: string, plushHash: string, manifest: BrowserModuleManifest): string {
  return source
    // This is a JS string literal, not HTML text. JSON escaping also handles
    // quotes, backslashes and newlines in nonstandard configuration paths.
    .replace('"${wandConfigPath}"', JSON.stringify(configPath))
    .replace("${aiTeamsChunkSrc}", `/assets/ai-teams.js?v=${chunkHash}`)
    .replace("${plushAvatarChunkSrc}", `/assets/plush-avatar.js?v=${plushHash}`)
    .replace("${browserModuleSrc}", `/assets/${manifest.entry}`)
    .replace('"${browserModuleImports}"', JSON.stringify(manifest.imports ?? {}));
}

export function getScriptAsset(configPath: string, requestedHash?: string): VersionedWebAsset {
  readScriptCache();
  const teamHash = getAiTeamsChunk().hash;
  const plushHash = getPlushAvatarChunk().hash;
  const manifest = getBrowserModuleManifest();
  const chunkHash = `${teamHash}:${plushHash}:${manifest.buildId ?? manifest.entry}`;
  if (!_scriptAsset || _scriptAsset.source !== _scriptCache
    || _scriptAsset.configPath !== configPath || _scriptAsset.chunkHash !== chunkHash) {
    _scriptAsset = {
      ...versionWebAsset(injectRuntimeValues(_scriptCache, configPath, teamHash, plushHash, manifest)),
      source: _scriptCache, configPath, chunkHash,
    };
  }
  if (requestedHash && requestedHash !== _scriptAsset.hash) {
    if (!_embeddedScriptAsset || _embeddedScriptAsset.configPath !== configPath) {
      _embeddedScriptAsset = {
        ...versionWebAsset(injectRuntimeValues(
          EMBEDDED_WEB_ASSETS.scriptsJs, configPath, embeddedAiTeamsChunk.hash, embeddedPlushAvatarChunk.hash,
          EMBEDDED_WEB_ASSETS.browserModuleManifest,
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

const embeddedPlushAvatarChunk = withHash(EMBEDDED_WEB_ASSETS.plushAvatarJs);
let plushAvatarChunk = embeddedPlushAvatarChunk;
let plushAvatarChunkKey = "";

/** Content-versioned WebGL runtime, retaining embedded bytes during an in-flight package replacement. */
export function getPlushAvatarChunk(requestedHash?: string): { content: string; hash: string } {
  const chunkPath = path.join(__dirname, "content", "plush-avatar.js");
  try {
    const stat = fs.statSync(chunkPath);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== plushAvatarChunkKey) {
      plushAvatarChunk = withHash(fs.readFileSync(chunkPath, "utf-8")); plushAvatarChunkKey = key;
    }
  } catch { /* Keep the process's last/embedded version during self-update. */ }
  return requestedHash === embeddedPlushAvatarChunk.hash ? embeddedPlushAvatarChunk : plushAvatarChunk;
}

/** Blocking, content-versioned device preference bootstrap. */
export function getThemePreloadAsset(): VersionedWebAsset {
  return themePreloadAsset;
}
const themePreloadAsset = versionWebAsset(EMBEDDED_WEB_ASSETS.themePreloadJs);

export interface BrowserModuleManifest {
  buildId?: string;
  imports?: Record<string, string>;
  dependencies?: Record<string, readonly string[]>;
  integrity?: Record<string, string>;
  entry: string;
  eager: readonly string[];
  files: readonly string[];
  features?: Record<string, string>;
}
let browserManifest: BrowserModuleManifest = EMBEDDED_WEB_ASSETS.browserModuleManifest;
let browserManifestKey = "";
const browserBuilds: Map<string, string>[] = [];

/** Snapshot a complete build before serving its bootstrap. Old processes keep
 * its lazy bytes even if npm removes/replaces content during self-update. */
export function getBrowserModuleManifest(): BrowserModuleManifest {
  try {
    const manifestPath = path.join(__dirname, "content/module-manifest.json");
    const stat = fs.statSync(manifestPath);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== browserManifestKey) {
      const next = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BrowserModuleManifest;
      if (!next.files.every(file => /^modules\/[a-f0-9]{16}\/[A-Za-z0-9_-]+\.js$/.test(file))
        || !next.files.includes(next.entry) || !next.eager.every(file => next.files.includes(file))
        || !Object.values(next.imports ?? {}).every(file => next.files.includes(file))
        || !Object.entries(next.dependencies ?? {}).every(([file, deps]) => next.files.includes(file) && deps.every(dep => next.files.includes(dep)))) {
        throw new Error("Invalid browser module manifest");
      }
      const files = new Map(next.files.map(file => {
        const content = fs.readFileSync(path.join(__dirname, "content", file), "utf8");
        if (next.integrity && createHash("sha256").update(content).digest("hex") !== next.integrity[file]) {
          throw new Error("Browser module integrity mismatch");
        }
        return [file, content] as const;
      }));
      browserBuilds.unshift(files);
      browserBuilds.splice(2);
      browserManifest = next;
      browserManifestKey = key;
    }
  } catch { /* Retain the last complete graph (or embedded build), never mix versions. */ }
  return browserManifest;
}

export function getBrowserModule(file: string): string | undefined {
  getBrowserModuleManifest();
  for (const build of browserBuilds) {
    const content = build.get(file);
    if (content !== undefined) return content;
  }
  return Object.hasOwn(EMBEDDED_WEB_ASSETS.browserModules, file) ? EMBEDDED_WEB_ASSETS.browserModules[file] : undefined;
}
