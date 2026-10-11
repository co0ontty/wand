import { ThemePicker } from "./theme-picker";
import { OpenRouterSettingsPanel } from "./openrouter-panel";
import { DaemonUpdateNotice } from "../shell/daemon-update-notice";
import { ensureQrCodeLibrary } from "../../vendor-loader.js";
import { ModelGroupsSettingsPanel } from "./model-groups-panel";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as React from "react";
import { Card, Collapse, Empty, Form, Slider, Table, Tag, Upload } from "antd";
import { WandBadge, WandButton, WandDialogSurface, WandIcon, WandSearchField } from "../ui";
import { MOTION_DWELL_RESULT_SENTENCE_MS } from "../ui/motion-tokens";
import { settingsStore } from "./controller";
import { useSettingsDraft } from "./draft";
import {
  SettingsActionButton,
  SettingsField,
  SettingsGrid,
  SettingsSaveBar,
  SettingsSection,
  SettingsSelect,
  SettingsStatus,
  SettingsTextInput,
  SettingsToggle,
} from "./fields";
import type {
  SettingsCardDefaults,
  SettingsAiInput,
  SettingsDistribution,
  SettingsDistributionKind,
  SettingsDistributionSource,
  SettingsEnvironmentPreview,
  SettingsGeneralInput,
  SettingsModelCatalog,
  SettingsModelOption,
  SettingsProviderCliResult,
  SettingsProviderCliStatus,
  SettingsProviderCliUpdates,
  SettingsRepository,
  SettingsRetentionSweep,
  SettingsSessionProvider,
  SettingsSnapshot,
  SettingsThinkingEffort,
  SettingsUserProfile,
  SettingsWebUpdate,
} from "./types";
import { failureMessage } from "../errors";
import { compactThinkingLabel, dynamicThinkingChoices } from "../../thinking-efforts";
import { MODEL_CATALOG_DEFAULT_VALUE } from "../model-catalog";
import { AGENT_TOOL_OPTIONS } from "../../provider-identity";
import { normalizeModels } from "./repository";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import { useSiliconEmployees } from "../agents/employee-repository";
import { UserAvatarPicker } from "../agents/user-avatar-picker";
import { SystemAiOwnerSummary } from "./system-ai-owner";
import { isSystemSiliconEmployee } from "../../../ai-team-types.js";
import {
  DEFAULT_TASK_AUTO_ARCHIVE_DAYS,
  DEFAULT_TASK_AUTO_DELETE_DAYS,
  normalizeTaskRetention,
  TASK_RETENTION_MAX_DAYS,
  TASK_RETENTION_MIN_DAYS,
  type TaskRetentionSettings,
} from "../../../task-retention.js";
import { DEFAULT_USER_DISPLAY_NAME, USER_PROFILE_NAME_MAX } from "../../../user-profile.js";

export interface SettingsTabProps {
  snapshot: SettingsSnapshot;
  repository: SettingsRepository;
  refresh(): Promise<void>;
  setSnapshot: Dispatch<SetStateAction<SettingsSnapshot | null>>;
  toast(message: string, tone?: "info" | "success" | "warning" | "error"): void;
  showRestart(): void;
}

type StatusTone = "info" | "success" | "warning" | "error";

function formatBytes(size: number | null): string {
  if (size == null || !Number.isFinite(size)) return "-";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function versionParts(value: string | null): number[] {
  const match = value?.match(/\d+(?:\.\d+){1,3}/)?.[0];
  return match ? match.split(".").map(Number) : [];
}

function isNewerVersion(candidate: string | null, current: string | null): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  if (!left.length || !right.length) return true;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return false;
}

function ConnectCodePanel({
  code,
  repository,
  toast,
}: {
  code: string;
  repository: SettingsRepository;
  toast: SettingsTabProps["toast"];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrError, setQrError] = useState("");
  const [qrAttempt, setQrAttempt] = useState(0);
  const [qrLoading, setQrLoading] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!code || !canvas) {
      setQrError("");
      setQrLoading(false);
      return;
    }
    let cancelled = false;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setQrError("");
    setQrLoading(true);
    void ensureQrCodeLibrary().then((library) => {
      if (cancelled) return;
      library.toCanvas(canvas, code, {
        width: 220,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#1f1b17", light: "#ffffff" },
      }, (error: unknown) => {
        if (cancelled) return;
        setQrLoading(false);
        if (error) setQrError("二维码生成失败，可复制连接码或重试。");
      });
    }).catch(() => {
      if (cancelled) return;
      setQrLoading(false);
      setQrError("二维码加载或生成失败，可复制连接码或重试。");
    });
    return () => { cancelled = true; };
  }, [code, qrAttempt]);

  async function copyCode() {
    if (!code) return;
    await repository.execute({ type: "clipboard.copy", text: code });
    toast("连接码已复制", "success");
  }

  return (
    <SettingsSection title="App 连接码" description="用 Wand App 扫码或粘贴连接码；修改密码后会失效。">
      {code ? (
        <div className="wand-settings-library-connect">
          <div className="wand-settings-library-connect-qr" data-testid="settings-connect-qr">
            <canvas ref={canvasRef} aria-label="App 连接二维码" />
          </div>
          {qrLoading ? <SettingsStatus tone="info">正在生成连接二维码…</SettingsStatus> : null}
          {qrError ? <SettingsStatus tone="warning">{qrError}<WandButton kind="ghost" size="small" onClick={() => setQrAttempt((attempt) => attempt + 1)}>重试二维码</WandButton></SettingsStatus> : null}
          <div className="wand-settings-library-connect-code-row">
            <code className="wand-settings-library-connect-code" aria-label="App 连接码">{code}</code>
            <WandButton kind="secondary" onClick={() => void copyCode()}>复制连接码</WandButton>
          </div>
        </div>
      ) : (
        <code className="wand-settings-library-connect-code" aria-label="App 连接码">暂不可用</code>
      )}
    </SettingsSection>
  );
}

function DistributionSection({
  kind,
  title,
  distribution,
  currentVersion,
  repository,
  toast,
}: {
  kind: SettingsDistributionKind;
  title: string;
  distribution: SettingsDistribution;
  currentVersion: string | null;
  repository: SettingsRepository;
  toast: SettingsTabProps["toast"];
}) {
  const assets = (["github", "local"] as SettingsDistributionSource[])
    .map((source) => ({ source, asset: distribution[source] }))
    .filter((entry) => entry.asset !== null);
  if (!distribution.enabled && assets.length === 0 && !currentVersion) return null;
  return (
    <SettingsSection title={title} description={currentVersion ? `当前 App 版本：${currentVersion}` : "客户端下载与版本信息"}>
      {assets.length ? assets.map(({ source, asset }) => {
        const installable = !currentVersion || isNewerVersion(asset!.version, currentVersion);
        const iosOta = kind === "ipa" && source === "local";
        return (
          <div className="wand-settings-library-download-row" key={source}>
            <div><strong>{source === "github" ? "线上版本" : "本地版本"}</strong><span>{asset!.version ? `v${asset!.version}` : asset!.fileName} · {formatBytes(asset!.size)}</span></div>
            <WandButton
              kind="secondary"
              disabled={!installable}
              aria-label={`${installable ? (iosOta ? "安装" : "下载") : "已安装"}${title}${source === "github" ? "线上版本" : "本地版本"}`}
              onClick={async () => {
                if (iosOta) {
                  const manifestUrl = `${window.location.origin}/ios/manifest.plist`;
                  const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
                  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
                  const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
                  if (iOS && safari) {
                    window.location.href = installUrl;
                  } else {
                    window.open("/ios/install", "_blank", "noopener");
                  }
                  toast(iOS ? "已打开 iOS 安装" : "请用 iPhone Safari 打开安装页", "info");
                  return;
                }
                await repository.execute({
                  type: "distribution.download",
                  kind,
                  source,
                  url: asset!.downloadUrl,
                  fileName: asset!.fileName,
                });
                toast("已开始下载", "info");
              }}
            >{installable ? (currentVersion ? (iosOta ? "安装更新" : "下载并安装") : (iosOta ? "安装" : "下载")) : "已安装"}</WandButton>
          </div>
        );
      }) : <div className="wand-settings-library-empty">暂无可用安装包</div>}
    </SettingsSection>
  );
}

