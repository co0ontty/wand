import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Express, Request, RequestHandler, Response } from "express";

import type { GitHubApkDownload } from "./distribution-manager.js";
import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";
import type { ModelCatalogService } from "./models.js";
import type { PackageUpdateInfo, UpdateChannel } from "./npm-update-utils.js";
import {
  checkProviderCliUpdates,
  updateProviderClis,
  verifyProviderCliUpdateResults,
  type ProviderCliId,
  type ProviderCliUpdateStatus,
} from "./provider-cli-updater.js";
import { streamFileWithRange } from "./server-file-routes.js";
import type { WandStorage } from "./storage.js";
import type { WandConfig } from "./types.js";
import { compareApkInstallOrder, compareSemver } from "./version-utils.js";
import { canUseDetachedUpdateHelper, startDetachedUpdateHelper } from "./update-helper.js";

interface DownloadAsset {
  fileName: string;
  filePath: string;
  size: number;
}

interface ResolvedUpdateAsset {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  source: "local" | "github";
  releaseNotes?: string;
  sha256?: string;
}

export interface PublicUpdateRoutesDependencies {
  resolveLatestApk(channel: "stable" | "beta"): Promise<ResolvedUpdateAsset | null>;
  resolveAndroidDownload(channel: "stable" | "beta"): Promise<DownloadAsset | null>;
  /** GitHub 来源由服务端代拉，避免手机直连 CDN。测试 stub 可不实现。 */
  resolveGitHubApkDownload?(): Promise<GitHubApkDownload | null>;
  /** Beta 包下发时清理分发目录，只保留最新一个 APK（可选，测试 stub 可不实现）。 */
  pruneAndroidApkDirectory?(keepFileName?: string): Promise<{ deleted: string[]; freedBytes: number }>;
  /** 计算本地分发文件的 SHA-256（hex）；失败返回 null，下载响应不带哈希头。 */
  computeAssetSha256(asset: DownloadAsset): Promise<string | null>;
  resolveLatestDmg(): Promise<ResolvedUpdateAsset | null>;
  resolveMacosDownload(): Promise<DownloadAsset | null>;
  resolveLatestIpa(): Promise<ResolvedUpdateAsset | null>;
  resolveIosDownload(): Promise<DownloadAsset | null>;
}

const GITHUB_PROXY_TIMEOUT_MS = 5 * 60 * 1000;

async function proxyGitHubApk(
  _req: Request,
  res: Response,
  asset: GitHubApkDownload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let remote: globalThis.Response;
  try {
    remote = await fetchImpl(asset.remoteUrl, {
      headers: {
        "User-Agent": "wand-server",
        Accept: "application/octet-stream",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(GITHUB_PROXY_TIMEOUT_MS),
    });
  } catch (error) {
    res.status(502).json({ error: getErrorMessage(error, "从 GitHub 下载安装包失败。") });
    return;
  }
  if (!remote.ok || !remote.body) {
    res.status(502).json({ error: `从 GitHub 下载安装包失败（HTTP ${remote.status}）。` });
    return;
  }
  const remoteLength = Number(remote.headers.get("content-length"));
  const size = Number.isFinite(remoteLength) && remoteLength > 0 ? remoteLength : asset.size;
  res.status(200);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(asset.fileName)}"`);
  if (size > 0) res.setHeader("Content-Length", String(size));
  if (asset.sha256) res.setHeader("X-APK-Sha256", asset.sha256);
  try {
    await pipeline(Readable.fromWeb(remote.body as import("node:stream/web").ReadableStream), res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({ error: getErrorMessage(error, "从 GitHub 下载安装包失败。") });
      return;
    }
    res.destroy();
  }
}

