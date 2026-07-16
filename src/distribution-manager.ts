import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { WandConfig } from "./types.js";
import { compareApkInstallOrder, compareSemver, extractSemver } from "./version-utils.js";

export type ApkUpdateChannel = "stable" | "beta";

export interface LocalDistributionAsset {
  fileName: string;
  filePath: string;
  size: number;
  updatedAt: string;
  version: string | null;
  downloadUrl: string;
  source: "local";
}

export interface ResolvedDistributionAsset {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  source: "local" | "github";
  releaseNotes?: string;
}

interface GitHubDistributionAsset {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  releaseNotes?: string;
}

interface GitHubReleaseAssetHit {
  tagName: string;
  body?: string;
  asset: { name: string; browser_download_url: string; size: number };
}

interface CachedGitHubAsset {
  asset: GitHubDistributionAsset;
  timestamp: number;
}

export interface DistributionSettings {
  androidApk: Record<string, unknown>;
  macosDmg: Record<string, unknown>;
}

export interface DistributionManagerOptions {
  configDir: string;
  configPath: string;
  config: WandConfig;
  repositoryUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * GitHub Release 正文还包含 Android/macOS/iOS 的安装指引；它们属于发布页，
 * 不该出现在 Android 的更新弹窗。保留分隔线前的变更摘要，并兼容旧版正文。
 */
export function extractUpdateSummary(releaseBody: string): string {
  const summary = releaseBody.split(/\r?\n---\s*(?:\r?\n|$)/, 1)[0]?.trim() ?? "";
  return summary.slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function resolveConfiguredDir(configDir: string, configuredDir: string | undefined, fallback: string): string {
  const value = configuredDir?.trim();
  if (!value) return path.join(configDir, fallback);
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function extractArtifactVersion(fileName: string, extension: string): string | null {
  return extractSemver(fileName.replace(new RegExp(`\\${extension}$`, "i"), ""));
}

function isPrerelease(version: string | null): boolean {
  return !!version && version.includes("-");
}

export class DistributionManager {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly githubCache = new Map<string, CachedGitHubAsset>();

  constructor(private readonly options: DistributionManagerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async resolveLatestApk(channel: ApkUpdateChannel): Promise<ResolvedDistributionAsset | null> {
    const [localApk, githubApk] = await Promise.all([
      this.resolveAndroidDownload(channel),
      this.fetchGitHubAsset(".apk"),
    ]);
    const local = localApk?.version ? {
      version: localApk.version,
      downloadUrl: `${localApk.downloadUrl}?channel=${channel}`,
      fileName: localApk.fileName,
      size: localApk.size,
      source: "local" as const,
    } : null;
    const github = githubApk ? { ...githubApk, source: "github" as const } : null;

    if (local && github) {
      return compareApkInstallOrder(github.version, local.version) > 0 ? github : local;
    }
    return local ?? github;
  }

  async resolveAndroidDownload(channel: ApkUpdateChannel = "beta"): Promise<LocalDistributionAsset | null> {
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.android?.enabled !== true) return null;
    const directory = resolveConfiguredDir(configDir, config.android.apkDir, "android");
    return this.resolveLocalAsset({
      directory,
      extension: ".apk",
      configuredFile: channel === "beta" ? "" : config.android.currentApkFile,
      downloadUrl: "/android/download",
      compareVersions: compareApkInstallOrder,
      acceptVersion: channel === "stable" ? (version) => !isPrerelease(version) : undefined,
    });
  }

  async resolveLatestDmg(): Promise<ResolvedDistributionAsset | null> {
    const localDmg = await this.resolveMacosDownload();
    if (localDmg?.version) {
      return {
        version: localDmg.version,
        downloadUrl: localDmg.downloadUrl,
        fileName: localDmg.fileName,
        size: localDmg.size,
        source: "local",
      };
    }
    const github = await this.fetchGitHubAsset(".dmg");
    return github ? { ...github, source: "github" } : null;
  }

  async resolveMacosDownload(): Promise<LocalDistributionAsset | null> {
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.macos?.enabled !== true) return null;
    return this.resolveLocalAsset({
      directory: resolveConfiguredDir(configDir, config.macos.dmgDir, "macos"),
      extension: ".dmg",
      configuredFile: config.macos.currentDmgFile,
      downloadUrl: "/macos/download",
      compareVersions: compareSemver,
    });
  }

  async getSettings(): Promise<DistributionSettings> {
    const [localApk, githubApk, localDmg, githubDmg] = await Promise.all([
      this.resolveAndroidDownload("beta"),
      this.fetchGitHubAsset(".apk"),
      this.resolveMacosDownload(),
      this.fetchGitHubAsset(".dmg"),
    ]);
    const apkDir = resolveConfiguredDir(this.options.configDir, this.options.config.android?.apkDir, "android");
    const dmgDir = resolveConfiguredDir(this.options.configDir, this.options.config.macos?.dmgDir, "macos");
    return {
      androidApk: this.buildSettings("apk", apkDir, this.options.config.android?.enabled === true, localApk, githubApk),
      macosDmg: this.buildSettings("dmg", dmgDir, this.options.config.macos?.enabled === true, localDmg, githubDmg),
    };
  }

  private async refreshConfig(): Promise<void> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(this.options.configPath, "utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const { config } = this.options;
    const android = asRecord(raw.android);
    if (android) {
      config.android = { ...(config.android ?? {}) };
      if (typeof android.enabled === "boolean") config.android.enabled = android.enabled;
      if (Object.hasOwn(android, "apkDir")) {
        config.android.apkDir = typeof android.apkDir === "string" && android.apkDir.trim() ? android.apkDir.trim() : "android";
      }
      if (Object.hasOwn(android, "currentApkFile")) {
        config.android.currentApkFile = typeof android.currentApkFile === "string" ? android.currentApkFile.trim() : "";
      }
    }
    const macos = asRecord(raw.macos);
    if (macos) {
      config.macos = { ...(config.macos ?? {}) };
      if (typeof macos.enabled === "boolean") config.macos.enabled = macos.enabled;
      if (Object.hasOwn(macos, "dmgDir")) {
        config.macos.dmgDir = typeof macos.dmgDir === "string" && macos.dmgDir.trim() ? macos.dmgDir.trim() : "macos";
      }
      if (Object.hasOwn(macos, "currentDmgFile")) {
        config.macos.currentDmgFile = typeof macos.currentDmgFile === "string" ? macos.currentDmgFile.trim() : "";
      }
    }
  }

  private async resolveLocalAsset(options: {
    directory: string;
    extension: ".apk" | ".dmg";
    configuredFile?: string;
    downloadUrl: string;
    compareVersions(a: string, b: string): number;
    acceptVersion?: (version: string | null) => boolean;
  }): Promise<LocalDistributionAsset | null> {
    await mkdir(options.directory, { recursive: true });
    const configuredFile = options.configuredFile?.trim();
    if (configuredFile) {
      return this.readLocalAsset(path.join(options.directory, path.basename(configuredFile)), options);
    }

    const entries = await readdir(options.directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(options.extension));
    const candidates = (await Promise.all(files.map(async (entry) => {
      const filePath = path.join(options.directory, entry.name);
      return { entry, filePath, fileStat: await stat(filePath) };
    }))).filter(({ entry }) => options.acceptVersion?.(extractArtifactVersion(entry.name, options.extension)) ?? true);
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const aVersion = extractArtifactVersion(a.entry.name, options.extension);
      const bVersion = extractArtifactVersion(b.entry.name, options.extension);
      if (aVersion && bVersion) {
        const comparison = options.compareVersions(bVersion, aVersion);
        if (comparison !== 0) return comparison;
      } else if (aVersion) {
        return -1;
      } else if (bVersion) {
        return 1;
      }
      return b.fileStat.mtimeMs - a.fileStat.mtimeMs;
    });
    const selected = candidates[0];
    return {
      fileName: selected.entry.name,
      filePath: selected.filePath,
      size: selected.fileStat.size,
      updatedAt: selected.fileStat.mtime.toISOString(),
      version: extractArtifactVersion(selected.entry.name, options.extension),
      downloadUrl: options.downloadUrl,
      source: "local",
    };
  }