export function AboutSettingsTab({ snapshot, repository, refresh, toast, showRestart }: SettingsTabProps) {
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [update, setUpdate] = useState<SettingsWebUpdate | null>(null);
  const about = snapshot.about;

  async function action(name: string, task: () => Promise<void>, success?: string): Promise<boolean> {
    setPending(name);
    setStatus("");
    try {
      await task();
      if (success) { setStatus(success); setTone("success"); }
      return true;
    } catch (cause) {
      setStatus(failureMessage(cause, "操作失败。"));
      setTone("error");
      return false;
    } finally {
      setPending("");
    }
  }

  const cliItems = snapshot.providerCliUpdates?.items || [];
  const cliUpdates = cliItems.filter((item) => item.updateAvailable && item.updateSupported);

  return (
    <section className="wand-settings-library-panel" aria-label="关于 Wand">
      <header className="wand-settings-library-panel-heading">
        <h2>关于 Wand</h2><p>查看版本信息、更新状态和客户端连接方式。</p>
      </header>
      <DaemonUpdateNotice />
      <SettingsSection title="版本信息">
        <Table size="small" showHeader={false} pagination={false} rowKey="label"
          columns={[{ dataIndex: "label" }, { dataIndex: "value" }]}
          dataSource={[
            { label: "包名", value: about.packageName },
            { label: "当前版本", value: about.version },
            { label: "Node.js 要求", value: about.nodeVersion },
            ...(about.build.shortCommit ? [{ label: "构建", value: `${about.build.shortCommit}${about.build.channel ? ` · ${about.build.channel}` : ""}` }] : []),
            ...(about.repoUrl ? [{ label: "仓库地址", value: <a href={about.repoUrl} target="_blank" rel="noopener noreferrer">{about.repoUrl}</a> }] : []),
          ]} />
      </SettingsSection>

      {snapshot.access === "admin" ? (
        <>
          <SettingsSection title="保持在最新版本" description={`当前 ${about.version} · ${about.updateChannel === "beta" ? "Beta 通道" : "Stable 通道"}`}>
            <div className="wand-settings-library-update-deck">
              <span className="wand-settings-library-update-deck-icon" aria-hidden="true"><WandIcon name="refresh" size={18} strokeWidth={1.8}/></span>
              <div>
                <strong>检查并管理 Web 服务更新</strong>
                <span>{update?.latest || about.latestVersion ? "已获取可用版本信息" : "选择检查更新以获取最新版本。"}</span>
              </div>
              <span className={about.updateChannel === "beta" ? "wand-settings-library-update-channel is-beta" : "wand-settings-library-update-channel"}>
                {about.updateChannel === "beta" ? "BETA" : "STABLE"}
              </span>
            </div>
            <div className="wand-settings-library-about-list">
              <div><span>最新版本</span><strong>{update?.latest || about.latestVersion || "尚未检查"}</strong></div>
            </div>
            <SettingsToggle
              label="Beta 通道"
              description="接收测试版本，可能包含尚未稳定的功能。"
              checked={about.updateChannel === "beta"}
              disabled={!!pending}
              onCheckedChange={(checked) => void action("channel", async () => {
                const result = await repository.execute({ type: "updateChannel.set", channel: checked ? "beta" : "stable" });
                setUpdate(result.update);
                await refresh();
              }, "更新通道已切换。")}
            />
            <SettingsToggle
              label="自动更新 Web 服务"
              description="检测到新版本后自动下载安装并重启服务。"
              checked={snapshot.autoUpdate.web}
              disabled={!!pending}
              onCheckedChange={(enabled) => void action("auto-web", async () => {
                await repository.execute({ type: "autoUpdate.set", target: "web", enabled });
                await refresh();
              }, "自动更新偏好已保存。")}
            />
            <div className="wand-settings-library-button-row">
              <SettingsActionButton className="wand-settings-library-update-primary" pending={pending === "check"} kind="primary" onClick={() => action("check", async () => setUpdate(await repository.execute({ type: "webUpdate.check" })), "版本检查完成。")}>检查更新</SettingsActionButton>
              <SettingsActionButton pending={pending === "install"} kind="secondary" onClick={() => action("install", async () => { const result = await repository.execute({ type: "webUpdate.install" }); setStatus(result.message); }, undefined)}>更新或重新安装</SettingsActionButton>
              {snapshot.restartRequired ? <SettingsActionButton pending={pending === "restart"} kind="secondary" onClick={() => action("restart", async () => {
                try {
                  await repository.execute({ type: "server.restart" });
                } finally {
                  showRestart();
                }
              }, "服务正在重启…")}>重启服务</SettingsActionButton> : null}
            </div>
          </SettingsSection>

          <SettingsSection title="开发 CLI" description="服务端检测到的各开发 CLI 版本；显示「当前 → 最新」表示有新版本。">
            <div className="wand-settings-library-cli-list">
              {cliItems.map((item) => (
                <div key={item.id} title={cliStatusDetail(item)}><strong>{item.label}</strong><span>{cliStatusText(item)}</span></div>
              ))}
              {!cliItems.length ? <div className="wand-settings-library-empty">尚未检查 CLI 版本</div> : null}
            </div>
            <SettingsToggle
              label="自动更新开发 CLI"
              description="服务端定期检查并调用各 CLI 的官方更新器。"
              checked={snapshot.autoUpdate.cli}
              disabled={!!pending}
              onCheckedChange={(enabled) => void action("auto-cli", async () => {
                await repository.execute({ type: "autoUpdate.set", target: "cli", enabled });
                await refresh();
              }, "CLI 自动更新偏好已保存。")}
            />
            <div className="wand-settings-library-button-row">
              <SettingsActionButton pending={pending === "cli-check"} kind="secondary" onClick={() => action("cli-check", async () => { await repository.execute({ type: "cliUpdates.load", force: true }); await refresh(); }, "CLI 版本检查完成。")}>检查 CLI 更新</SettingsActionButton>
              {cliUpdates.length ? <SettingsActionButton pending={pending === "cli-install"} kind="primary" onClick={() => action("cli-install", async () => {
                const result = await repository.execute({ type: "cliUpdates.install", ids: cliUpdates.map((item) => item.id) });
                const summary = cliUpdateSummary(result);
                setStatus(summary.text);
                setTone(summary.ok ? "success" : "error");
                await refresh();
                if (!summary.ok) throw new Error(summary.text);
              }, undefined)}>快速更新 ({cliUpdates.length})</SettingsActionButton> : null}
            </div>
          </SettingsSection>
        </>
      ) : null}

      {snapshot.platform.kind === "browser" || snapshot.platform.kind === "android" ? (
        <DistributionSection kind="apk" title="Android App" distribution={about.androidApk} currentVersion={snapshot.platform.kind === "android" ? snapshot.platform.appVersion : null} repository={repository} toast={toast} />
      ) : null}
      {snapshot.platform.kind === "browser" || snapshot.platform.kind === "macos" ? (
        <DistributionSection kind="dmg" title="macOS App" distribution={about.macosDmg} currentVersion={snapshot.platform.kind === "macos" ? snapshot.platform.appVersion : null} repository={repository} toast={toast} />
      ) : null}
      {snapshot.platform.kind === "browser" || snapshot.platform.kind === "ios" ? (
        <DistributionSection kind="ipa" title="iOS App" distribution={about.iosIpa} currentVersion={snapshot.platform.kind === "ios" ? snapshot.platform.appVersion : null} repository={repository} toast={toast} />
      ) : null}

      {snapshot.access === "admin" ? (
        <ConnectCodePanel code={snapshot.connectCode?.code || ""} repository={repository} toast={toast} />
      ) : null}
      {status ? <SettingsStatus tone={tone}>{status}</SettingsStatus> : null}
    </section>
  );
}

