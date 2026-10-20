import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { WandConfig } from "./types.js";
import { compareApkInstallOrder, compareDistributionFiles, compareMacosFormatTieBreak, compareSemver, compareWandInstallOrder, extractSemver } from "./version-utils.js";
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
  /** 本地文件哈希或 GitHub Release asset.digest；客户端下载后校验。 */
  sha256?: string;
}

interface GitHubDistributionAsset {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  releaseNotes?: string;
  sha256?: string;
}

export interface GitHubApkDownload {
  remoteUrl: string;
  fileName: string;
  size: number;
  sha256?: string;
}

interface GitHubReleaseAssetHit {
  tagName: string;
  body?: string;
  asset: { name: string; browser_download_url: string; size: number; digest?: string };
}

interface CachedGitHubAsset {
  asset: GitHubDistributionAsset;
  timestamp: number;
}

export interface DistributionSettings {
  androidApk: Record<string, unknown>;
  macosDmg: Record<string, unknown>;
  iosIpa: Record<string, unknown>;
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
const MACOS_UPDATE_FILE_PATTERN = /^wand-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?\.(?:zip|dmg)$/i;
/** macOS 构建脚本写在包旁边的校验边车（`wand-v<version>.update.json`）。 */
const MACOS_UPDATE_SIDECAR_PATTERN = /^wand-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?\.update\.json$/i;

/** 分发目录清理结果：删了哪些文件名、释放多少字节。 */
export interface PruneReport {
  deleted: string[];
  freedBytes: number;
}

function emptyPruneReport(): PruneReport {
  return { deleted: [], freedBytes: 0 };
}

/** 从 `wand-v1.2.3.update.json` 得到 `wand-v1.2.3`，非边车返回 null。 */
function macosSidecarBase(name: string): string | null {
  if (!MACOS_UPDATE_SIDECAR_PATTERN.test(name)) return null;
  return name.slice(0, -"update.json".length - 1);
}

/** 尽力删除：删不掉（如下载流仍持有）就留给下次触发，不计入结果。 */
async function removeQuietly(filePath: string, report: PruneReport): Promise<boolean> {
  try {
    await unlink(filePath);
    report.deleted.push(path.basename(filePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub Release 正文还包含 Android/macOS/iOS 的安装指引；它们属于发布页，
 * 不该出现在 Android 的更新弹窗。保留分隔线前的变更摘要，并兼容旧版正文。
 */
export function extractUpdateSummary(releaseBody: string): string {
  const summary = releaseBody.split(/\r?\n---\s*(?:\r?\n|$)/, 1)[0]?.trim() ?? "";
  return summary.slice(0, 500);
}

/**
 * GitHub Release 文件名带 semver build metadata（`wand-v4.48.0+202608232136.apk`）。
 * `+` 在 content URI / 部分 OEM 安装器里会被当成空格，下载成功后无法拉起安装。
 * 落盘和对外 fileName 都改成 `-`，版本比较仍用原始 GitHub 文件名提取的 version。
 */
export function sanitizeApkFileName(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/, "").trim() || "wand-update.apk";
  const replaced = base.replaceAll("+", "-").replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!replaced.toLowerCase().endsWith(".apk")) return `${replaced || "wand-update"}.apk`;
  return replaced;
}

/** 解析 GitHub Release asset.digest（`sha256:<hex>`）；格式不对返回 undefined。 */
export function parseGithubDigest(digest: string | undefined): string | undefined {
  if (!digest) return undefined;
  const match = /^sha256:([a-fA-F0-9]{64})$/.exec(digest.trim());
  return match ? match[1].toLowerCase() : undefined;
}

export function githubApkProxyPath(channel?: ApkUpdateChannel): string {
  return channel
    ? `/android/download?channel=${channel}&source=github`
    : "/android/download?source=github";
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

/**
 * 本地分发候选的统一排序：直接复用 version-utils 的实现，保证「更新检查选谁」
 * 与「构建包清理保谁」永远同一个答案。
 */
function compareLocalAssetCandidates(
  a: { name: string; mtimeMs: number },
  b: { name: string; mtimeMs: number },
  extension: ".apk" | ".dmg" | ".ipa" | ".zip",
  compareVersions: (a: string, b: string) => number,
): number {
  return compareDistributionFiles(
    { ...a, version: extractArtifactVersion(a.name, extension) },
    { ...b, version: extractArtifactVersion(b.name, extension) },
    compareVersions,
  );
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
    const github = githubApk ? {
      ...githubApk,
      source: "github" as const,
      // 手机不要直连 GitHub CDN：检查接口能通只说明 wand server 能访问 api.github.com，
      // objects/release-assets.githubusercontent.com 在移动网上经常被重置。
      fileName: sanitizeApkFileName(githubApk.fileName),
      downloadUrl: githubApkProxyPath(channel),
    } : null;

    let winner: ResolvedDistributionAsset | null;
    if (local && github) {
      winner = compareApkInstallOrder(github.version, local.version) > 0 ? github : local;
    } else {
      winner = local ?? github;
    }
    // 本地分发现算 SHA-256；GitHub 来源用 Release digest，随 spread 带上。
    if (winner?.source === "local" && localApk) {
      try {
        const fileStat = await stat(localApk.filePath);
        winner = {
          ...winner,
          sha256: await this.computeLocalFileSha256(localApk.filePath, fileStat.size, fileStat.mtimeMs),
        };
      } catch {
        // 哈希计算失败不阻断更新检查；客户端拿到空 sha256 会跳过校验。
      }
    }
    return winner;
  }

  /**
   * 给 `/android/download?source=github` 用：原始 GitHub URL 只留在服务端，
   * 客户端只拿到同源代理地址。fileName 已去掉 `+`。
   */
  async resolveGitHubApkDownload(): Promise<GitHubApkDownload | null> {
    const asset = await this.fetchGitHubAsset(".apk");
    if (!asset) return null;
    return {
      remoteUrl: asset.downloadUrl,
      fileName: sanitizeApkFileName(asset.fileName),
      size: asset.size,
      sha256: asset.sha256,
    };
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

  /**
   * 清理 Android 分发目录，只保留最新的一个 APK。在设备开始下载 Beta 包时
   * 触发（见 /android/download 路由）：debug 构建每次都带独立时间戳版本号，
   * 不清理会按构建次数无限堆积。
   *
   * 永不删除两类文件：
   * - keepFileName：本次正在下发的文件（理论上就是最新的，防御性保留）；
   * - config.android.currentApkFile 固定指向的文件（stable 通道可能仍在用）。
   *
   * 「最新」的判定与 resolveLocalAsset 的选择规则一致（见
   * compareLocalAssetCandidates）。返回删除的文件名与释放字节数；目录不存在、
   * 只剩一个包等情形都是空操作。单个文件删除失败不阻断其余清理。
   */
  async pruneAndroidApkDirectory(keepFileName?: string): Promise<PruneReport> {
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.android?.enabled !== true) return emptyPruneReport();
    return this.pruneDistributionDirectory({
      directory: resolveConfiguredDir(configDir, config.android.apkDir, "android"),
      matches: (name) => name.toLowerCase().endsWith(".apk"),
      extension: (name) => ".apk",
      compareVersions: compareApkInstallOrder,
      keepNames: [config.android.currentApkFile, keepFileName],
    });
  }

  /**
   * 清理 macOS 分发目录。macOS 的构建脚本每个 debug 构建都产出独立时间戳的
   * `.zip` + `.dmg` + `.update.json`，跨版本、同版本多次构建都会堆积。
   *
   * 保留：最新版本的全部文件（同版本的 zip/dmg/update.json 是一套，必须整体
   * 保留——更新检查选 zip、`/macos/download` 可能选 dmg、update.json 是它们的
   * 校验边车）、`currentDmgFile` 固定指向的包及其边车、本次正在下发的包及其边车。
   * 其余版本的文件才会删除。
   */
  async pruneMacosBetaDirectory(keepFileName?: string): Promise<PruneReport> {
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.macos?.enabled !== true) return emptyPruneReport();
    return this.pruneDistributionDirectory({
      directory: resolveConfiguredDir(configDir, config.macos.dmgDir, "macos"),
      matches: (name) => MACOS_UPDATE_FILE_PATTERN.test(name) || MACOS_UPDATE_SIDECAR_PATTERN.test(name),
      extension: (name) => (name.toLowerCase().endsWith(".zip") ? ".zip" : ".dmg"),
      // 与 resolveMacosBetaAsset 完全同一份规则：同版本 ZIP 优先，其次修改时间。
      compareVersions: compareWandInstallOrder,
      tieBreak: compareMacosFormatTieBreak,
      keepNames: [config.macos.currentDmgFile, keepFileName],
      sidecarOf: macosSidecarBase,
    });
  }

  /**
   * 清理 iOS 分发目录。`ios/build.sh` 每次构建产出 `wand-v<version>.ipa`，
   * debug 版本号带时间戳，因此同样会按构建次数堆积。
   */
  async pruneIosIpaDirectory(keepFileName?: string): Promise<PruneReport> {
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.ios?.enabled !== true) return emptyPruneReport();
    return this.pruneDistributionDirectory({
      directory: resolveConfiguredDir(configDir, config.ios.ipaDir, "ios"),
      matches: (name) => name.toLowerCase().endsWith(".ipa"),
      extension: () => ".ipa",
      compareVersions: compareWandInstallOrder,
      keepNames: [config.ios.currentIpaFile, keepFileName],
    });
  }

  /**
   * 分发目录清理的统一实现。三个平台只在「哪些文件算包」「怎么比版本」上不同，
   * 保留规则和删除安全性必须共用，避免各自演化出不同答案。
   *
   * 排序与更新检查共用 `compareLocalAssetCandidates`，所以清理永远保留更新
   * 检查会选中的那个文件。`.update.json` 这类边车不参与排序，只跟随它的包。
   */
  private async pruneDistributionDirectory(options: {
    directory: string;
    matches: (name: string) => boolean;
    extension: (name: string) => ".apk" | ".dmg" | ".ipa" | ".zip";
    compareVersions: (a: string, b: string) => number;
    tieBreak?: (a: { name: string; mtimeMs: number }, b: { name: string; mtimeMs: number }) => number;
    keepNames: (string | undefined)[];
    sidecarOf?: (name: string) => string | null;
  }): Promise<PruneReport> {
    const report = emptyPruneReport();
    let entries;
    try {
      entries = await readdir(options.directory, { withFileTypes: true });
    } catch {
      return report;
    }
    const matched = entries.filter((entry) => entry.isFile() && options.matches(entry.name));
    if (matched.length === 0) return report;
    const candidates = await Promise.all(matched.map(async (entry) => {
      const filePath = path.join(options.directory, entry.name);
      try {
        const fileStat = await stat(filePath);
        const sidecar = options.sidecarOf?.(entry.name) ?? null;
        return {
          name: entry.name,
          filePath,
          fileStat,
          version: sidecar ? null : extractArtifactVersion(entry.name, options.extension(entry.name)),
          sidecar,
        };
      } catch {
        return null;
      }
    }));
    const packages = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null && candidate.version !== null);
    const sidecars = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null && candidate.version === null);
    if (packages.length === 0) return report;
    const sorted = [...packages].sort((a, b) => compareDistributionFiles(
      { name: a.name, mtimeMs: a.fileStat.mtimeMs, version: a.version },
      { name: b.name, mtimeMs: b.fileStat.mtimeMs, version: b.version },
      options.compareVersions,
      options.tieBreak,
    ));
    const keepNames = new Set<string>();
    const newest = sorted[0];
    // 最新版本保留整套：同版本的所有格式（zip/dmg）都留。
    // debug 构建的版本号里已带构建时间戳（`4.97.1-debug.10181725`），所以同版本
    // 多次构建是不同 version，自然只有最靠前的那一次被保留。
    for (const candidate of packages) if (candidate.version === newest.version) keepNames.add(candidate.name);
    for (const name of options.keepNames) {
      const base = name?.trim();
      if (!base) continue;
      const fileName = path.basename(base);
      keepNames.add(fileName);
      const version = extractArtifactVersion(fileName, options.extension(fileName));
      // 固定指向某个版本时，该版本整套产物一起保留，避免留下半套。
      if (version) for (const candidate of packages) if (candidate.version === version) keepNames.add(candidate.name);
    }
    for (const candidate of packages) {
      if (keepNames.has(candidate.name)) continue;
      if (await removeQuietly(candidate.filePath, report)) report.freedBytes += candidate.fileStat.size;
    }
    // 边车跟随它的包：保留集合里的包所对应的 `wand-v<version>` 基名。
    const keepBases = new Set<string>();
    for (const name of keepNames) keepBases.add(name.slice(0, name.length - path.extname(name).length));
    for (const sidecar of sidecars) {
      if (sidecar.sidecar && keepBases.has(sidecar.sidecar)) continue;
      if (await removeQuietly(sidecar.filePath, report)) report.freedBytes += sidecar.fileStat.size;
    }
    return report;
  }

  /** Beta 仅从当前服务端的 macOS 分发目录选择，绝不回退 GitHub。 */
  async resolveLatestMacosBeta(): Promise<ResolvedDistributionAsset | null> {
    const asset = await this.resolveMacosBetaAsset();
    if (!asset?.version || asset.size <= 0) return null;
    const sha256 = await this.computeAssetSha256(asset);
    if (!sha256) return null;
    return {
      version: asset.version.split("+")[0],
      downloadUrl: `/macos/update-download?fileName=${encodeURIComponent(asset.fileName)}`,
      fileName: asset.fileName,
      size: asset.size,
      source: "local",
      sha256,
    };
  }

  /** 固定下载文件名，避免检查与下载之间新增包后下载到另一个版本。 */
  async resolveMacosBetaDownload(fileName: string): Promise<LocalDistributionAsset | null> {
    if (!MACOS_UPDATE_FILE_PATTERN.test(fileName)) return null;
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.macos?.enabled !== true) return null;
    const directory = resolveConfiguredDir(configDir, config.macos.dmgDir, "macos");
    const filePath = path.join(directory, fileName);
    try {
      if (!(await lstat(filePath)).isFile()) return null;
    } catch {
      return null;
    }
    return this.readLocalAsset(filePath, {
      extension: fileName.toLowerCase().endsWith(".zip") ? ".zip" : ".dmg",
      downloadUrl: `/macos/update-download?fileName=${encodeURIComponent(fileName)}`,
    });
  }

  private async resolveMacosBetaAsset(): Promise<LocalDistributionAsset | null> {
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.macos?.enabled !== true) return null;
    const directory = resolveConfiguredDir(configDir, config.macos.dmgDir, "macos");
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && MACOS_UPDATE_FILE_PATTERN.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        filePath: path.join(directory, entry.name),
        fileStat: await stat(path.join(directory, entry.name)),
      })));
    candidates.sort((a, b) => compareDistributionFiles(
      { name: a.name, mtimeMs: a.fileStat.mtimeMs, version: extractArtifactVersion(a.name, path.extname(a.name)) },
      { name: b.name, mtimeMs: b.fileStat.mtimeMs, version: extractArtifactVersion(b.name, path.extname(b.name)) },
      compareWandInstallOrder,
      compareMacosFormatTieBreak,
    ));
    const selected = candidates[0];
    if (!selected) return null;
    return {
      fileName: selected.name,
      filePath: selected.filePath,
      size: selected.fileStat.size,
      updatedAt: selected.fileStat.mtime.toISOString(),
      version: extractArtifactVersion(selected.name, path.extname(selected.name)),
      downloadUrl: `/macos/update-download?fileName=${encodeURIComponent(selected.name)}`,
      source: "local",
    };
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

  async resolveLatestIpa(): Promise<ResolvedDistributionAsset | null> {
    const localIpa = await this.resolveIosDownload();
    if (localIpa?.version) {
      return {
        version: localIpa.version,
        downloadUrl: localIpa.downloadUrl,
        fileName: localIpa.fileName,
        size: localIpa.size,
        source: "local",
      };
    }
    const github = await this.fetchGitHubAsset(".ipa");
    return github ? { ...github, source: "github" } : null;
  }

  async resolveIosDownload(): Promise<LocalDistributionAsset | null> {
    await this.refreshConfig();
    const { config, configDir } = this.options;
    if (config.ios?.enabled !== true) return null;
    return this.resolveLocalAsset({
      directory: resolveConfiguredDir(configDir, config.ios.ipaDir, "ios"),
      extension: ".ipa",
      configuredFile: config.ios.currentIpaFile,
      downloadUrl: "/ios/download",
      compareVersions: compareWandInstallOrder,
    });
  }

  async getSettings(): Promise<DistributionSettings> {
    const [localApk, githubApk, localDmg, githubDmg, localIpa, githubIpa] = await Promise.all([
      this.resolveAndroidDownload("beta"),
      this.fetchGitHubAsset(".apk"),
      this.resolveMacosDownload(),
      this.fetchGitHubAsset(".dmg"),
      this.resolveIosDownload(),
      this.fetchGitHubAsset(".ipa"),
    ]);
    const apkDir = resolveConfiguredDir(this.options.configDir, this.options.config.android?.apkDir, "android");
    const dmgDir = resolveConfiguredDir(this.options.configDir, this.options.config.macos?.dmgDir, "macos");
    const ipaDir = resolveConfiguredDir(this.options.configDir, this.options.config.ios?.ipaDir, "ios");
    return {
      androidApk: this.buildSettings("apk", apkDir, this.options.config.android?.enabled === true, localApk, githubApk),
      macosDmg: this.buildSettings("dmg", dmgDir, this.options.config.macos?.enabled === true, localDmg, githubDmg),
      iosIpa: this.buildSettings("ipa", ipaDir, this.options.config.ios?.enabled === true, localIpa, githubIpa),
    };
  }

  private readonly sha256Cache = new Map<string, { key: string; digest: string }>();

  /**
   * 计算本地分发资产的 SHA-256（hex），供下载路由写入 X-APK-Sha256 响应头。
   * 计算失败返回 null，调用方按无哈希处理。
   */
  async computeAssetSha256(asset: LocalDistributionAsset): Promise<string | null> {
    try {
      const fileStat = await stat(asset.filePath);
      return await this.computeLocalFileSha256(asset.filePath, fileStat.size, fileStat.mtimeMs);
    } catch {
      return null;
    }
  }

  /**
   * 计算本地分发文件的 SHA-256（hex）。按 path + size + mtime 缓存：更新检查
   * 可能被多个客户端频繁触发，避免每次都全量读盘。
   */
  private async computeLocalFileSha256(filePath: string, size: number, mtimeMs: number): Promise<string> {
    const key = `${size}:${mtimeMs}`;
    const cached = this.sha256Cache.get(filePath);
    if (cached && cached.key === key) return cached.digest;
    const digest = await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
    this.sha256Cache.set(filePath, { key, digest });
    return digest;
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
    const ios = asRecord(raw.ios);
    if (ios) {
      config.ios = { ...(config.ios ?? {}) };
      if (typeof ios.enabled === "boolean") config.ios.enabled = ios.enabled;
      if (Object.hasOwn(ios, "ipaDir")) {
        config.ios.ipaDir = typeof ios.ipaDir === "string" && ios.ipaDir.trim() ? ios.ipaDir.trim() : "ios";
      }
      if (Object.hasOwn(ios, "currentIpaFile")) {
        config.ios.currentIpaFile = typeof ios.currentIpaFile === "string" ? ios.currentIpaFile.trim() : "";
      }
    }
  }

  private async resolveLocalAsset(options: {
    directory: string;
    extension: ".apk" | ".dmg" | ".ipa" | ".zip";
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

    candidates.sort((a, b) => compareLocalAssetCandidates(
      { name: a.entry.name, mtimeMs: a.fileStat.mtimeMs },
      { name: b.entry.name, mtimeMs: b.fileStat.mtimeMs },
      options.extension,
      options.compareVersions,
    ));
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
    extension: ".apk" | ".dmg" | ".ipa" | ".zip";
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

  private async fetchGitHubAsset(extension: ".apk" | ".dmg" | ".ipa"): Promise<GitHubDistributionAsset | null> {
    const cached = this.githubCache.get(extension);
    if (cached && this.now() - cached.timestamp < GITHUB_CACHE_TTL_MS) return cached.asset;
    try {
      const hit = await this.fetchGitHubReleaseAsset(extension);
      if (!hit) return cached?.asset ?? null;
      const version = extractArtifactVersion(hit.asset.name, extension)
        ?? extractArtifactVersion(hit.tagName, extension)
        ?? hit.tagName.replace(/^v/, "");
      const sha256 = parseGithubDigest(hit.asset.digest);
      const asset: GitHubDistributionAsset = {
        version,
        downloadUrl: hit.asset.browser_download_url,
        fileName: hit.asset.name,
        size: hit.asset.size,
        ...(sha256 ? { sha256 } : {}),
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
      assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string }>;
    }>;
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const asset = release.assets.find((candidate) => candidate.name.toLowerCase().endsWith(extension));
      if (asset) return { tagName: release.tag_name, body: release.body, asset };
    }
    return null;
  }

  private buildSettings(
    kind: "apk" | "dmg" | "ipa",
    directory: string,
    enabled: boolean,
    local: LocalDistributionAsset | null,
    github: GitHubDistributionAsset | null,
  ): Record<string, unknown> {
    let selected = local
      ? { ...local, source: "local" as const }
      : github
        ? { ...github, updatedAt: null, source: "github" as const }
        : null;
    if (kind === "apk" && selected?.source === "github" && github) {
      selected = {
        ...selected,
        fileName: sanitizeApkFileName(github.fileName),
        downloadUrl: githubApkProxyPath(),
      };
    }
    const hasKey = kind === "apk" ? "hasApk" : kind === "dmg" ? "hasDmg" : "hasIpa";
    const dirKey = kind === "apk" ? "apkDir" : kind === "dmg" ? "dmgDir" : "ipaDir";
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
