import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { settingsStore } from "./controller";
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
  SettingsModelOption,
  SettingsProvider,
  SettingsRepository,
  SettingsSnapshot,
  SettingsWebUpdate,
} from "./types";

export interface SettingsTabProps {
  snapshot: SettingsSnapshot;
  repository: SettingsRepository;
  refresh(): Promise<void>;
  setSnapshot: Dispatch<SetStateAction<SettingsSnapshot | null>>;
  toast(message: string, tone?: "info" | "success" | "warning" | "error"): void;
  showRestart(): void;
}

type StatusTone = "info" | "success" | "warning" | "error";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function PendingTab({ title, description }: { title: string; description: string }) {
  return (
    <section className="wand-settings-panel" aria-label={title}>
      <header className="wand-settings-panel-heading"><h2>{title}</h2><p>{description}</p></header>
    </section>
  );
}

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

function ConnectCodeDialog({ code }: { code: string }) {
  const controller = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrError, setQrError] = useState("");
  useEffect(() => {
    if (controller.nested !== "qr" || !canvasRef.current) return;
    const library = window.QRCodeLib;
    if (!library || typeof library.toCanvas !== "function") {
      setQrError("二维码库未加载，可复制连接码。 ");
      return;
    }
    setQrError("");
    try {
      library.toCanvas(canvasRef.current, code, {
        width: Math.max(240, Math.min(420, window.innerWidth * 0.72)),
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#1f1b17", light: "#ffffff" },
      }, (error: unknown) => { if (error) setQrError("二维码生成失败，可复制连接码。"); });
    } catch {
      setQrError("二维码生成失败，可复制连接码。");
    }
  }, [code, controller.nested]);
  return (
    <WandDialogSurface
      open={controller.nested === "qr"}
      onOpenChange={(open) => { if (!open) settingsStore.setNested(null); }}
      title="App 连接二维码"
      description="用 Wand App 扫一扫，连接当前服务器。"
      className="wand-settings-nested-dialog wand-settings-qr-dialog"
      overlayClassName="wand-settings-nested-overlay"
      headerClassName="wand-settings-header"
      titleClassName="wand-settings-title"
      descriptionClassName="wand-settings-description"
      closeLabel="关闭连接二维码"
      testId="settings-connect-qr-dialog"
    >
      <canvas ref={canvasRef} aria-label="App 连接二维码" />
      {qrError ? <SettingsStatus tone="warning">{qrError}</SettingsStatus> : null}
      <code className="wand-settings-connect-code">{code}</code>
    </WandDialogSurface>
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
        return (
          <div className="wand-settings-download-row" key={source}>
            <div><strong>{source === "github" ? "线上版本" : "本地版本"}</strong><span>{asset!.version ? `v${asset!.version}` : asset!.fileName} · {formatBytes(asset!.size)}</span></div>
            <WandButton
              kind="secondary"
              disabled={!installable}
              aria-label={`${installable ? "下载" : "已安装"}${title}${source === "github" ? "线上版本" : "本地版本"}`}
              onClick={async () => {
                await repository.execute({
                  type: "distribution.download",
                  kind,
                  source,
                  url: asset!.downloadUrl,
                  fileName: asset!.fileName,
                });
                toast("已开始下载", "info");
              }}
            >{installable ? (currentVersion ? "下载并安装" : "下载") : "已安装"}</WandButton>
          </div>
        );
      }) : <div className="wand-settings-empty">暂无可用安装包</div>}
    </SettingsSection>
  );
}