export function GithubSettingsTab({ snapshot, repository, refresh, setSnapshot }: SettingsTabProps) {
  const [token, setToken] = useState("");
  const [apiUrl, setApiUrl] = useState(snapshot.github.apiUrl || "https://api.github.com");
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [enterpriseOpen, setEnterpriseOpen] = useState(Boolean(snapshot.github.apiUrl && snapshot.github.apiUrl !== "https://api.github.com"));

  useEffect(() => {
    setApiUrl(snapshot.github.apiUrl || "https://api.github.com");
    setToken("");
    setEnterpriseOpen(Boolean(snapshot.github.apiUrl && snapshot.github.apiUrl !== "https://api.github.com"));
  }, [snapshot.github]);

  async function connect(): Promise<boolean | void> {
    if (!token.trim()) {
      setStatus("请输入 GitHub Fine-grained Personal Access Token。");
      setTone("error");
      return;
    }
    setPending("connect");
    setStatus("");
    try {
      const next = await repository.execute({ type: "github.connect", value: { token, apiUrl: apiUrl.trim() || undefined } });
      setToken("");
      setSnapshot((current) => current ? { ...current, github: next } : current);
      setStatus(`已连接 GitHub 账号 ${next.username || ""}。`);
      setTone("success");
      await refresh();
      return true;
    } catch (cause) {
      setStatus(failureMessage(cause, "连接 GitHub 失败。"));
      setTone("error");
      return false;
    } finally {
      setPending("");
    }
  }

  async function disconnect(): Promise<boolean> {
    setPending("disconnect");
    setStatus("");
    try {
      await repository.execute({ type: "github.disconnect" });
      await refresh();
      setStatus("GitHub 已断开，已删除本地保存的 Token。");
      setTone("success");
      return true;
    } catch (cause) {
      setStatus(failureMessage(cause, "断开 GitHub 失败。"));
      setTone("error");
      return false;
    } finally {
      setPending("");
    }
  }

  const connector = snapshot.github;
  return (
    <section className="wand-settings-library-panel" aria-label="连接器">
      <header className="wand-settings-library-panel-heading">
        <h2>连接器</h2><p>当前支持 GitHub，用于仓库、Issue 和 Pull Request 的协作操作。</p>
      </header>
      <SettingsSection title="GitHub" description="使用 Fine-grained Token，建议只授权需要操作的仓库和权限。">
        <div className="wand-settings-library-update-deck">
          <span className="wand-settings-library-update-deck-icon" aria-hidden="true"><WandIcon name="git" size={18} strokeWidth={1.8}/></span>
          <div>
            <strong>{connector.connected ? `已连接：${connector.username || "GitHub 账号"}` : "尚未连接"}</strong>
            <span>{connector.connected ? `连接地址：${connector.apiUrl || "https://api.github.com"}` : "连接后可读取仓库、Issue、Pull Request，并执行创建和更新操作。"}</span>
          </div>
          <WandBadge tone={connector.connected ? "success" : "info"}>{connector.connected ? "已连接" : "未连接"}</WandBadge>
        </div>
        <SettingsGrid>
          <SettingsField label="Fine-grained Token" htmlFor="settings-github-token" hint="保存后不会再次显示；留空不会覆盖已有 Token。">
            <SettingsTextInput id="settings-github-token" type="password" autoComplete="new-password" value={token} disabled={!!pending} placeholder={connector.connected ? "输入新 Token 以轮换" : "github_pat_…"} onChange={setToken} />
          </SettingsField>
        </SettingsGrid>
        <Collapse activeKey={enterpriseOpen ? ["enterprise"] : []}
          onChange={(keys) => setEnterpriseOpen(keys.includes("enterprise"))}
          items={[{ key: "enterprise", label: "GitHub Enterprise / 高级连接", children:
            <SettingsField label="GitHub API 地址" htmlFor="settings-github-api-url" hint="GitHub.com 使用默认地址；只有连接自建 GitHub Enterprise 时才需要修改。">
              <SettingsTextInput id="settings-github-api-url" type="url" autoComplete="url" value={apiUrl} disabled={!!pending} placeholder="https://api.github.com" onChange={setApiUrl} />
            </SettingsField>
          }]} />
        {connector.connected && connector.scopes.length ? <SettingsStatus tone="info">Token 权限：{connector.scopes.join("、")}</SettingsStatus> : null}
        <div className="wand-settings-library-button-row">
          <SettingsActionButton pending={pending === "connect"} kind="primary" successLabel="已连接" onClick={() => connect()}>{connector.connected ? "验证并轮换 Token" : "连接 GitHub"}</SettingsActionButton>
          {connector.connected ? <SettingsActionButton pending={pending === "disconnect"} kind="secondary" successLabel="已断开" onClick={() => disconnect()}>断开并删除 Token</SettingsActionButton> : null}
        </div>
        <SettingsStatus tone="warning">
          Token 会加密保存在当前 Wand 配置目录的 SQLite 数据库中，不会写入 config.json，也不会回传到浏览器。创建 Token：<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub Fine-grained tokens</a>。
        </SettingsStatus>
      </SettingsSection>
      {status ? <SettingsStatus tone={tone}>{status}</SettingsStatus> : null}
    </section>
  );
}

const MODE_OPTIONS = [
  { value: "default", label: "默认" },
  { value: "assist", label: "辅助模式" },
  { value: "agent", label: "Agent" },
  { value: "agent-max", label: "Agent Max" },
  { value: "auto-edit", label: "自动编辑" },
  { value: "full-access", label: "完全访问" },
  { value: "native", label: "原生模式" },
  { value: "managed", label: "托管模式" },
] as const;

function generalFromSnapshot(snapshot: SettingsSnapshot): SettingsGeneralInput {
  const config = snapshot.config!;
  return {
    host: config.host,
    port: config.port,
    https: config.https,
    defaultMode: config.defaultMode,
    defaultCwd: config.defaultCwd,
    shell: config.shell,
    language: config.language,
    inheritEnv: config.inheritEnv,
    taskRetention: normalizeTaskRetention(config.taskRetention),
  };
}

function retentionDayError(value: number, label: string): string {
  if (!Number.isInteger(value) || value < TASK_RETENTION_MIN_DAYS || value > TASK_RETENTION_MAX_DAYS) {
    return `${label}必须是 ${TASK_RETENTION_MIN_DAYS}–${TASK_RETENTION_MAX_DAYS} 的整数。`;
  }
  return "";
}

function retentionSweepStatus(retention: SettingsRetentionSweep | undefined, error: string | undefined): string {
  if (error) return error.endsWith("。") ? error : `${error}。`;
  if (!retention) return "";
  const parts: string[] = [];
  if (retention.archivedTasks > 0) parts.push(`归档 ${retention.archivedTasks} 个任务`);
  if (retention.purgedTasks > 0) parts.push(`删除 ${retention.purgedTasks} 个任务`);
  if (retention.archivedSessions > 0) parts.push(`归档 ${retention.archivedSessions} 个会话`);
  if (retention.purgedSessions > 0) parts.push(`删除 ${retention.purgedSessions} 个会话`);
  if ((retention.purgedTeamRuns ?? 0) > 0) parts.push(`清理 ${retention.purgedTeamRuns} 个团队任务`);
  return parts.length
    ? `已按新设置重新扫描：${parts.join("，")}。`
    : "已按新设置重新扫描，没有需要处理的任务或会话。";
}

function EnvironmentDialog({ repository }: { repository: SettingsRepository }) {
  const controller = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
  const [preview, setPreview] = useState<SettingsEnvironmentPreview | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const loadSequence = useRef(0);
  const requestedReveal = useRef(false);

  const load = useCallback(async (reveal = false) => {
    const sequence = ++loadSequence.current;
    requestedReveal.current = reveal;
    setLoading(true);
    try {
      const next = await repository.execute({ type: "environment.load", reveal });
      if (sequence === loadSequence.current) {
        setPreview(next);
        setError("");
      }
    } catch (cause) {
      if (sequence === loadSequence.current) setError(failureMessage(cause, "环境变量加载失败。"));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    setPreview(null);
    setError("");
    setLoading(false);
    if (controller.nested === "environment") void load(false);
    return () => { loadSequence.current += 1; };
  }, [controller.nested, load]);

  const entries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (preview?.entries || []).filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
  }, [preview, search]);

  return (
    <WandDialogSurface
      open={controller.nested === "environment"}
      onOpenChange={(open) => { if (!open) settingsStore.setNested(null); }}
      title="将注入子进程的环境变量"
      description="这些变量会传给新启动的会话子进程，敏感值默认隐藏。"
      className="wand-settings-library-nested-dialog"
      overlayClassName="wand-settings-library-nested-overlay"
      headerClassName="wand-settings-library-header"
      titleClassName="wand-settings-library-title"
      descriptionClassName="wand-settings-library-description"
      closeLabel="关闭环境变量预览"
      testId="settings-environment-dialog"
    >
      <div className="wand-settings-library-env-toolbar">
        <WandSearchField
          value={search}
          label="搜索变量名"
          placeholder="搜索变量名"
          onValueChange={setSearch}
        />
        <SettingsToggle
          label="显示敏感值"
          description="临时请求服务端返回未掩码值"
          checked={preview?.reveal === true}
          disabled={loading}
          onCheckedChange={(checked) => void load(checked)}
        />
      </div>
      {error ? <SettingsStatus tone="error">
        {error}<WandButton size="small" disabled={loading} onClick={() => void load(requestedReveal.current)}>重新加载</WandButton>
      </SettingsStatus> : null}
      <Table size="small" pagination={false} loading={loading} rowKey="name"
        aria-label="子进程环境变量" dataSource={entries}
        locale={{ emptyText: search.trim() ? "没有匹配的变量" : "暂无环境变量" }}
        columns={[
          { title: "变量名", dataIndex: "name", render: (name: string) => <code>{name}</code> },
          { title: "值", dataIndex: "value", render: (value: string) => <span className="wand-settings-library-env-value">{value}</span> },
        ]} />
    </WandDialogSurface>
  );
}