export function registerPublicUpdateRoutes(app: Express, deps: PublicUpdateRoutesDependencies): void {
  app.get("/api/android-apk-update", asyncRoute(async (req, res) => {
    const currentVersion = typeof req.query.currentVersion === "string" ? req.query.currentVersion.trim() : "";
    if (!currentVersion) {
      res.status(400).json({ error: "Missing currentVersion query parameter." });
      return;
    }
    const channel = req.query.channel === "beta" ? "beta" : "stable";
    const latest = await deps.resolveLatestApk(channel);
    if (!latest) {
      res.json({ updateAvailable: false, currentVersion, latestVersion: null, downloadUrl: null, source: null, channel });
      return;
    }
    // APK 的 versionCode 约定是：X.Y.Z < X.Y.Z-debug.* < X.Y.(Z+1)。
    // 不能使用标准 SemVer（它会把 prerelease 判为低于同号正式版），否则刚从
    // tag 构建的 Beta 包对已安装 X.Y.Z 的设备永远不可见。
    const updateAvailable = compareApkInstallOrder(latest.version, currentVersion) > 0;
    res.json({
      updateAvailable,
      currentVersion,
      latestVersion: latest.version,
      downloadUrl: updateAvailable ? latest.downloadUrl : null,
      fileName: updateAvailable ? latest.fileName : null,
      size: updateAvailable ? latest.size : null,
      source: latest.source,
      channel,
      releaseNotes: updateAvailable ? (latest.releaseNotes ?? null) : null,
      // 本地文件哈希或 GitHub Release digest；客户端下载后校验。
      sha256: updateAvailable ? (latest.sha256 ?? null) : null,
    });
  }));

  app.get("/android/download", asyncRoute(async (req, res) => {
    if (req.query.source === "github") {
      const remote = deps.resolveGitHubApkDownload ? await deps.resolveGitHubApkDownload() : null;
      if (!remote) {
        res.status(404).json({ error: "当前没有可下载的 GitHub APK 文件。" });
        return;
      }
      await proxyGitHubApk(req, res, remote);
      return;
    }
    const channel = req.query.channel === "beta" ? "beta" : "stable";
    const asset = await deps.resolveAndroidDownload(channel);
    if (!asset) {
      res.status(404).json({ error: "当前没有可下载的 APK 文件。" });
      return;
    }
    // Beta 包下发时顺手清理分发目录：debug 构建每次都带独立时间戳版本号，
    // 不清理会按构建次数无限堆积。只保留最新一个；正在下发的文件与
    // currentApkFile 固定指向的文件不会被删。清理失败不阻断本次下载。
    if (channel === "beta" && deps.pruneAndroidApkDirectory) {
      try {
        const pruned = await deps.pruneAndroidApkDirectory(asset.fileName);
        if (pruned.deleted.length > 0) {
          process.stdout.write(`[wand] 已清理旧版安装包：${pruned.deleted.join(", ")}`
            + `（释放 ${(pruned.freedBytes / 1024 / 1024).toFixed(1)} MB）\n`);
        }
      } catch (error) {
        process.stdout.write(`[wand] 清理旧版安装包失败：${getErrorMessage(error)}\n`);
      }
    }
    // 响应头携带实际发送字节的 SHA-256：check 与 download 之间 APK 目录若被
    // 重新构建/覆盖，客户端以响应头为准，避免用过期 check 快照误报校验失败。
    const headers: Record<string, string> = {};
    const sha256 = await deps.computeAssetSha256(asset).catch(() => null);
    if (sha256) headers["X-APK-Sha256"] = sha256;
    streamFileWithRange(req, res, {
      filePath: asset.filePath,
      size: asset.size,
      contentType: "application/vnd.android.package-archive",
      disposition: `attachment; filename="${encodeURIComponent(asset.fileName)}"`,
      headers,
      readErrorMessage: "读取 APK 文件失败。",
    });
  }));

  app.get("/api/macos-dmg-update", asyncRoute(async (req, res) => {
    const currentVersion = typeof req.query.currentVersion === "string" ? req.query.currentVersion.trim() : "";
    if (!currentVersion) {
      res.status(400).json({ error: "Missing currentVersion query parameter." });
      return;
    }
    const latest = await deps.resolveLatestDmg();
    if (!latest) {
      res.json({ updateAvailable: false, currentVersion, latestVersion: null, downloadUrl: null, source: null });
      return;
    }
    const updateAvailable = compareSemver(latest.version, currentVersion) > 0;
    res.json({
      updateAvailable,
      currentVersion,
      latestVersion: latest.version,
      downloadUrl: updateAvailable ? latest.downloadUrl : null,
      fileName: updateAvailable ? latest.fileName : null,
      size: updateAvailable ? latest.size : null,
      source: latest.source,
    });
  }));

  app.get("/macos/download", asyncRoute(async (req, res) => {
    const asset = await deps.resolveMacosDownload();
    if (!asset) {
      res.status(404).json({ error: "当前没有可下载的 DMG 文件。" });
      return;
    }
    streamFileWithRange(req, res, {
      filePath: asset.filePath,
      size: asset.size,
      contentType: "application/x-apple-diskimage",
      disposition: `attachment; filename="${encodeURIComponent(asset.fileName)}"`,
      readErrorMessage: "读取 DMG 文件失败。",
    });
  }));

  app.get("/ios/download", asyncRoute(async (req, res) => {
    const asset = await deps.resolveIosDownload();
    if (!asset) {
      res.status(404).json({ error: "当前没有可下载的 IPA 文件。" });
      return;
    }
    streamFileWithRange(req, res, {
      filePath: asset.filePath,
      size: asset.size,
      contentType: "application/octet-stream",
      disposition: `attachment; filename="${encodeURIComponent(asset.fileName)}"`,
      readErrorMessage: "读取 IPA 文件失败。",
    });
  }));
}