export function AboutSettingsTab({ snapshot, repository, refresh, toast, showRestart }: SettingsTabProps) {
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [update, setUpdate] = useState<SettingsWebUpdate | null>(null);
  const about = snapshot.about;

  async function action(name: string, task: () => Promise<void>, success?: string) {
    setPending(name);
    setStatus("");
    try {
      await task();
      if (success) { setStatus(success); setTone("success"); }
    } catch (cause) {
      setStatus(messageOf(cause, "操作失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  const cliItems = snapshot.providerCliUpdates?.items || [];
  const cliUpdates = cliItems.filter((item) => item.updateAvailable && item.updateSupported);

  return (
    <section className="wand-settings-panel" aria-label="关于 Wand">
      <header className="wand-settings-panel-heading">
        <h2>关于 Wand</h2><p>查看版本信息、更新状态和客户端连接方式。</p>
      </header>
      <SettingsSection title="版本信息">
        <dl className="wand-settings-about-list">
          <div><dt>包名</dt><dd>{about.packageName}</dd></div>
          <div><dt>当前版本</dt><dd>{about.version}</dd></div>
          <div><dt>Node.js 要求</dt><dd>{about.nodeVersion}</dd></div>
          {about.build.shortCommit ? <div><dt>构建</dt><dd>{about.build.shortCommit}{about.build.channel ? ` · ${about.build.channel}` : ""}</dd></div> : null}
          {about.repoUrl ? <div><dt>仓库地址</dt><dd><a href={about.repoUrl} target="_blank" rel="noopener noreferrer">{about.repoUrl}</a></dd></div> : null}
        </dl>
      </SettingsSection>

      {snapshot.access === "admin" ? (
        <>
          <SettingsSection title="Web 端更新" description={`更新通道：${about.updateChannel === "beta" ? "Beta" : "稳定版"}`}>
            <div className="wand-settings-about-list">
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
            <div className="wand-settings-button-row">
              <SettingsActionButton pending={pending === "check"} kind="secondary" onClick={() => void action("check", async () => setUpdate(await repository.execute({ type: "webUpdate.check" })), "版本检查完成。")}>检查更新</SettingsActionButton>
              <SettingsActionButton pending={pending === "install"} kind="primary" onClick={() => void action("install", async () => { const result = await repository.execute({ type: "webUpdate.install" }); setStatus(result.message); }, undefined)}>更新或重新安装</SettingsActionButton>
              {snapshot.restartRequired ? <SettingsActionButton pending={pending === "restart"} kind="secondary" onClick={() => void action("restart", async () => {
                try {
                  await repository.execute({ type: "server.restart" });
                } finally {
                  showRestart();
                }
              }, "服务正在重启…")}>重启服务</SettingsActionButton> : null}
            </div>
          </SettingsSection>

          <SettingsSection title="开发 CLI" description="Claude Code、Codex、OpenCode 与 Qoder CLI 的服务端版本。">
            <div className="wand-settings-cli-list">
              {cliItems.map((item) => (
                <div key={item.id}><strong>{item.label}</strong><span>{item.installed ? item.currentVersion || "未知版本" : "未安装"}{item.updateAvailable ? ` → ${item.latestVersion || "最新版"}` : ""}</span></div>
              ))}
              {!cliItems.length ? <div className="wand-settings-empty">尚未检查 CLI 版本</div> : null}
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
            <div className="wand-settings-button-row">
              <SettingsActionButton pending={pending === "cli-check"} kind="secondary" onClick={() => void action("cli-check", async () => { await repository.execute({ type: "cliUpdates.load", force: true }); await refresh(); }, "CLI 版本检查完成。")}>检查 CLI 更新</SettingsActionButton>
              {cliUpdates.length ? <SettingsActionButton pending={pending === "cli-install"} kind="primary" onClick={() => void action("cli-install", async () => { await repository.execute({ type: "cliUpdates.install", ids: cliUpdates.map((item) => item.id) }); await refresh(); }, "CLI 更新完成。")}>快速更新 ({cliUpdates.length})</SettingsActionButton> : null}
            </div>
          </SettingsSection>

          <DistributionSection kind="apk" title="Android App" distribution={about.androidApk} currentVersion={snapshot.platform.kind === "android" ? snapshot.platform.appVersion : null} repository={repository} toast={toast} />
          <DistributionSection kind="dmg" title="macOS App" distribution={about.macosDmg} currentVersion={snapshot.platform.kind === "macos" ? snapshot.platform.appVersion : null} repository={repository} toast={toast} />

          <SettingsSection title="App 连接码" description="粘贴或扫码后可连接当前服务；修改密码后会失效。">
            <code className="wand-settings-connect-code" aria-label="App 连接码">{snapshot.connectCode?.code || "暂不可用"}</code>
            <div className="wand-settings-button-row">
              <WandButton disabled={!snapshot.connectCode?.code} kind="secondary" onClick={async () => { await repository.execute({ type: "clipboard.copy", text: snapshot.connectCode!.code }); toast("连接码已复制", "success"); }}>复制连接码</WandButton>
              <WandButton disabled={!snapshot.connectCode?.code} kind="secondary" onClick={() => settingsStore.setNested("qr")}>放大连接二维码</WandButton>
            </div>
          </SettingsSection>
        </>
      ) : null}
      {status ? <SettingsStatus tone={tone}>{status}</SettingsStatus> : null}
      <ConnectCodeDialog code={snapshot.connectCode?.code || ""} />
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
    structuredRunner: config.structuredRunner,
    inheritEnv: config.inheritEnv,
  };
}

function EnvironmentDialog({ repository }: { repository: SettingsRepository }) {
  const controller = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
  const [preview, setPreview] = useState<SettingsEnvironmentPreview | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(reveal = false) {
    setLoading(true);
    setError("");
    try {
      setPreview(await repository.execute({ type: "environment.load", reveal }));
    } catch (cause) {
      setError(messageOf(cause, "环境变量加载失败。"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (controller.nested === "environment") void load(false);
  }, [controller.nested]);

  const entries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (preview?.entries || []).filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
  }, [preview, search]);

  return (
    <WandDialogSurface
      open={controller.nested === "environment"}
      onOpenChange={(open) => { if (!open) settingsStore.setNested(null); }}
      title="将注入子进程的环境变量"
      description="这些变量会传给 Claude、Codex 与 OpenCode 的子进程。"
      className="wand-settings-nested-dialog"
      overlayClassName="wand-settings-nested-overlay"
      headerClassName="wand-settings-header"
      titleClassName="wand-settings-title"
      descriptionClassName="wand-settings-description"
      closeLabel="关闭环境变量预览"
      testId="settings-environment-dialog"
    >
      <div className="wand-settings-env-toolbar">
        <SettingsTextInput
          id="settings-environment-search"
          value={search}
          type="search"
          placeholder="搜索变量名"
          onChange={setSearch}
        />
        <SettingsToggle
          label="显示敏感值"
          description="临时请求服务端返回未掩码值"
          checked={preview?.reveal === true}
          disabled={loading}
          onCheckedChange={(checked) => void load(checked)}
        />
      </div>
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      <div className="wand-settings-env-list" role="table" aria-label="子进程环境变量">
        {loading ? <div role="status">加载中…</div> : entries.map((entry) => (
          <div className="wand-settings-env-row" role="row" key={entry.name}>
            <code role="cell">{entry.name}</code>
            <span role="cell" title={entry.value}>{entry.value}</span>
          </div>
        ))}
        {!loading && entries.length === 0 ? <div className="wand-settings-empty">没有匹配的变量</div> : null}
      </div>
    </WandDialogSurface>
  );
}

export function GeneralSettingsTab({ snapshot, repository, refresh, toast }: SettingsTabProps) {
  const [form, setForm] = useState(() => generalFromSnapshot(snapshot));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => setForm(generalFromSnapshot(snapshot)), [snapshot]);

  function update<K extends keyof SettingsGeneralInput>(key: K, value: SettingsGeneralInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  }

  async function save() {
    const nextErrors: Record<string, string> = {};
    if (!form.host.trim()) nextErrors.host = "Host 不能为空。";
    if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) nextErrors.port = "端口必须是 1–65535 的整数。";
    if (!form.shell.trim()) nextErrors.shell = "Shell 不能为空。";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setStatus("请修正标记的配置项。");
      setTone("error");
      return;
    }
    setPending(true);
    setStatus("");
    try {
      const result = await repository.execute({ type: "general.save", value: form });
      setStatus(result.restartRequired
        ? "配置已保存；Host、端口、HTTPS 或 Shell 的变化需要重启服务后生效。"
        : "基本配置已保存。");
      setTone(result.restartRequired ? "warning" : "success");
      await refresh();
      toast("基本配置已保存", "success");
    } catch (cause) {
      setStatus(messageOf(cause, "保存基本配置失败。"));
      setTone("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="wand-settings-panel" aria-label="基本配置">
      <header className="wand-settings-panel-heading">
        <h2>基本配置</h2><p>配置服务连接、执行方式和工作目录。</p>
      </header>
      <SettingsSection title="服务连接" description="部署字段保存后可能需要重启服务。">
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

      <SettingsSection title="执行偏好" description="应用于之后创建的新会话。">
        <SettingsGrid>
          <SettingsField label="默认模式">
            <SettingsSelect id="settings-default-mode" ariaLabel="默认执行模式" value={form.defaultMode} options={MODE_OPTIONS} onChange={(value) => update("defaultMode", value as SettingsGeneralInput["defaultMode"])} />
          </SettingsField>
          <SettingsField label="结构化运行器">
            <SettingsSelect
              id="settings-structured-runner"
              ariaLabel="结构化运行器"
              value={form.structuredRunner}
              options={[{ value: "cli", label: "CLI" }, { value: "sdk", label: "SDK" }]}
              onChange={(value) => update("structuredRunner", value as "cli" | "sdk")}
            />
          </SettingsField>
          <SettingsField label="界面语言">
            <SettingsSelect
              id="settings-language"
              ariaLabel="界面语言"
              value={form.language || "auto"}
              options={[{ value: "auto", label: "自动" }, { value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }]}
              onChange={(value) => update("language", value === "auto" ? "" : value)}
            />
          </SettingsField>
        </SettingsGrid>
        <SettingsToggle
          label="继承环境变量"
          description="把当前服务进程的环境变量传给 PTY 与结构化子进程。"
          checked={form.inheritEnv}
          onCheckedChange={(checked) => update("inheritEnv", checked)}
        />
        <WandButton kind="secondary" onClick={() => settingsStore.setNested("environment")}>查看将注入的环境变量</WandButton>
      </SettingsSection>

      <SettingsSection title="工作环境">
        <SettingsGrid>
          <SettingsField label="默认工作目录" htmlFor="settings-default-cwd">
            <SettingsTextInput id="settings-default-cwd" value={form.defaultCwd} placeholder="/home/user" onChange={(value) => update("defaultCwd", value)} />
          </SettingsField>
          <SettingsField label="Shell" htmlFor="settings-shell" error={errors.shell}>
            <SettingsTextInput id="settings-shell" value={form.shell} invalid={!!errors.shell} placeholder="/bin/bash" onChange={(value) => update("shell", value)} />
          </SettingsField>
        </SettingsGrid>
      </SettingsSection>

      {snapshot.platform.canSetAppIcon ? (
        <SettingsSection title="应用图标" description="返回系统桌面后生效。">
          <div className="wand-settings-button-row" role="group" aria-label="应用图标">
            {(["shorthair", "garfield"] as const).map((icon) => (
              <WandButton
                key={icon}
                kind={snapshot.platform.appIcon === icon ? "primary" : "secondary"}
                aria-pressed={snapshot.platform.appIcon === icon}
                onClick={async () => {
                  await repository.execute({ type: "appIcon.set", icon });
                  toast("图标已切换，返回桌面后生效", "success");
                }}
              >{icon === "shorthair" ? "赛博虎妞" : "勤劳初二"}</WandButton>
            ))}
          </div>
        </SettingsSection>
      ) : null}

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
    commitCli: config.commitCli,
    commitModel: config.commitModel,
    commitAiSource: config.commitAiSource,
    systemAi: { ...config.systemAi, apiKey: "" },
  };
}

function ModelSuggestions({ id, models }: { id: string; models: SettingsModelOption[] }) {
  return (
    <datalist id={id}>
      {models.map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
    </datalist>
  );
}

export function AiSettingsTab({ snapshot, repository, refresh, setSnapshot, toast }: SettingsTabProps) {
  const [form, setForm] = useState(() => aiFromSnapshot(snapshot));
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => setForm(aiFromSnapshot(snapshot)), [snapshot]);

  function update<K extends keyof SettingsAiInput>(key: K, value: SettingsAiInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateSystem<K extends keyof SettingsAiInput["systemAi"]>(key: K, value: SettingsAiInput["systemAi"][K]) {
    setForm((current) => ({ ...current, systemAi: { ...current.systemAi, [key]: value, ...(key === "apiKey" ? { source: "custom" as const } : {}) } }));
    setErrors((current) => ({ ...current, [key]: "" }));
  }

  async function refreshModels() {
    setPending("models");
    setStatus("");
    try {
      const models = await repository.execute({ type: "models.refresh" });
      setSnapshot((current) => current ? { ...current, models } : current);
      setStatus("模型列表已刷新。" + (models.claudeVersion ? ` Claude ${models.claudeVersion}` : ""));
      setTone("success");
    } catch (cause) {
      setStatus(messageOf(cause, "刷新模型列表失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  async function importSystemAi() {
    setPending("import");
    setStatus("");
    try {
      const result = await repository.execute({ type: "systemAi.import", source: form.commitCli });
      setForm((current) => ({ ...current, systemAi: { ...result.systemAi, apiKey: "" } }));
      setStatus(`已从 ${form.commitCli} CLI 导入并保存 API 配置。`);
      setTone("success");
      await refresh();
    } catch (cause) {
      setStatus(messageOf(cause, "没有找到可导入的 CLI API 配置。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  async function save() {
    const systemRequired = form.systemAi.enabled || form.commitAiSource === "api";
    const nextErrors: Record<string, string> = {};
    if (systemRequired) {
      if (!form.systemAi.baseUrl.trim()) nextErrors.baseUrl = "请输入 API 地址。";
      else {
        try {
          const url = new URL(form.systemAi.baseUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") nextErrors.baseUrl = "API 地址必须使用 http(s)。";
        } catch { nextErrors.baseUrl = "请输入有效的 API 地址。"; }
      }
      if (!form.systemAi.model.trim()) nextErrors.model = "请输入系统 AI 模型。";
      if (!form.systemAi.apiKey.trim() && !form.systemAi.hasApiKey) nextErrors.apiKey = "请输入 API Key。";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setStatus("直连 API 配置尚未完整。");
      setTone("error");
      return;
    }
    setPending("save");
    setStatus("");
    try {
      const result = await repository.execute({ type: "ai.save", value: form });
      setStatus(result.restartRequired ? "AI 配置已保存；部分部署变化等待重启。" : "AI 与模型配置已保存。");
      setTone(result.restartRequired ? "warning" : "success");
      await refresh();
      toast("AI 与模型配置已保存", "success");
    } catch (cause) {
      setStatus(messageOf(cause, "保存 AI 配置失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  const models = snapshot.models;
  const commitModels = form.commitCli === "codex"
    ? models?.codexModels || []
    : form.commitCli === "opencode"
      ? models?.opencodeModels || []
      : models?.models || [];

  return (
    <section className="wand-settings-panel" aria-label="AI 与模型">
      <header className="wand-settings-panel-heading">
        <h2>AI 与模型</h2><p>集中管理会话默认模型、系统 API 和快捷提交使用的模型。</p>
      </header>

      <SettingsSection
        title="新会话默认模型"
        description="留空表示跟随对应 CLI 默认值；也可以输入列表外的自定义模型。"
        action={<SettingsActionButton pending={pending === "models"} kind="secondary" onClick={() => void refreshModels()}>刷新模型列表</SettingsActionButton>}
      >
        <SettingsGrid>
          <SettingsField label="Claude 默认模型" htmlFor="settings-model-claude" hint="会原样传给 --model">
            <SettingsTextInput id="settings-model-claude" list="settings-models-claude" value={form.defaultModel} placeholder="跟随 Claude 默认" onChange={(value) => update("defaultModel", value)} />
            <ModelSuggestions id="settings-models-claude" models={models?.models || []} />
          </SettingsField>
          <SettingsField label="Codex 默认模型" htmlFor="settings-model-codex" hint="留空则不传模型参数">
            <SettingsTextInput id="settings-model-codex" list="settings-models-codex" value={form.defaultCodexModel} placeholder="跟随 Codex 默认" onChange={(value) => update("defaultCodexModel", value)} />
            <ModelSuggestions id="settings-models-codex" models={models?.codexModels || []} />
          </SettingsField>
          <SettingsField label="OpenCode 默认模型" htmlFor="settings-model-opencode" hint="通常为 provider/model">
            <SettingsTextInput id="settings-model-opencode" list="settings-models-opencode" value={form.defaultOpenCodeModel} placeholder="跟随 OpenCode 默认" onChange={(value) => update("defaultOpenCodeModel", value)} />
            <ModelSuggestions id="settings-models-opencode" models={models?.opencodeModels || []} />
          </SettingsField>
          <SettingsField label="Grok 默认模型" htmlFor="settings-model-grok" hint="留空则不传 --model">
            <SettingsTextInput id="settings-model-grok" list="settings-models-grok" value={form.defaultGrokModel} placeholder="跟随 Grok 默认" onChange={(value) => update("defaultGrokModel", value)} />
            <ModelSuggestions id="settings-models-grok" models={models?.grokModels || []} />
          </SettingsField>
          <SettingsField label="Qoder 默认模型" htmlFor="settings-model-qoder" hint="可选 lite / efficient / auto / performance / ultimate">
            <SettingsTextInput id="settings-model-qoder" list="settings-models-qoder" value={form.defaultQoderModel} placeholder="跟随 Qoder 默认" onChange={(value) => update("defaultQoderModel", value)} />
            <ModelSuggestions id="settings-models-qoder" models={models?.qoderModels || []} />
          </SettingsField>
        </SettingsGrid>
      </SettingsSection>

      <SettingsSection
        title="系统 AI API"
        description="用于提示词优化、会话标题，以及可选的快捷提交。API Key 不会从服务端回传。"
        action={<SettingsActionButton pending={pending === "import"} kind="secondary" onClick={() => void importSystemAi()}>从 CLI 导入</SettingsActionButton>}
      >
        <SettingsToggle
          label="用于系统 AI 功能"
          description="启用提示词优化和会话标题生成。"
          checked={form.systemAi.enabled}
          onCheckedChange={(checked) => updateSystem("enabled", checked)}
        />
        <SettingsGrid>
          <SettingsField label="接口格式">
            <SettingsSelect
              id="settings-system-ai-protocol"
              ariaLabel="系统 AI 接口格式"
              value={form.systemAi.protocol}
              options={[{ value: "openai", label: "OpenAI-compatible" }, { value: "anthropic", label: "Anthropic-compatible" }]}
              onChange={(value) => updateSystem("protocol", value as "openai" | "anthropic")}
            />
          </SettingsField>
          <SettingsField label="认证方式">
            <SettingsSelect
              id="settings-system-ai-auth"
              ariaLabel="系统 AI 认证方式"
              value={form.systemAi.authHeader}
              options={[{ value: "bearer", label: "Bearer Token" }, { value: "x-api-key", label: "x-api-key" }]}
              onChange={(value) => updateSystem("authHeader", value as "bearer" | "x-api-key")}
            />
          </SettingsField>
          <SettingsField label="API 地址" htmlFor="settings-system-ai-url" error={errors.baseUrl}>
            <SettingsTextInput id="settings-system-ai-url" type="url" value={form.systemAi.baseUrl} invalid={!!errors.baseUrl} placeholder="https://api.example.com" onChange={(value) => updateSystem("baseUrl", value)} />
          </SettingsField>
          <SettingsField label="模型" htmlFor="settings-system-ai-model" error={errors.model}>
            <SettingsTextInput id="settings-system-ai-model" value={form.systemAi.model} invalid={!!errors.model} placeholder="例如 gpt-5.5" onChange={(value) => updateSystem("model", value)} />
          </SettingsField>
          <SettingsField label="API Key" htmlFor="settings-system-ai-key" error={errors.apiKey} hint={form.systemAi.hasApiKey ? "已保存；留空会保留现有密钥。" : "仅保存在服务端。"}>
            <SettingsTextInput id="settings-system-ai-key" type="password" autoComplete="new-password" value={form.systemAi.apiKey} invalid={!!errors.apiKey} placeholder={form.systemAi.hasApiKey ? "已保存；留空保持不变" : "输入 API Key"} onChange={(value) => updateSystem("apiKey", value)} />
          </SettingsField>
        </SettingsGrid>
      </SettingsSection>

      <SettingsSection title="Commit 生成" description="选择快捷提交生成 message 与 tag 时使用的 AI 来源。">
        <fieldset className="wand-settings-radio-group">
          <legend>生成方式</legend>
          <label><input type="radio" name="settings-commit-source" value="cli" checked={form.commitAiSource === "cli"} onChange={() => update("commitAiSource", "cli")} />CLI</label>
          <label><input type="radio" name="settings-commit-source" value="api" checked={form.commitAiSource === "api"} onChange={() => update("commitAiSource", "api")} />直连 API</label>
        </fieldset>
        {form.commitAiSource === "api" ? (
          <SettingsStatus tone={form.systemAi.baseUrl && form.systemAi.model && (form.systemAi.apiKey || form.systemAi.hasApiKey) ? "success" : "warning"}>
            {form.systemAi.baseUrl && form.systemAi.model && (form.systemAi.apiKey || form.systemAi.hasApiKey) ? "直连 API 已就绪。" : "请先补全上方直连 API 配置。"}
          </SettingsStatus>
        ) : (
          <SettingsGrid>
            <SettingsField label="Commit CLI">
              <SettingsSelect
                id="settings-commit-cli"
                ariaLabel="Commit 生成 CLI"
                value={form.commitCli}
                options={[{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }, { value: "opencode", label: "OpenCode" }]}
                onChange={(value) => { update("commitCli", value as SettingsProvider); update("commitModel", ""); }}
              />
            </SettingsField>
            <SettingsField label="Commit 模型" htmlFor="settings-commit-model" hint="留空跟随所选 CLI 默认值">
              <SettingsTextInput id="settings-commit-model" list="settings-commit-models" value={form.commitModel} placeholder="跟随 CLI 默认" onChange={(value) => update("commitModel", value)} />
              <ModelSuggestions id="settings-commit-models" models={commitModels} />
            </SettingsField>
          </SettingsGrid>
        )}
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
      setStatus(messageOf(cause, "保存通知偏好失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  async function run(name: string, task: () => Promise<string>) {
    setPending(name);
    setStatus("");
    try {
      setStatus(await task());
      setTone("success");
    } catch (cause) {
      setStatus(messageOf(cause, "通知操作失败。"));
      setTone("error");
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
    <section className="wand-settings-panel" aria-label="通知">
      <header className="wand-settings-panel-heading">
        <h2>通知</h2><p>设置提示音、应用内气泡和系统通知的行为。</p>
      </header>
      <SettingsSection title="通知偏好" description="这些偏好会立即应用，无需点击保存。">
        <SettingsToggle
          label="播放提示音"
          description="重要通知到达时播放柔和提示音。"
          checked={preferences.sound}
          disabled={pending === "preference"}
          onCheckedChange={(sound) => void savePreference({ sound }, sound)}
        />
        {preferences.sound ? (
          <SettingsField label={`提示音音量（${preferences.volume}%）`} htmlFor="settings-notification-volume">
            <input
              id="settings-notification-volume"
              className="wand-settings-range"
              type="range"
              min="0"
              max="100"
              step="5"
              value={preferences.volume}
              aria-label="提示音音量"
              onChange={(event) => {
                const volume = Number(event.currentTarget.value);
                setPreferences((current) => ({ ...current, volume }));
              }}
              onPointerUp={(event) => void savePreference({ volume: Number(event.currentTarget.value) }, true)}
              onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) void savePreference({ volume: Number(event.currentTarget.value) }, true); }}
            />
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
          <SettingsActionButton pending={pending === "sound-preview"} kind="secondary" onClick={() => void run("sound-preview", async () => {
            await repository.execute({ type: "notification.nativeSound.preview", sound: preferences.nativeSound || preferences.nativeSounds[0].id });
            return "已播放铃声预览。";
          })}>试听铃声</SettingsActionButton>
        </SettingsSection>
      ) : null}

      {preferences.hapticsEnabled !== null ? (
        <SettingsSection title="触感反馈" description="按钮操作和任务完成时提供振动反馈。">
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
        <div className="wand-settings-button-row">
          {preferences.permission !== "granted" && preferences.permission !== "unsupported" ? (
            <SettingsActionButton pending={pending === "permission"} kind="primary" onClick={() => void run("permission", async () => {
              const result = await repository.execute({ type: "notification.permission.request" });
              setPreferences((current) => ({ ...current, permission: result.permission }));
              return result.permission === "granted" ? "系统通知已授权。" : "系统通知尚未授权。";
            })}>请求通知权限</SettingsActionButton>
          ) : null}
          {preferences.permission === "denied" ? (
            <WandButton kind="secondary" onClick={() => { setStatus("请在浏览器地址栏左侧的网站设置或系统设置中，将通知改为允许后刷新页面。"); setTone("warning"); }}>如何重置权限</WandButton>
          ) : null}
          <SettingsActionButton pending={pending === "test"} kind="secondary" onClick={() => void run("test", async () => {
            const result = await repository.execute({ type: "notification.test" });
            toast("测试通知", "info");
            return `提示音：${result.sound === "passed" ? "通过" : "失败"}；气泡：${result.bubble === "passed" ? "通过" : "已关闭"}；系统：${result.system}`;
          })}>立即测试</SettingsActionButton>
          <SettingsActionButton pending={pending === "delayed-test"} kind="secondary" onClick={() => void run("delayed-test", async () => {
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
  const { snapshot, repository, refresh, toast } = _props;
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [certFile, setCertFile] = useState<File | null>(null);
  const [pending, setPending] = useState("");
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
    setPending("password");
    setStatus("");
    try {
      const result = await repository.execute({ type: "password.change", password });
      setPassword("");
      setConfirmation("");
      setStatus("密码修改成功；所有旧登录会话已失效，正在返回登录页…");
      setTone("success");
      toast("密码已修改，请重新登录", "success");
      if (result.reauthenticationRequired) {
        window.setTimeout(() => {
          settingsStore.setNested(null);
          window.location.reload();
        }, 650);
      }
    } catch (cause) {
      setStatus(messageOf(cause, "修改密码失败。"));
      setTone("error");
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
    setPending("certificate");
    setStatus("");
    try {
      const [key, cert] = await Promise.all([keyFile.text(), certFile.text()]);
      const result = await repository.execute({ type: "certificate.upload", key, cert });
      setStatus(result.restartRequired ? "证书已上传，重启服务后生效。" : "证书已上传。 ");
      setTone("success");
      await refresh();
      toast("SSL 证书已上传", "success");
    } catch (cause) {
      setStatus(messageOf(cause, "上传证书失败。"));
      setTone("error");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="wand-settings-panel" aria-label="安全">
      <header className="wand-settings-panel-heading">
        <h2>安全</h2><p>管理登录密码与 SSL 证书。敏感变更保存前请仔细确认。</p>
      </header>
      <SettingsSection title="修改密码" description="至少 6 个字符；保存后会撤销包括当前页面在内的所有登录会话。">
        <form className="wand-settings-security-form" onSubmit={(event) => { event.preventDefault(); void changePassword(); }}>
          <input type="text" name="username" autoComplete="username" value="wand" readOnly hidden />
          <SettingsGrid>
            <SettingsField label="新密码" htmlFor="settings-new-password" error={passwordError}>
              <SettingsTextInput id="settings-new-password" type="password" autoComplete="new-password" value={password} invalid={!!passwordError} placeholder="输入新密码" onChange={(value) => { setPassword(value); setPasswordError(""); }} />
            </SettingsField>
            <SettingsField label="确认密码" htmlFor="settings-confirm-password">
              <SettingsTextInput id="settings-confirm-password" type="password" autoComplete="new-password" value={confirmation} invalid={!!passwordError} placeholder="再次输入新密码" onChange={(value) => { setConfirmation(value); setPasswordError(""); }} />
            </SettingsField>
          </SettingsGrid>
          <SettingsActionButton type="submit" pending={pending === "password"} kind="primary">修改密码并重新登录</SettingsActionButton>
        </form>
      </SettingsSection>

      <SettingsSection title="SSL 证书" description={`当前状态：${snapshot.hasCert ? "已安装证书" : "未安装证书（使用自签名或 HTTP）"}`}>
        <div className="wand-settings-file-grid">
          <label>
            <span>私钥文件（server.key）</span>
            <input aria-label="SSL 私钥文件" type="file" accept=".key,.pem,text/plain" onChange={(event) => setKeyFile(event.currentTarget.files?.[0] || null)} />
            <small>{keyFile?.name || "未选择文件"}</small>
          </label>
          <label>
            <span>证书文件（server.crt）</span>
            <input aria-label="SSL 证书文件" type="file" accept=".crt,.pem,text/plain" onChange={(event) => setCertFile(event.currentTarget.files?.[0] || null)} />
            <small>{certFile?.name || "未选择文件"}</small>
          </label>
        </div>
        <SettingsActionButton pending={pending === "certificate"} kind="primary" onClick={() => void uploadCertificate()}>上传证书</SettingsActionButton>
      </SettingsSection>
      {status ? <SettingsStatus tone={tone}>{status}</SettingsStatus> : null}
    </section>
  );
}

export function PresetSettingsTab({ snapshot }: SettingsTabProps) {
  const presets = snapshot.config?.commandPresets || [];
  return (
    <section className="wand-settings-panel" aria-label="命令预设">
      <header className="wand-settings-panel-heading">
        <h2>命令预设</h2><p>预设由服务端配置管理，可在创建会话时快速选择。</p>
      </header>
      <div className="wand-settings-preset-list" aria-label="已有命令预设">
        {presets.map((preset, index) => (
          <article className="wand-settings-preset" key={`${preset.label}-${index}`}>
            <strong>{preset.label || "未命名预设"}</strong>
            <code>{preset.command}</code>
            {preset.mode ? <span>模式：{preset.mode}</span> : null}
          </article>
        ))}
        {presets.length === 0 ? <div className="wand-settings-empty">没有命令预设；可在 config.json 的 commandPresets 中配置。</div> : null}
      </div>
    </section>
  );
}

const CARD_OPTIONS: Array<{ key: keyof SettingsCardDefaults; title: string; description: string }> = [
  { key: "editCards", title: "文件编辑", description: "Edit / Write 工具结果" },
  { key: "inlineTools", title: "内联工具", description: "Read / Glob / Grep 工具结果" },
  { key: "terminal", title: "终端输出", description: "Bash 命令执行结果" },
  { key: "thinking", title: "思考过程", description: "模型的 Thinking 内容" },
  { key: "toolGroup", title: "工具组", description: "连续同类工具调用的折叠组" },
];

export function DisplaySettingsTab({ snapshot, repository, refresh, toast }: SettingsTabProps) {
  const [value, setValue] = useState<SettingsCardDefaults>(() => ({ ...snapshot.config!.cardDefaults }));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<StatusTone>("info");

  useEffect(() => setValue({ ...snapshot.config!.cardDefaults }), [snapshot]);

  async function save() {
    setPending(true);
    setStatus("");
    try {
      await repository.execute({ type: "display.save", value });
      setStatus("显示设置已保存，并会立即应用于之后渲染的卡片。");
      setTone("success");
      await refresh();
      toast("显示设置已保存", "success");
    } catch (cause) {
      setStatus(messageOf(cause, "保存显示设置失败。"));
      setTone("error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="wand-settings-panel" aria-label="显示">
      <header className="wand-settings-panel-heading">
        <h2>显示</h2><p>设置各类结果卡片的默认展开状态。</p>
      </header>
      <SettingsSection title="默认展开的卡片" description="手动展开或收起仍会按会话记录。">
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