export function GeneralSettingsTab({ snapshot, repository, refresh }: SettingsTabProps) {
  const [form, setForm, acceptSaved] = useSettingsDraft(generalFromSnapshot(snapshot));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [errors, setErrors] = useState<Record<string, string>>({});


  function update<K extends keyof SettingsGeneralInput>(key: K, value: SettingsGeneralInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  }

  function updateRetention<K extends keyof TaskRetentionSettings>(key: K, value: TaskRetentionSettings[K]) {
    setForm((current) => ({ ...current, taskRetention: { ...current.taskRetention, [key]: value } }));
    setErrors((current) => ({
      ...current,
      [key]: "",
      ...(key === "autoArchiveEnabled" ? { autoArchiveDays: "" } : {}),
      ...(key === "autoDeleteEnabled" ? { autoDeleteDays: "" } : {}),
    }));
  }

  async function save() {
    const nextErrors: Record<string, string> = {};
    if (!form.host.trim()) nextErrors.host = "Host 不能为空。";
    if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) nextErrors.port = "端口必须是 1–65535 的整数。";
    if (!form.shell.trim()) nextErrors.shell = "Shell 不能为空。";
    const archiveDays = retentionDayError(form.taskRetention.autoArchiveDays, "空闲天数");
    const deleteDays = retentionDayError(form.taskRetention.autoDeleteDays, "归档后天数");
    if (form.taskRetention.autoArchiveEnabled && archiveDays) nextErrors.autoArchiveDays = archiveDays;
    if (form.taskRetention.autoDeleteEnabled && deleteDays) nextErrors.autoDeleteDays = deleteDays;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setStatus("请修正标记的配置项。");
      setTone("error");
      return;
    }
    const taskRetention: TaskRetentionSettings = {
      autoArchiveEnabled: form.taskRetention.autoArchiveEnabled,
      autoDeleteEnabled: form.taskRetention.autoDeleteEnabled,
      autoArchiveDays: archiveDays ? DEFAULT_TASK_AUTO_ARCHIVE_DAYS : form.taskRetention.autoArchiveDays,
      autoDeleteDays: deleteDays ? DEFAULT_TASK_AUTO_DELETE_DAYS : form.taskRetention.autoDeleteDays,
    };
    setPending(true);
    setStatus("");
    try {
      const result = await repository.execute({ type: "general.save", value: { ...form, taskRetention } });
      acceptSaved(form, generalFromSnapshot({ ...snapshot, config: result.config }));
      const saved = result.restartRequired
        ? "配置已保存；Host、端口、HTTPS 或 Shell 的变化需要重启服务后生效。"
        : "基本配置已保存。";
      const scanned = retentionSweepStatus(result.retention, result.retentionError);
      setStatus(scanned ? `${saved}${scanned}` : saved);
      setTone(result.retentionError ? "warning" : result.restartRequired ? "warning" : "success");
      await refresh();
    } catch (cause) {
      setStatus(failureMessage(cause, "保存基本配置失败。"));
      setTone("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="wand-settings-library-panel" aria-label="基本配置">
      <header className="wand-settings-library-panel-heading">
        <h2>基本配置</h2><p>此页设置作用于当前 Wand 服务及其新建会话；保存会同时应用本页的保留策略。</p>
      </header>
      <SettingsSection title="服务连接（部署设置）" description="Host、端口和 HTTPS 保存后需重启服务才生效，可能改变浏览器和 App 的连接地址。">
        <SettingsGrid>
          <SettingsField label="Host" htmlFor="settings-host" error={errors.host}>
            <SettingsTextInput id="settings-host" value={form.host} invalid={!!errors.host} onChange={(value) => update("host", value)} />
          </SettingsField>
          <SettingsField label="端口" htmlFor="settings-port" error={errors.port}>
            <SettingsTextInput id="settings-port" type="number" min={1} max={65535} value={form.port} invalid={!!errors.port} onChange={(value) => update("port", Number(value))} />
          </SettingsField>
        </SettingsGrid>
        <SettingsToggle
          label="启用 HTTPS"
          description="使用服务端证书加密浏览器与服务之间的连接。"
          checked={form.https}
          onCheckedChange={(checked) => update("https", checked)}
        />
      </SettingsSection>

      <SettingsSection title="执行偏好" description="默认模式用于新会话；回复语言和环境配置在工具下一次启动时应用。">
        <SettingsGrid>
          <SettingsField label="默认模式">
            <SettingsSelect id="settings-default-mode" ariaLabel="默认执行模式" value={form.defaultMode} options={MODE_OPTIONS} onChange={(value) => update("defaultMode", value as SettingsGeneralInput["defaultMode"])} />
          </SettingsField>
          <SettingsField label="AI 回复语言" hint="指定 AI 回复语言，在工具下一次启动时应用；部分工具状态文案也跟随此偏好，网页尚未完整支持语言切换。">
            <SettingsSelect
              id="settings-language"
              ariaLabel="AI 回复语言"
              value={form.language === "zh-CN" ? "中文" : form.language === "en" ? "English" : form.language || "auto"}
              options={[{ value: "auto", label: "跟随工具默认" }, { value: "中文", label: "简体中文" }, { value: "English", label: "English" },
                ...(!["", "中文", "English", "zh-CN", "en"].includes(form.language) ? [{ value: form.language, label: form.language }] : [])]}
              onChange={(value) => update("language", value === "auto" ? "" : value)}
            />
          </SettingsField>
        </SettingsGrid>
        <SettingsToggle
          label="继承环境变量"
          description="复用系统默认 Shell 与服务进程的环境变量，传给 PTY 与结构化子进程；关闭后只注入最小运行环境。"
          checked={form.inheritEnv}
          onCheckedChange={(checked) => update("inheritEnv", checked)}
        />
        <WandButton kind="secondary" onClick={() => settingsStore.setNested("environment")}>查看将注入的环境变量</WandButton>
      </SettingsSection>

      <SettingsSection title="工作环境" description="默认目录用于新会话；Shell 修改需重启服务后生效。">
        <SettingsGrid>
          <SettingsField label="默认工作目录" htmlFor="settings-default-cwd">
            <SettingsTextInput id="settings-default-cwd" value={form.defaultCwd} placeholder="/home/user" onChange={(value) => update("defaultCwd", value)} />
          </SettingsField>
          <SettingsField label="Shell" htmlFor="settings-shell" error={errors.shell}>
            <SettingsTextInput id="settings-shell" value={form.shell} invalid={!!errors.shell} placeholder="/bin/zsh" onChange={(value) => update("shell", value)} />
          </SettingsField>
        </SettingsGrid>
      </SettingsSection>

      <SettingsSection title="任务与会话保留" description="看板任务、会话和已结束的团队运行共用此策略；正在处理工作的会跳过。保存本页后立即扫描。">
        <SettingsToggle
          label="自动归档空闲任务与会话"
          description="达到空闲天数后移入归档；空闲终端可能被停止。归档内容仍可恢复，手动归档不受影响。"
          checked={form.taskRetention.autoArchiveEnabled}
          onCheckedChange={(checked) => updateRetention("autoArchiveEnabled", checked)}
        />
        <SettingsToggle
          label="自动删除到期内容"
          description="删除超过保留天数的归档任务、会话及已结束团队运行；任务的 worktree 也会清理。删除后的内容无法恢复。"
          checked={form.taskRetention.autoDeleteEnabled}
          onCheckedChange={(checked) => updateRetention("autoDeleteEnabled", checked)}
        />
        <SettingsGrid>
          <SettingsField label="空闲天数" htmlFor="settings-task-archive-days" error={errors.autoArchiveDays} hint={`${TASK_RETENTION_MIN_DAYS}–${TASK_RETENTION_MAX_DAYS} 天`}>
            <SettingsTextInput
              id="settings-task-archive-days"
              type="number"
              min={TASK_RETENTION_MIN_DAYS}
              max={TASK_RETENTION_MAX_DAYS}
              value={Number.isFinite(form.taskRetention.autoArchiveDays) ? form.taskRetention.autoArchiveDays : ""}
              invalid={!!errors.autoArchiveDays}
              disabled={!form.taskRetention.autoArchiveEnabled}
              onChange={(value) => updateRetention("autoArchiveDays", value.trim() === "" ? Number.NaN : Number(value))}
            />
          </SettingsField>
          <SettingsField label="归档后天数" htmlFor="settings-task-delete-days" error={errors.autoDeleteDays} hint={`任务与会话从归档时间起算；已结束团队运行从最后活动起算。${TASK_RETENTION_MIN_DAYS}–${TASK_RETENTION_MAX_DAYS} 天。`}>
            <SettingsTextInput
              id="settings-task-delete-days"
              type="number"
              min={TASK_RETENTION_MIN_DAYS}
              max={TASK_RETENTION_MAX_DAYS}
              value={Number.isFinite(form.taskRetention.autoDeleteDays) ? form.taskRetention.autoDeleteDays : ""}
              invalid={!!errors.autoDeleteDays}
              disabled={!form.taskRetention.autoDeleteEnabled}
              onChange={(value) => updateRetention("autoDeleteDays", value.trim() === "" ? Number.NaN : Number(value))}
            />
          </SettingsField>
        </SettingsGrid>
        <SettingsStatus tone={form.taskRetention.autoDeleteEnabled ? "warning" : "info"}>
          点击“保存基本配置”后立即按当前策略扫描，即使本次只修改了其他字段。
          {form.taskRetention.autoDeleteEnabled
            ? `自动删除已开启：归档任务与会话满 ${retentionDayError(form.taskRetention.autoDeleteDays, "归档后天数") ? "设定" : form.taskRetention.autoDeleteDays} 天、已结束团队运行达到保留天数时可能立即删除。请在保存前核对天数。`
            : "自动删除已关闭；已归档内容会继续保留。"}
        </SettingsStatus>
      </SettingsSection>

      <SettingsSaveBar label="保存基本配置" pending={pending} onSave={() => void save()} status={status} tone={tone} />
      <EnvironmentDialog repository={repository} />
    </section>
  );
}

