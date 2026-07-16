import type {
  RestartOverlayConfig,
  RestartOverlayPresentation,
  RestartOverlaySnapshot,
  RestartOverlayTarget,
  RestartReadiness,
} from "./types";

export function normalizeRestartVersion(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/^v/, "").split("+")[0]
    : "";
}

export function evaluateRestartReadiness(
  target: RestartOverlayTarget,
  config: RestartOverlayConfig,
): RestartReadiness {
  const previousInstanceId = target.previousInstanceId.trim();
  const expectedVersion = normalizeRestartVersion(target.expectedVersion);
  const currentInstanceId = config.serverInstanceId.trim();
  const currentVersion = normalizeRestartVersion(config.packageVersion || config.currentVersion);
  const instanceReady = !previousInstanceId
    || (currentInstanceId.length > 0 && currentInstanceId !== previousInstanceId);
  const versionReady = !expectedVersion || currentVersion === expectedVersion;
  return {
    ready: instanceReady && versionReady,
    instanceReady,
    versionReady,
    currentInstanceId,
    currentVersion,
  };
}

function waitingStatus(snapshot: RestartOverlaySnapshot): string {
  if (snapshot.lastError) {
    return `服务暂不可用，正在继续等待（${snapshot.attempts}/${snapshot.maxAttempts}）…`;
  }
  if (snapshot.attempts === 0) {
    return snapshot.mode === "auto-update"
      ? "正在等待更新完成并重启服务…"
      : "正在等待服务重新启动…";
  }
  if (!snapshot.readiness.instanceReady && !snapshot.readiness.versionReady) {
    return `正在等待新服务实例和目标版本（${snapshot.attempts}/${snapshot.maxAttempts}）…`;
  }
  if (!snapshot.readiness.instanceReady) {
    return `目标版本已就绪，正在等待新服务实例（${snapshot.attempts}/${snapshot.maxAttempts}）…`;
  }
  if (!snapshot.readiness.versionReady) {
    const expected = snapshot.target.expectedVersion || snapshot.latestVersion || "目标版本";
    return `新服务已启动，正在等待版本 ${expected}（${snapshot.attempts}/${snapshot.maxAttempts}）…`;
  }
  return `正在等待服务就绪（${snapshot.attempts}/${snapshot.maxAttempts}）…`;
}

export function restartOverlayPresentation(
  snapshot: RestartOverlaySnapshot,
): RestartOverlayPresentation {
  const isAutoUpdate = snapshot.mode === "auto-update";
  const title = isAutoUpdate
    ? "自动更新中"
    : snapshot.target.expectedVersion
      ? "正在完成更新"
      : "服务正在重启";
  const description = isAutoUpdate
    ? `${snapshot.currentVersion || "-"} → ${snapshot.latestVersion || "-"}\n正在下载并安装新版本，完成后将自动重启。`
    : snapshot.target.expectedVersion
      ? "安装完成并启动新版本后将自动刷新页面。"
      : "服务恢复后将自动刷新页面。";

  let liveStatus = "";
  if (snapshot.phase === "checking") {
    liveStatus = `正在检查服务状态（${snapshot.attempts}/${snapshot.maxAttempts}）…`;
  } else if (snapshot.phase === "ready") {
    liveStatus = "新服务和目标版本均已就绪，正在刷新页面…";
  } else if (snapshot.phase === "timed-out") {
    liveStatus = "等待服务重启超时，请手动刷新页面。";
  } else if (snapshot.phase === "waiting") {
    liveStatus = waitingStatus(snapshot);
  }

  return { title, description, liveStatus };
}