  private async readLocalAsset(filePath: string, options: {
    extension: ".apk" | ".dmg";
    downloadUrl: string;
    acceptVersion?: (version: string | null) => boolean;
  }): Promise<LocalDistributionAsset | null> {
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return null;
      const fileName = path.basename(filePath);
      const version = extractArtifactVersion(fileName, options.extension);
      if (options.acceptVersion && !options.acceptVersion(version)) return null;
      return {
        fileName,
        filePath,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
        version,
        downloadUrl: options.downloadUrl,
        source: "local",
      };
    } catch {
      return null;
    }
  }

  private async fetchGitHubAsset(extension: ".apk" | ".dmg"): Promise<GitHubDistributionAsset | null> {
    const cached = this.githubCache.get(extension);
    if (cached && this.now() - cached.timestamp < GITHUB_CACHE_TTL_MS) return cached.asset;
    try {
      const hit = await this.fetchGitHubReleaseAsset(extension);
      if (!hit) return cached?.asset ?? null;
      const version = extractArtifactVersion(hit.asset.name, extension)
        ?? extractArtifactVersion(hit.tagName, extension)
        ?? hit.tagName.replace(/^v/, "");
      const asset: GitHubDistributionAsset = {
        version,
        downloadUrl: hit.asset.browser_download_url,
        fileName: hit.asset.name,
        size: hit.asset.size,
        ...(extension === ".apk" && hit.body ? { releaseNotes: extractUpdateSummary(hit.body) } : {}),
      };
      this.githubCache.set(extension, { asset, timestamp: this.now() });
      return asset;
    } catch {
      return cached?.asset ?? null;
    }
  }

  private async fetchGitHubReleaseAsset(extension: string): Promise<GitHubReleaseAssetHit | null> {
    const apiUrl = this.options.repositoryUrl.replace("github.com", "api.github.com/repos") + "/releases?per_page=30";
    const response = await this.fetchImpl(apiUrl, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "wand-server" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const releases = await response.json() as Array<{
      tag_name: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets: Array<{ name: string; browser_download_url: string; size: number }>;
    }>;
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const asset = release.assets.find((candidate) => candidate.name.toLowerCase().endsWith(extension));
      if (asset) return { tagName: release.tag_name, body: release.body, asset };
    }
    return null;
  }

  private buildSettings(
    kind: "apk" | "dmg",
    directory: string,
    enabled: boolean,
    local: LocalDistributionAsset | null,
    github: GitHubDistributionAsset | null,
  ): Record<string, unknown> {
    const selected = local
      ? { ...local, source: "local" as const }
      : github
        ? { ...github, updatedAt: null, source: "github" as const }
        : null;
    const hasKey = kind === "apk" ? "hasApk" : "hasDmg";
    const dirKey = kind === "apk" ? "apkDir" : "dmgDir";
    return {
      enabled,
      [dirKey]: directory,
      [hasKey]: selected !== null,
      fileName: selected?.fileName ?? null,
      version: selected?.version ?? null,
      size: selected?.size ?? null,
      updatedAt: selected?.updatedAt ?? null,
      downloadUrl: selected?.downloadUrl ?? null,
      source: selected?.source ?? null,
      local: local ? this.publicAsset(local) : null,
      github: github ? this.publicAsset(github) : null,
    };
  }

  private publicAsset(asset: GitHubDistributionAsset | LocalDistributionAsset): Record<string, unknown> {
    return {
      fileName: asset.fileName,
      version: asset.version,
      size: asset.size,
      ...("updatedAt" in asset ? { updatedAt: asset.updatedAt } : {}),
      downloadUrl: asset.downloadUrl,
    };
  }
}