function aiFromSnapshot(snapshot: SettingsSnapshot): SettingsAiInput {
  const config = snapshot.config!;
  return {
    defaultModel: config.defaultModel,
    defaultCodexModel: config.defaultCodexModel,
    defaultOpenCodeModel: config.defaultOpenCodeModel,
    defaultGrokModel: config.defaultGrokModel,
    defaultQoderModel: config.defaultQoderModel,
    defaultPiModel: config.defaultPiModel,
    defaultGeminiModel: config.defaultGeminiModel,
    defaultProvider: config.defaultProvider,
    defaultThinkingEffort: config.defaultThinkingEffort,
  };
}

function ModelSuggestions({ id, models }: { id: string; models: SettingsModelOption[] }) {
  return (
    <datalist id={id}>
      {models.map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
    </datalist>
  );
}

/** CLI 工具下拉与任务指派 / 新建会话共用使用频率排序。 */
const SESSION_PROVIDER_OPTIONS: ReadonlyArray<{ value: SettingsSessionProvider; label: string }> =
  AGENT_TOOL_OPTIONS.filter((option) => option.engine !== "sdk")
    .map((option) => ({ value: option.provider, label: option.label }));

/** 目录还没回来时的四档。CLI 档位到达后换成原生列表。 */
const THINKING_EFFORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "off", label: "关闭（跟随模型默认）" },
  { value: "standard", label: "标准" },
  { value: "deep", label: "深入" },
  { value: "max", label: "最大" },
];

function providerThinkingSource(
  models: SettingsSnapshot["models"],
  provider: SettingsSessionProvider,
  modelId: string,
): { efforts: Array<{ effort: string; description?: string }>; defaultEffort?: string } {
  const list = providerModelSuggestions(models, provider);
  const selected = list.find((model) => model.id === modelId);
  const fallback = list.find((model) => model.id === "default");
  const match = selected?.reasoningEfforts?.length ? selected : fallback?.reasoningEfforts?.length ? fallback : null;
  if (match?.reasoningEfforts?.length) {
    return { efforts: match.reasoningEfforts, defaultEffort: match.defaultReasoningEffort };
  }
  return { efforts: models?.thinkingEfforts?.[provider] ?? [] };
}

/** 当前 CLI 报出的思考档位。已保存但不在列表里的值仍留在下拉里，避免显示空。 */
function thinkingEffortOptions(
  provider: SettingsSessionProvider,
  models: SettingsSnapshot["models"],
  modelId: string,
  current: SettingsThinkingEffort,
): ReadonlyArray<{ value: string; label: string }> {
  const source = providerThinkingSource(models, provider, modelId);
  const dynamic = dynamicThinkingChoices(provider, source.efforts, source.defaultEffort);
  const options = dynamic
    ? dynamic.map((choice) => ({
      value: choice.id,
      label: choice.id === "off" ? "关闭（跟随模型默认）" : compactThinkingLabel(choice.label),
    }))
    : [...THINKING_EFFORT_OPTIONS];
  if (!options.some((option) => option.value === current)) {
    const native = current.includes(":") ? current.slice(current.indexOf(":") + 1) : current;
    options.push({ value: current, label: compactThinkingLabel(native) });
  }
  return options;
}

/** 一个 CLI 工具对应 `SettingsAiInput` 里的默认模型字段。 */
const PROVIDER_MODEL_FIELDS: Record<SettingsSessionProvider, keyof SettingsAiInput> = {
  claude: "defaultModel",
  codex: "defaultCodexModel",
  opencode: "defaultOpenCodeModel",
  grok: "defaultGrokModel",
  qoder: "defaultQoderModel",
  pi: "defaultPiModel",
  gemini: "defaultGeminiModel",
};

function sessionProviderLabel(provider: SettingsSessionProvider): string {
  return SESSION_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
}

/** `/api/models` 里当前工具的那一份目录。 */
function providerModelSuggestions(
  models: SettingsSnapshot["models"],
  provider: SettingsSessionProvider,
): SettingsModelOption[] {
  if (!models) return [];
  if (provider === "codex") return models.codexModels;
  if (provider === "opencode") return models.opencodeModels;
  if (provider === "grok") return models.grokModels;
  if (provider === "qoder") return models.qoderModels;
  if (provider === "pi") return models.piModels;
  if (provider === "gemini") return models.geminiModels;
  return models.models;
}

function providerModelValue(form: SettingsAiInput, provider: SettingsSessionProvider): string {
  const value = form[PROVIDER_MODEL_FIELDS[provider]];
  return typeof value === "string" ? value : "";
}

/** 下拉里的“自定义模型 ID…”只是动作项，永远不会成为被选中的值。 */
const CUSTOM_MODEL_ACTION = "\u0000custom-model";

/**
 * 新会话默认模型：列表里选（和任务指派、会话三件套同一份目录），
 * 目录外的模型 ID 也能手输，不会被下拉锁死。
 */
function DefaultModelControl({
  provider,
  value,
  models,
  onChange,
  id,
}: {
  provider: SettingsSessionProvider;
  value: string;
  models: SettingsSnapshot["models"];
  onChange(value: string): void;
  id?: string;
}): React.ReactElement {
  const [customEntry, setCustomEntry] = useState(false);
  useEffect(() => setCustomEntry(false), [provider]);

  // 目录里的 `default` 项也是「跟随默认」哨兵：上面那条空值项已经表达同一件事，
  // 留着它就能被选中并写成 defaultModel="default"，等于把哨兵当模型 id 存进配置。
  const suggestions = providerModelSuggestions(models, provider)
    .filter((model) => model.id !== MODEL_CATALOG_DEFAULT_VALUE);
  const options = suggestions.map((model) => ({ value: model.id, label: model.label || model.id, group: model.group }));
  const label = sessionProviderLabel(provider);
  const trimmed = value.trim();
  const customValue = trimmed !== "" && !options.some((option) => option.value === trimmed);
  const inputId = id ?? `settings-default-model-${provider}`;

  if (customEntry || customValue) {
    return (
      <>
        <SettingsTextInput
          id={inputId}
          list={`${inputId}-list`}
          value={value}
          placeholder="输入模型 ID，留空跟随 CLI 默认"
          onChange={onChange}
        />
        <ModelSuggestions id={`${inputId}-list`} models={suggestions} />
        <WandButton
          kind="ghost"
          size="small"
          className="wand-settings-library-inline-action"
          onClick={() => {
            setCustomEntry(false);
            onChange("");
          }}
        >
          从列表选择
        </WandButton>
      </>
    );
  }

  return (
    <SettingsSelect
      id={inputId}
      ariaLabel={`${label} 默认模型`}
      value={value}
      searchable
      searchPlaceholder="搜索模型"
      options={[
        { value: "", label: `跟随 ${label} 默认` },
        ...options,
        { value: CUSTOM_MODEL_ACTION, label: "自定义模型 ID…" },
      ]}
      onChange={(next) => {
        if (next === CUSTOM_MODEL_ACTION) {
          setCustomEntry(true);
          return;
        }
        onChange(next);
      }}
    />
  );
}