export class ServerUpdateState {
  providerCliUpdateCache: { items: ProviderCliUpdateStatus[]; checkedAt: string } | null = null;
  providerCliUpdateInFlight = false;
  updateInFlight = false;
}

export async function refreshProviderCliUpdateState(
  state: ServerUpdateState,
  config: WandConfig,
): Promise<{ items: ProviderCliUpdateStatus[]; checkedAt: string }> {
  const items = await checkProviderCliUpdates({ inheritEnv: config.inheritEnv !== false });
  const result = { items, checkedAt: new Date().toISOString() };
  state.providerCliUpdateCache = result;
  return result;
}

export interface AdminUpdateRoutesDependencies {
  storage: WandStorage;
  config: WandConfig;
  configPath: string;
  requireAdmin: RequestHandler;
  state: ServerUpdateState;
  getDistributionSettings(): Promise<{ androidApk: Record<string, unknown>; macosDmg: Record<string, unknown>; iosIpa: Record<string, unknown> }>;
  modelCatalog: ModelCatalogService;
  getUpdateChannel(): UpdateChannel;
  checkLatestPackageVersion(channel: UpdateChannel, forceRefresh?: boolean): Promise<PackageUpdateInfo>;
  buildInfo: { commit: string | null; builtAt: string | null; channel: string | null };
  serverInstanceId: string;
  emitSystemNotification(data: Record<string, unknown>): void;
}