/** 三件套只展示选中的工具；把其余工具已保存的默认值摆出来，避免配置被藏起来。 */
function sessionDefaultsSummary(form: SettingsAiInput, models: SettingsSnapshot["models"]): string {
  return SESSION_PROVIDER_OPTIONS
    .map((option) => {
      const value = providerModelValue(form, option.value);
      const label = providerModelSuggestions(models, option.value).find((model) => model.id === value)?.label;
      return `${option.label} · ${label || value || "跟随默认"}`;
    })
    .join("；");
}

/** 快速更新后的回执：逐条列出每个 CLI 的结果，否则只看到一句“更新完成”，失败原因全丢掉。 */
export function cliUpdateSummary(result: SettingsProviderCliUpdates): { text: string; ok: boolean } {
  const results = result.results || [];
  if (!results.length) return { ok: true, text: "没有需要更新的 CLI。" };
  const failed = results.filter((item) => !item.ok);
  const header = failed.length
    ? `${failed.length}/${results.length} 个 CLI 未更新完成：`
    : `${results.length} 个 CLI 更新完成：`;
  return { ok: !failed.length, text: header + "\n" + results.map((item) => `${item.label}：${item.message}`).join("\n") };
}

/** 刷新模型列表后的回执：把每个 CLI 拿到的候选条数都摆出来，避免只提 Claude。 */
export function modelCatalogSummary(models: SettingsModelCatalog): string {
  const groups: Array<[string, number]> = [
    ["Claude", models.models.length],
    ["Codex", models.codexModels.length],
    ["OpenCode", models.opencodeModels.length],
    ["Grok", models.grokModels.length],
    ["Qoder", models.qoderModels.length],
    ["Pi", models.piModels.length],
    ["Gemini", models.geminiModels.length],
  ];
  return groups
    .map(([label, count]) => count > 0 ? `${label} ${count}` : `${label} 0（未发现）`)
    .join(" · ");
}

/** CLI 行的状态文案：把「已是最新 / 读不出来 / 未安装」区分开，否则只有有新版本的那行看得出变化。 */
export function cliStatusText(item: SettingsProviderCliStatus): string {
  if (!item.installed) return "未安装";
  const current = item.currentVersion;
  if (!current) return "版本读取失败";
  if (item.updateAvailable) {
    const arrow = `${current} → ${item.latestVersion || "最新版"}`;
    return item.updateSupported ? arrow : `${arrow}（需手动更新）`;
  }
  if (!item.updateSupported) return `${current}（当前安装方式不支持自动更新）`;
  if (!item.latestVersion) return `${current}（未能获取最新版）`;
  return `${current}（已是最新）`;
}

/** 行上的悬停详情：优先用服务端返回的失败原因，没有就重复状态文案。 */
export function cliStatusDetail(item: SettingsProviderCliStatus): string {
  const error = (item.error ?? "").replace(/\s+/g, " ").trim();
  return error || cliStatusText(item);
}