export function registerAdminUpdateRoutes(app: Express, deps: AdminUpdateRoutesDependencies): void {
  const { state, config, storage, requireAdmin } = deps;

  app.get("/api/android-apk", requireAdmin, asyncRoute(async (_req, res) => {
    res.json((await deps.getDistributionSettings()).androidApk);
  }));
  app.get("/api/macos-dmg", requireAdmin, asyncRoute(async (_req, res) => {
    res.json((await deps.getDistributionSettings()).macosDmg);
  }));
  app.get("/api/ios-ipa", requireAdmin, asyncRoute(async (_req, res) => {
    res.json((await deps.getDistributionSettings()).iosIpa);
  }));

  app.get("/api/provider-cli-updates", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const force = req.query.refresh === "1" || !state.providerCliUpdateCache;
      const data = force
        ? await refreshProviderCliUpdateState(state, config)
        : state.providerCliUpdateCache!;
      res.json({
        ...data,
        updating: state.providerCliUpdateInFlight,
        autoUpdate: storage.getConfigValue("autoUpdateProviderClis") === "true",
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "检查 CLI 更新失败。") });
    }
  }));

  app.post("/api/provider-cli-updates", requireAdmin, asyncRoute(async (req, res) => {
    if (state.providerCliUpdateInFlight || state.updateInFlight) {
      res.status(409).json({ error: "CLI 更新正在进行中，请稍候。" });
      return;
    }
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = rawIds.filter((value: unknown): value is ProviderCliId => value === "claude" || value === "codex" || value === "opencode" || value === "qoder" || value === "pi");
    state.providerCliUpdateInFlight = true;
    try {
      const before = await refreshProviderCliUpdateState(state, config);
      const commandResults = await updateProviderClis(before.items, ids.length ? ids : undefined, {
        inheritEnv: config.inheritEnv !== false,
        onLog: (line) => process.stdout.write(`[wand] ${line}\n`),
      });
      const after = await refreshProviderCliUpdateState(state, config);
      const results = verifyProviderCliUpdateResults(commandResults, after.items);
      // Model discovery is server-owned and persisted; clients only consume
      // the latest snapshot after a CLI update.
      void deps.modelCatalog.refresh().catch(() => {});
      res.json({ ok: results.every((item) => item.ok), results, ...after, autoUpdate: storage.getConfigValue("autoUpdateProviderClis") === "true" });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "更新 CLI 失败。") });
    } finally {
      state.providerCliUpdateInFlight = false;
    }
  }));

  app.get("/api/check-update", requireAdmin, asyncRoute(async (_req, res) => {
    try {
      const info = await deps.checkLatestPackageVersion(deps.getUpdateChannel(), true);
      res.json({
        ...info,
        build: {
          ...deps.buildInfo,
          shortCommit: deps.buildInfo.commit ? deps.buildInfo.commit.slice(0, 7) : null,
        },
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "检查更新失败。") });
    }
  }));

  app.post("/api/update", requireAdmin, asyncRoute(async (_req, res) => {
    if (state.updateInFlight || state.providerCliUpdateInFlight) {
      res.status(409).json({ error: "更新正在进行中，请稍候。" });
      return;
    }
    state.updateInFlight = true;
    try {
      const info = await deps.checkLatestPackageVersion(deps.getUpdateChannel(), true);
      if (!info.latest) {
        res.status(502).json({ error: "无法连接到 npm registry。" });
        return;
      }
      if (!canUseDetachedUpdateHelper()) {
        res.status(500).json({ error: "当前平台暂不支持 Web 异步更新，请在终端运行 install.sh 更新。" });
        return;
      }
      const helper = startDetachedUpdateHelper({
        installSpec: info.installSpec,
        configPath: deps.configPath,
        parentPid: process.pid,
        cliArgs: process.argv.slice(2),
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 300000,
      });
      if (!helper.started) {
        res.status(500).json({ error: helper.message, detail: `script=${helper.scriptPath}\nlog=${helper.logPath}` });
        return;
      }
      process.stdout.write(`[wand] ${helper.message}\n`);
      deps.emitSystemNotification({
        kind: "auto-update-restart",
        current: info.current,
        latest: info.latest,
        previousInstanceId: deps.serverInstanceId,
      });
      res.json({
        ok: true,
        message: info.updateAvailable ? `已开始更新到 ${info.latest}` : `已开始重新安装 ${info.latest}`,
        restartRequired: false,
        detachedUpdate: true,
        version: info.latest,
        previousInstanceId: deps.serverInstanceId,
        logPath: helper.logPath,
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "更新失败。") });
    } finally {
      state.updateInFlight = false;
    }
  }));
}