export function AiSettingsTab({ snapshot, repository, refresh, setSnapshot }: SettingsTabProps) {
  const providerUsage = useProviderUsage();
  const { employees } = useSiliconEmployees();
  const systemEmployee = employees.find((employee) => isSystemSiliconEmployee(employee)) ?? null;
  const providerOptions = sortProviderOptions(
    SESSION_PROVIDER_OPTIONS, providerUsage ?? {}, (entry) => entry.value,
  );
  const [form, setForm, acceptSaved] = useSettingsDraft(aiFromSnapshot(snapshot));
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [errors, setErrors] = useState<Record<string, string>>({});


  function update<K extends keyof SettingsAiInput>(key: K, value: SettingsAiInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  /** 每个 CLI 各有一份默认模型字段，选中的工具决定写哪一个。 */
  function updateProviderModel(provider: SettingsSessionProvider, model: string) {
    const field = PROVIDER_MODEL_FIELDS[provider];
    setForm((current) => ({ ...current, [field]: model }));
  }

  async function refreshModels() {
    setPending("models");
    setStatus("");
    try {
      const models = await repository.execute({ type: "models.refresh" });
      setSnapshot((current) => current ? { ...current, models } : current);
      // 只回显 Claude 版本会让人以为别的 CLI 没刷新；这里把每个工具的条数都摆出来。
      setStatus(`模型列表已刷新。${modelCatalogSummary(models)}`);
      setTone("success");
    } catch (cause) {
      setStatus(failureMessage(cause, "刷新模型列表失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  async function save() {
    setPending("save");
    setStatus("");
    try {
      const result = await repository.execute({ type: "ai.save", value: form });
      acceptSaved(form, aiFromSnapshot({ ...snapshot, config: result.config }));
      setStatus(result.restartRequired ? "AI 配置已保存；部分部署变化等待重启。" : "AI 与模型配置已保存。");
      setTone(result.restartRequired ? "warning" : "success");
      await refresh();
    } catch (cause) {
      setStatus(failureMessage(cause, "保存 AI 配置失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  const models = snapshot.models;
  useEffect(() => {
    const onCatalog = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      setSnapshot((current) => current ? { ...current, models: normalizeModels(detail) } : current);
    };
    window.addEventListener("wand-model-catalog", onCatalog);
    return () => window.removeEventListener("wand-model-catalog", onCatalog);
  }, [setSnapshot]);

  return (
    <section className="wand-settings-library-panel" aria-label="AI 与模型">
      <header className="wand-settings-library-panel-heading">
        <h2>AI 与模型</h2><p>集中管理会话默认模型，以及 Wand 自有 AI 的执行者与候选链。</p>
      </header>

      <SettingsSection
        title="新会话默认"
        description="全局默认用于之后新建的会话，不会改写已有会话已保存的配置或员工候选。未手动指定的思考档位跟随此默认；当前会话可在输入区单独调整。"
        action={<SettingsActionButton pending={pending === "models"} kind="secondary" onClick={() => void refreshModels()}>刷新模型列表</SettingsActionButton>}
      >
        <div className="wand-settings-library-default-row">
          <SettingsField label="CLI 工具" hint="仅新会话默认；Pi 指外部 CLI，Wand Agent 在任务或员工中选择。">
            <SettingsSelect
              id="settings-default-provider"
              ariaLabel="新会话默认 CLI 工具"
              value={form.defaultProvider}
              options={providerOptions}
              disabled={providerUsage === null}
              onChange={(value) => {
                const next = value as SettingsSessionProvider;
                const modelId = providerModelValue({ ...form, defaultProvider: next }, next);
                const supported = thinkingEffortOptions(next, models, modelId, "off")
                  .some((option) => option.value === form.defaultThinkingEffort);
                setForm((current) => ({
                  ...current,
                  defaultProvider: next,
                  defaultThinkingEffort: supported ? current.defaultThinkingEffort : "off",
                }));
              }}
            />
          </SettingsField>
          <SettingsField
            label="默认模型"
            htmlFor={`settings-default-model-${form.defaultProvider}`}
            hint={`${sessionProviderLabel(form.defaultProvider)} 新会话默认；留空跟随工具，支持手输模型 ID。`}
          >
            <DefaultModelControl
              provider={form.defaultProvider}
              value={providerModelValue(form, form.defaultProvider)}
              models={models}
              onChange={(value) => updateProviderModel(form.defaultProvider, value)}
            />
          </SettingsField>
          <SettingsField label="思考深度" hint="派发和新建会话时的默认推理档位">
            <SettingsSelect
              id="settings-default-thinking"
              ariaLabel="新会话默认思考深度"
              value={form.defaultThinkingEffort}
              options={thinkingEffortOptions(
                form.defaultProvider,
                models,
                providerModelValue(form, form.defaultProvider),
                form.defaultThinkingEffort,
              )}
              onChange={(value) => update("defaultThinkingEffort", value as SettingsThinkingEffort)}
            />
          </SettingsField>
        </div>
        <p className="wand-settings-library-default-summary" aria-label="各 CLI 工具已保存的默认模型">
          {sessionDefaultsSummary(form, models)}
        </p>
      </SettingsSection>

      <OpenRouterSettingsPanel snapshot={snapshot} repository={repository} setSnapshot={setSnapshot} />
      <ModelGroupsSettingsPanel snapshot={snapshot} repository={repository} setSnapshot={setSnapshot} />

      <SettingsSection
        title="系统 AI"
        description="由内置「系统运维」员工执行：Commit message 与 tag、会话与任务标题、提示词优化、员工起草。使用员工已配置的工具与模型调用链。"
      >
        <SystemAiOwnerSummary employee={systemEmployee} />
        <SettingsStatus tone="info">
          按配置顺序尝试 CLI 或 Wand Agent；不可用的候选按原有规则继续，取消与超时会结束本次调用。
        </SettingsStatus>
      </SettingsSection>

      <SettingsSaveBar label="保存 AI 与模型配置" pending={pending === "save"} disabled={!!pending && pending !== "save"} onSave={() => void save()} status={status} tone={tone} />
    </section>
  );
}

export function NotificationSettingsTab(_props: SettingsTabProps) {
  const { snapshot, repository, setSnapshot, toast } = _props;
  const [preferences, setPreferences] = useState(() => ({ ...snapshot.notifications }));
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");

  useEffect(() => setPreferences({ ...snapshot.notifications }), [snapshot.notifications]);

  async function savePreference(value: Partial<Pick<typeof preferences, "sound" | "volume" | "bubble">>, preview = false) {
    setPending("preference");
    setStatus("");
    try {
      const next = await repository.execute({ type: "notification.preferences.set", value });
      setPreferences(next);
      setSnapshot((current) => current ? { ...current, notifications: next } : current);
      if (preview) await repository.execute({ type: "notification.sound.preview" });
    } catch (cause) {
      setStatus(failureMessage(cause, "保存通知偏好失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  async function run(name: string, task: () => Promise<string>): Promise<boolean> {
    setPending(name);
    setStatus("");
    try {
      setStatus(await task());
      setTone("success");
      return true;
    } catch (cause) {
      setStatus(failureMessage(cause, "通知操作失败。"));
      setTone("error");
      return false;
    } finally {
      setPending("");
    }
  }

  const permissionLabel = preferences.permission === "granted"
    ? "已授权"
    : preferences.permission === "denied"
      ? "已拒绝"
      : preferences.permission === "unsupported"
        ? "当前环境不支持"
        : "尚未授权";

  return (
    <section className="wand-settings-library-panel" aria-label="通知">
      <header className="wand-settings-library-panel-heading">
        <h2>通知</h2><p>设置提示音、应用内气泡和系统通知的行为。</p>
      </header>
      <SettingsSection title="通知偏好">
        <SettingsToggle
          label="播放提示音"
          description="重要通知到达时播放柔和提示音。"
          checked={preferences.sound}
          disabled={pending === "preference"}
          onCheckedChange={(sound) => void savePreference({ sound }, sound)}
        />
        {preferences.sound ? (
          <SettingsField label={`提示音音量（${preferences.volume}%）`} htmlFor="settings-notification-volume">
            <Slider id="settings-notification-volume" min={0} max={100} step={5}
              value={preferences.volume}
              aria-label="提示音音量" ariaLabelForHandle="提示音音量"
              onChange={(volume) => setPreferences((current) => ({ ...current, volume }))}
              onChangeComplete={(volume) => void savePreference({ volume }, true)} />
          </SettingsField>
        ) : null}
        <SettingsToggle
          label="应用内通知气泡"
          description="在页面顶部显示浮动通知。"
          checked={preferences.bubble}
          disabled={pending === "preference"}
          onCheckedChange={(bubble) => void savePreference({ bubble })}
        />
      </SettingsSection>

      {preferences.nativeSounds.length ? (
        <SettingsSection title="系统通知铃声" description="选择原生客户端发送系统通知时使用的铃声。">
          <SettingsField label="通知铃声">
            <SettingsSelect
              id="settings-native-sound"
              ariaLabel="系统通知铃声"
              value={preferences.nativeSound || preferences.nativeSounds[0].id}
              options={preferences.nativeSounds.map((sound) => ({ value: sound.id, label: sound.name }))}
              onChange={(sound) => void run("native-sound", async () => {
                await repository.execute({ type: "notification.nativeSound.set", sound });
                setPreferences((current) => ({ ...current, nativeSound: sound }));
                return "通知铃声已保存。";
              })}
            />
          </SettingsField>
          <SettingsActionButton pending={pending === "sound-preview"} kind="secondary" onClick={() => run("sound-preview", async () => {
            await repository.execute({ type: "notification.nativeSound.preview", sound: preferences.nativeSound || preferences.nativeSounds[0].id });
            return "已播放铃声预览。";
          })}>试听铃声</SettingsActionButton>
        </SettingsSection>
      ) : null}

      {preferences.hapticsEnabled !== null ? (
        <SettingsSection title="触感反馈">
          <SettingsToggle
            label="启用触感反馈"
            checked={preferences.hapticsEnabled}
            disabled={pending === "haptics"}
            onCheckedChange={(enabled) => void run("haptics", async () => {
              await repository.execute({ type: "notification.haptics.set", enabled });
              setPreferences((current) => ({ ...current, hapticsEnabled: enabled }));
              return enabled ? "触感反馈已启用。" : "触感反馈已关闭。";
            })}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="系统通知" description={`授权状态：${permissionLabel}`}>
        <div className="wand-settings-library-button-row">
          {preferences.permission !== "granted" && preferences.permission !== "unsupported" ? (
            <SettingsActionButton pending={pending === "permission"} kind="primary" onClick={() => run("permission", async () => {
              const result = await repository.execute({ type: "notification.permission.request" });
              setPreferences((current) => ({ ...current, permission: result.permission }));
              return result.permission === "granted" ? "系统通知已授权。" : "系统通知尚未授权。";
            })}>请求通知权限</SettingsActionButton>
          ) : null}
          {preferences.permission === "denied" ? (
            <SettingsActionButton
              pending={pending === "notification-settings"}
              kind="secondary"
              onClick={() => run("notification-settings", async () => {
                const result = await repository.execute({ type: "notification.settings.open" });
                return result.native
                  ? "已打开 Wand 的系统通知设置；修改后返回此页即可。"
                  : "请在浏览器的网站权限设置中允许通知，然后刷新页面。";
              })}
            >
              {snapshot.platform.kind === "android" ? "打开系统通知设置" : "如何重置权限"}
            </SettingsActionButton>
          ) : null}
          <SettingsActionButton pending={pending === "test"} kind="secondary" onClick={() => run("test", async () => {
            const result = await repository.execute({ type: "notification.test" });
            toast("测试通知", "info");
            return `提示音：${result.sound === "passed" ? "通过" : "失败"}；气泡：${result.bubble === "passed" ? "通过" : "已关闭"}；系统：${result.system}`;
          })}>立即测试</SettingsActionButton>
          <SettingsActionButton pending={pending === "delayed-test"} kind="secondary" onClick={() => run("delayed-test", async () => {
            await repository.execute({ type: "notification.test", delayMs: 10000 });
            return "10 秒延迟通知已发送。";
          })}>10 秒后发送</SettingsActionButton>
        </div>
      </SettingsSection>
      {status ? <SettingsStatus tone={tone}>{status}</SettingsStatus> : null}
    </section>
  );
}

export function SecuritySettingsTab(_props: SettingsTabProps) {
  const { snapshot, repository, refresh } = _props;
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [certFile, setCertFile] = useState<File | null>(null);
  const [pending, setPending] = useState("");
  const [settled, setSettled] = useState<"success" | "error" | null>(null);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [passwordError, setPasswordError] = useState("");

  async function changePassword() {
    setPasswordError("");
    if (password.length < 6) {
      setPasswordError("密码长度至少为 6 个字符。");
      return;
    }
    if (password !== confirmation) {
      setPasswordError("两次输入的密码不一致。");
      return;
    }
    setSettled(null);
    setPending("password");
    setStatus("");
    try {
      const result = await repository.execute({ type: "password.change", password });
      setPassword("");
      setConfirmation("");
      setStatus("密码修改成功；所有旧登录会话已失效，正在返回登录页…");
      setTone("success");
      setSettled("success");
      if (result.reauthenticationRequired) {
        // 延后 reload 与整句结果的驻留对齐：读得完「密码修改成功」再去登录页。
        window.setTimeout(() => {
          settingsStore.setNested(null);
          window.location.reload();
        }, MOTION_DWELL_RESULT_SENTENCE_MS);
      }
    } catch (cause) {
      setStatus(failureMessage(cause, "修改密码失败。"));
      setTone("error");
      setSettled("error");
    } finally {
      setPending("");
    }
  }

  async function uploadCertificate() {
    if (!keyFile || !certFile) {
      setStatus("请选择私钥和证书文件。");
      setTone("error");
      return;
    }
    setSettled(null);
    setPending("certificate");
    setStatus("");
    try {
      const [key, cert] = await Promise.all([keyFile.text(), certFile.text()]);
      const result = await repository.execute({ type: "certificate.upload", key, cert });
      setStatus(result.restartRequired ? "证书已上传，重启服务后生效。" : "证书已上传。 ");
      setTone("success");
      setSettled("success");
      await refresh();
    } catch (cause) {
      setStatus(failureMessage(cause, "上传证书失败。"));
      setTone("error");
      setSettled("error");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="wand-settings-library-panel" aria-label="安全">
      <header className="wand-settings-library-panel-heading">
        <h2>安全</h2><p>管理登录密码与 SSL 证书。敏感变更保存前请仔细确认。</p>
      </header>
      <SettingsSection title="修改密码" description="至少 6 个字符；保存后会撤销包括当前页面在内的所有登录会话。">
        <Form noValidate layout="vertical" className="wand-settings-library-security-form" onFinish={() => void changePassword()}>
          <input type="text" name="username" autoComplete="username" value="wand" readOnly hidden />
          <SettingsGrid>
            <SettingsField label="新密码" htmlFor="settings-new-password" error={passwordError}>
              <SettingsTextInput id="settings-new-password" type="password" autoComplete="new-password" value={password} invalid={!!passwordError} placeholder="输入新密码" onChange={(value) => { setPassword(value); setPasswordError(""); }} />
            </SettingsField>
            <SettingsField label="确认密码" htmlFor="settings-confirm-password">
              <SettingsTextInput id="settings-confirm-password" type="password" autoComplete="new-password" value={confirmation} invalid={!!passwordError} placeholder="再次输入新密码" onChange={(value) => { setConfirmation(value); setPasswordError(""); }} />
            </SettingsField>
          </SettingsGrid>
          <SettingsActionButton type="submit" pending={pending === "password"} settled={pending === "password" ? null : settled} successLabel="已修改密码" kind="primary">修改密码并重新登录</SettingsActionButton>
        </Form>
      </SettingsSection>

      <SettingsSection title="SSL 证书" description={`当前状态：${snapshot.hasCert ? "已安装证书" : "未安装证书（使用自签名或 HTTP）"}`}>
        <SettingsGrid>
          <SettingsField label="私钥文件（server.key）">
            <Upload accept=".key,.pem,text/plain" maxCount={1} disabled={!!pending}
              beforeUpload={(file) => { setKeyFile(file); return false; }}
              onRemove={() => { setKeyFile(null); }}
              fileList={keyFile ? [{ uid: "key", name: keyFile.name }] : []}>
              <WandButton disabled={!!pending} aria-label="SSL 私钥文件">选择私钥文件</WandButton>
            </Upload>
          </SettingsField>
          <SettingsField label="证书文件（server.crt）">
            <Upload accept=".crt,.pem,text/plain" maxCount={1} disabled={!!pending}
              beforeUpload={(file) => { setCertFile(file); return false; }}
              onRemove={() => { setCertFile(null); }}
              fileList={certFile ? [{ uid: "cert", name: certFile.name }] : []}>
              <WandButton disabled={!!pending} aria-label="SSL 证书文件">选择证书文件</WandButton>
            </Upload>
          </SettingsField>
        </SettingsGrid>
        <SettingsActionButton pending={pending === "certificate"} settled={pending === "certificate" ? null : settled} successLabel="已上传" kind="primary" onClick={() => uploadCertificate()}>上传证书</SettingsActionButton>
      </SettingsSection>
      {status ? <SettingsStatus tone={tone}>{status}</SettingsStatus> : null}
    </section>
  );
}

export function PresetSettingsTab({ snapshot }: SettingsTabProps) {
  const presets = snapshot.config?.commandPresets || [];
  return (
    <section className="wand-settings-library-panel" aria-label="命令预设">
      <header className="wand-settings-library-panel-heading">
        <h2>命令预设</h2><p>预设由服务端配置管理，可在创建会话时快速选择。</p>
      </header>
      <div className="wand-settings-library-preset-list" aria-label="已有命令预设">
        {presets.map((preset, index) => (
          <Card size="small" title={preset.label || "未命名预设"} key={`${preset.label}-${index}`}>
            <code>{preset.command}</code>
            {preset.mode ? <Tag>模式：{preset.mode}</Tag> : null}
          </Card>
        ))}
        {presets.length === 0 ? <Empty description="没有命令预设；可在 config.json 的 commandPresets 中配置。" /> : null}
      </div>
    </section>
  );
}

const CARD_OPTIONS: Array<{ key: keyof SettingsCardDefaults; title: string; description: string }> = [
  { key: "editCards", title: "文件编辑", description: "Edit / Write 工具结果" },
  { key: "inlineTools", title: "内联工具", description: "Read / Glob / Grep 工具结果" },
  { key: "terminal", title: "终端输出", description: "Bash 命令执行结果" },
  { key: "thinking", title: "思考过程", description: "模型的 Thinking 内容" },
];

export function DisplaySettingsTab({ snapshot, repository, refresh }: SettingsTabProps) {
  const [value, setValue, acceptSaved] = useSettingsDraft<SettingsCardDefaults>({ ...snapshot.config!.cardDefaults });
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");


  async function save() {
    setPending(true);
    setStatus("");
    try {
      const result = await repository.execute({ type: "display.save", value });
      acceptSaved(value, { ...result.config.cardDefaults });
      setStatus("显示设置已保存，并会立即应用于之后渲染的卡片。");
      setTone("success");
      await refresh();
    } catch (cause) {
      setStatus(failureMessage(cause, "保存显示设置失败。"));
      setTone("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="wand-settings-library-panel" aria-label="显示">
      <header className="wand-settings-library-panel-heading">
        <h2>显示</h2><p>调整本机配色与结果卡片的默认展开状态。</p>
      </header>
      <ThemePicker />
      <SettingsSection title="默认展开的卡片">
        {CARD_OPTIONS.map((option) => (
          <SettingsToggle
            key={option.key}
            label={option.title}
            description={option.description}
            checked={value[option.key]}
            onCheckedChange={(checked) => setValue((current) => ({ ...current, [option.key]: checked }))}
          />
        ))}
      </SettingsSection>
      <SettingsSaveBar label="保存显示设置" pending={pending} onSave={() => void save()} status={status} tone={tone} />
    </section>
  );
}

/**
 * 我的资料：会话里「我」这条发言的署名与头像。
 *
 * 只是展示设置，不牵涉执行身份或权限；留空名字就沿用默认的「我」，
 * 这样不改资料的老用户看到的还是原来的样子。
 */
export function ProfileSettingsTab({ snapshot, repository, refresh }: SettingsTabProps) {
  const [value, setValue, acceptSaved] = useSettingsDraft<SettingsUserProfile>({ ...snapshot.config!.userProfile });
  const [pending, setPending] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const name = value.name.trim();
  const nameError = value.name.length > USER_PROFILE_NAME_MAX ? `名字不能超过 ${USER_PROFILE_NAME_MAX} 个字符。` : "";

  async function save() {
    setPending(true);
    setStatus("");
    try {
      const result = await repository.execute({ type: "profile.save", value });
      acceptSaved(value, { ...result.config.userProfile });
      setStatus(name
        ? "资料已保存，之后发出的会话消息会署这个名字。"
        : "资料已保存；名字留空时按默认的「我」署名。");
      setTone("success");
      await refresh();
    } catch (cause) {
      setStatus(failureMessage(cause, "保存资料失败。"));
      setTone("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="wand-settings-library-panel" aria-label="我的资料">
      <header className="wand-settings-library-panel-heading">
        <h2>我的资料</h2>
        <p>这里的名字和头像用于你自己发出的会话消息；只影响显示，不改变任何执行身份或权限。</p>
      </header>
      <SettingsSection title="署名与头像" description={`名字留空时按「${DEFAULT_USER_DISPLAY_NAME}」显示；历史消息会跟着当前资料一起显示，不改写已保存的内容。`}>
        <SettingsField label="显示名字" htmlFor="settings-profile-name" error={nameError}
          hint={`最多 ${USER_PROFILE_NAME_MAX} 个字符`}>
          <SettingsTextInput
            id="settings-profile-name"
            value={value.name}
            max={USER_PROFILE_NAME_MAX}
            disabled={pending}
            invalid={!!nameError}
            placeholder={DEFAULT_USER_DISPLAY_NAME}
            onChange={(next) => setValue((current) => ({ ...current, name: next }))}
          />
        </SettingsField>
        <SettingsField label="头像" hint="可以挑一只像素猫，或上传一张自己的图片。">
          <UserAvatarPicker
            avatar={value.avatar}
            name={name || DEFAULT_USER_DISPLAY_NAME}
            disabled={pending}
            onBusyChange={setAvatarBusy}
            onChange={(avatar) => setValue((current) => ({ ...current, avatar }))}
          />
        </SettingsField>
      </SettingsSection>
      <SettingsSaveBar label="保存资料" pending={pending || avatarBusy} onSave={() => void save()}
        status={status} tone={tone} />
    </section>
  );
}
