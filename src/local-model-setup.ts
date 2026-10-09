import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionError, type LocalDecisionConfig } from "./decision-types.js";
import type { DecisionService } from "./decision-service.js";
import { LAYA_FILES, LAYA_REPOSITORY, layaFileUrl, type ModelFile } from "./laya-model-manifest.js";
import { ModelFileStore } from "./model-file-store.js";
import { runModelSetup } from "./model-setup-process.js";
import { speechModel } from "./speech-models.js";
import type { SpeechService } from "./speech-service.js";
import { systemEnvValue } from "./env-utils.js";
import { decisionHardware } from "./decision-hardware.js";
import { DECISION_EXPERT_ID } from "./decision-expert-identity.js";
import type { LocalModelKind, LocalModelsStatus, ModelSetupInput, ModelSetupOperation, ModelSetupPhase } from "./local-model-types.js";

export interface LocalModelSetupDeps {
  configDir: string;
  decisions: DecisionService;
  speech: SpeechService;
  decisionConfig(): LocalDecisionConfig;
  /** Synchronous storage transaction + live service/config update, only after validation. */
  configureDecision(config: LocalDecisionConfig): void;
  fetch?: typeof fetch;
  layaFiles?: readonly ModelFile[];
  supportedLaya?: () => boolean;
  run?: typeof runModelSetup;
  checkRuntime?: (python: string, signal: AbortSignal) => Promise<boolean>;
  timeoutMs?: number;
}

/** Deployment jobs only; existing inference owners retain their protocols, rate limits and capabilities. */
export class LocalModelSetupService {
  private readonly files: ModelFileStore;
  private readonly root: string;
  private readonly manifest: readonly ModelFile[];
  private readonly operations = new Map<LocalModelKind, ModelSetupOperation>();
  private readonly jobs = new Map<LocalModelKind, { abort: AbortController; promise: Promise<void> }>();
  private sequence = 0;
  private disposed = false;
  constructor(private readonly deps: LocalModelSetupDeps) {
    this.files = new ModelFileStore(deps.fetch);
    this.root = path.join(deps.configDir, "local-models", "laya");
    this.manifest = deps.layaFiles ?? LAYA_FILES;
  }
  private supported(): boolean { return (this.deps.supportedLaya ?? (() => decisionHardware().suitable))(); }
  private managedModel(): string { return path.join(this.root, "model"); }
  private async layaModel(): Promise<{ modelPath: string; downloaded: boolean }> {
    const current = this.deps.decisionConfig().modelPath;
    if (current && path.isAbsolute(current) && await this.files.ready(current, this.manifest)) return { modelPath: current, downloaded: true };
    const managed = this.managedModel();
    return { modelPath: managed, downloaded: await this.files.ready(managed, this.manifest) };
  }
  private async python(): Promise<string | null> {
    const current = this.deps.decisionConfig().pythonPath;
    if (current && path.isAbsolute(current) && existsSync(current)) return current;
    try {
      const receipt = JSON.parse(await readFile(path.join(this.root, "runtime.json"), "utf8"));
      if (receipt.layaVersion === "0.3.0" && receipt.mlxVersion === "0.32.2" && typeof receipt.pythonPath === "string"
        && receipt.pythonPath.startsWith(path.join(this.root, "environments") + path.sep) && existsSync(receipt.pythonPath)) return receipt.pythonPath;
    } catch {}
    return null;
  }
  async status(): Promise<LocalModelsStatus> {
    const [model, python, speech] = await Promise.all([this.layaModel(), this.python(), this.deps.speech.status()]);
    const decision = this.deps.decisions.status();
    const supported = this.supported();
    const hardware = decisionHardware();
    const operation = this.operations.get("laya") ?? null;
    const selected = speech.models.find((value) => value.id === speech.settings.model);
    return {
      laya: { kind: "laya", label: "LAYA 本地决策", supported,
        reason: !supported ? hardware.message
          : !model.downloaded ? "模型尚未下载或完整性校验失败。" : !python ? "独立 Python/MLX 运行时尚未初始化。" : null,
        enabled: decision.enabled, model: LAYA_REPOSITORY, modelSize: this.manifest.reduce((sum, file) => sum + file.size, 0),
        downloaded: model.downloaded, runtimeAvailable: !!python, initialized: decision.state === "ready", busy: this.jobs.has("laya") || decision.queued > 0 || decision.state === "loading",
        operation: operation ? { ...operation } : null, hardware, decisionEmployeeId: DECISION_EXPERT_ID },
      speech: { kind: "speech", label: "服务端语音识别", supported: ["darwin", "linux", "win32"].includes(process.platform), reason: speech.reason,
        enabled: speech.settings.enabled, model: speech.settings.model, modelSize: selected?.size ?? 0,
        downloaded: selected?.downloaded ?? false, runtimeAvailable: speech.runtime.available, initialized: speech.initialized === true,
        busy: speech.busy || this.jobs.has("speech"), operation: this.operations.has("speech") ? { ...this.operations.get("speech")! } : null },
    };
  }
  private parse(kind: LocalModelKind, raw: unknown): ModelSetupInput {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DecisionError("INVALID_REQUEST", "模型操作参数无效。");
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["model", "backend"].includes(key))
      || (body.model !== undefined && typeof body.model !== "string")
      || (body.backend !== undefined && !["auto", "cpu", "metal", "cuda"].includes(body.backend as string))) {
      throw new DecisionError("INVALID_REQUEST", "仅允许选择固定模型与受支持的后端；不接受命令、路径或URL。");
    }
    if (kind === "laya" && ((body.model && body.model !== LAYA_REPOSITORY) || body.backend !== undefined)) throw new DecisionError("INVALID_MODEL", "LAYA 使用固定多语言 MLX 模型。");
    if (kind === "speech" && body.model !== undefined && !speechModel(body.model as string)) throw new DecisionError("INVALID_MODEL", "未知语音模型。");
    if (body.backend === "metal" && process.platform !== "darwin") throw new DecisionError("UNSUPPORTED", "Metal 仅适用于 macOS。");
    return body as ModelSetupInput;
  }
  start(kind: LocalModelKind, action: "download" | "initialize", raw: unknown): void {
    if (this.disposed) throw new DecisionError("UNAVAILABLE", "模型管理已关闭。", 503);
    if (kind === "laya" && !this.supported()) throw new DecisionError("UNSUPPORTED", `LAYA-MLX 需要 Apple Silicon macOS 与 Metal；${decisionHardware().message}`, 409);
    const input = this.parse(kind, raw);
    if (this.jobs.has(kind)) throw new DecisionError("BUSY", "该模型已有安装任务，请等待或取消。", 409);
    if (kind === "laya") this.deps.decisions.assertConfigurable();
    if (kind === "speech" && action === "initialize") this.deps.speech.acquireMaintenance();
    const abort = new AbortController(), id = ++this.sequence;
    this.operations.set(kind, { id, action, phase: "verifying", message: "检查已安装资源，不覆盖既有环境", received: 0, total: null });
    const promise = this.work(kind, action, input, abort, id).catch(() => {}).finally(() => {
      if (kind === "speech" && action === "initialize") this.deps.speech.releaseMaintenance();
      if (this.jobs.get(kind)?.abort === abort) this.jobs.delete(kind);
    });
    this.jobs.set(kind, { abort, promise });
    // Failure is represented by operation status. Always observe the background promise.
    void promise;
  }
  private update(kind: LocalModelKind, id: number, patch: Partial<ModelSetupOperation>): void {
    const current = this.operations.get(kind);
    if (current?.id === id) this.operations.set(kind, { ...current, ...patch });
  }
  private async work(kind: LocalModelKind, action: "download" | "initialize", input: ModelSetupInput, abort: AbortController, id: number): Promise<void> {
    const timer = setTimeout(() => abort.abort(), this.deps.timeoutMs ?? 30 * 60_000); timer.unref();
    const signal = abort.signal;
    const phase = (value: ModelSetupPhase, message: string): void => this.update(kind, id, { phase: value, message });
    try {
      if (kind === "laya") {
        let model = await this.layaModel(); signal.throwIfAborted();
        if (action === "download") {
          phase("downloading", "下载固定多语言 LAYA 模型与 tokenizer（不下载聊天模型）");
          await this.files.download(model.modelPath, this.manifest, layaFileUrl, signal,
            (received, total) => this.update(kind, id, { received, total }));
        } else {
          if (!model.downloaded) throw new Error("请先下载并校验 LAYA 模型，再初始化运行环境。");
          let python = await this.python(); signal.throwIfAborted();
          if (python) {
            phase("verifying", "检查已配置 Python 的 LAYA / MLX 版本与 Metal 能力，不修改该环境");
            const compatible = await this.checkRuntime(python, signal);
            signal.throwIfAborted();
            if (!compatible) python = null;
          }
          if (!python) {
            phase("runtime", "安装独立 LAYA / MLX 环境，需服务器具备 Python 3.11+；不修改系统 Python");
            await mkdir(path.join(this.root, "environments"), { recursive: true, mode: 0o700 });
            const environment = path.join(this.root, "environments", `setup-${id}-${Date.now()}`);
            try {
              await (this.deps.run ?? runModelSetup)(process.execPath,
                [this.installer("install-laya-runtime.js"), "--dir", this.root, "--environment", environment, "--events"], this.deps.configDir, signal,
                (name, message) => phase(name === "verifying" ? "verifying" : "runtime", message));
            } catch (error) { await rm(environment, { recursive: true, force: true }).catch(() => {}); throw error; }
            const receipt = JSON.parse(await readFile(path.join(this.root, "runtime.json"), "utf8"));
            python = typeof receipt.pythonPath === "string" && receipt.pythonPath.startsWith(path.join(this.root, "environments") + path.sep) && existsSync(receipt.pythonPath)
              ? receipt.pythonPath : null;
            if (!python) throw new Error("独立运行时校验未通过。请检查 Python 3.11+、PyPI 网络、Metal 和磁盘空间。");
          }
          signal.throwIfAborted();
          model = await this.layaModel();
          if (!model.downloaded) throw new Error("LAYA 模型校验失败，请重新下载。");
          const current = this.deps.decisionConfig();
          if (current.pythonPath !== python || current.modelPath !== model.modelPath) {
            this.deps.configureDecision({ enabled: current.enabled, pythonPath: python, modelPath: model.modelPath });
          }
          phase("initializing", "加载并检查 LAYA 模型，未自动启用、派工或授予任何工具权限");
          await this.deps.decisions.initialize(signal);
        }
      } else {
        const selected = input.model ?? this.deps.speech.settings().model;
        if (action === "download") {
          phase("downloading", "下载并校验语音模型");
          await this.deps.speech.startDownload(selected);
          while (true) {
            signal.throwIfAborted();
            const status = await this.deps.speech.status();
            if (status.download?.phase === "failed") throw new Error(status.download.error || "语音模型下载失败。");
            if (!status.download || status.download.phase !== "downloading") break;
            this.update(kind, id, { received: status.download.received, total: status.download.total });
            await new Promise<void>((resolve, reject) => {
              const cancelled = (): void => { clearTimeout(delay); reject(new Error("Cancelled")); };
              const delay = setTimeout(() => { signal.removeEventListener("abort", cancelled); resolve(); }, 250);
              signal.addEventListener("abort", cancelled, { once: true });
            });
          }
        } else {
          const status = await this.deps.speech.status(); signal.throwIfAborted();
          const backend = input.backend === "auto" || !input.backend ? process.platform === "darwin" ? "metal" : "cpu" : input.backend;
          if (!status.models.find((value) => value.id === selected)?.downloaded) throw new Error("请先下载所选语音模型，再初始化。");
          if (!status.runtime.available || (input.backend && input.backend !== "auto" && status.runtime.backend !== backend)) {
            if (systemEnvValue("WAND_WHISPER_BIN")) throw new Error("服务器使用自定义语音运行时，请由管理员核对环境配置；不会覆盖它。");
            phase("runtime", "安装固定 whisper.cpp 运行时（需 Git、CMake、C++工具链；CUDA需已安装Toolkit）");
            await mkdir(path.join(this.deps.configDir, "speech"), { recursive: true, mode: 0o700 });
            const work = await mkdtemp(path.join(this.deps.configDir, "speech", ".setup-work-"));
            try {
              await (this.deps.run ?? runModelSetup)(process.execPath,
                [this.installer("install-speech-runtime.js"), "--dir", path.join(this.deps.configDir, "speech"), "--backend", backend, "--work-dir", work, "--events"], this.deps.configDir, signal,
                (name, message) => phase(name === "verifying" ? "verifying" : "runtime", message));
            } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
          }
          phase("initializing", "加载所选语音模型并用合成静音检查，未启用识别或重启服务");
          await this.deps.speech.initializeModel(selected, signal);
        }
      }
      signal.throwIfAborted();
      phase("completed", action === "download" ? "模型下载及完整性校验完成；可继续初始化" : "运行时和模型初始化检查完成；启用状态保持不变");
    } catch (error) {
      const cancelled = signal.aborted;
      const message = cancelled ? "安装任务已取消，完整文件保留，可重试" : error instanceof DecisionError || (error instanceof Error && /请先|校验|自定义|独立/.test(error.message))
        ? error.message : "安装或初始化失败，请检查网络、编译工具/Python版本、磁盘空间和平台能力，再重试。";
      this.update(kind, id, { phase: cancelled ? "cancelled" : "failed", message, ...(cancelled ? {} : { error: message }) });
      if (kind === "speech" && action === "download" && cancelled) this.deps.speech.cancelDownload();
    } finally { clearTimeout(timer); }
  }
  private async checkRuntime(python: string, signal: AbortSignal): Promise<boolean> {
    if (this.deps.checkRuntime) return this.deps.checkRuntime(python, signal);
    try {
      await runModelSetup(python, ["-c", "import importlib.metadata as m; import mlx.core as mx; import laya_mlx; assert m.version('laya-mlx') == '0.3.0'; assert m.version('mlx') == '0.32.2'; assert mx.metal.is_available()"],
        this.deps.configDir, signal, () => {}, 30_000);
      return true;
    } catch { return false; }
  }
  private installer(name: string): string { return fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)); }
  cancel(kind: LocalModelKind): void { this.jobs.get(kind)?.abort.abort(); }
  setLayaEnabled(enabled: boolean): void {
    if (this.jobs.has("laya")) throw new DecisionError("BUSY", "LAYA 安装任务进行中，请稍后修改。", 409);
    if (enabled && !this.supported()) throw new DecisionError("UNSUPPORTED", "当前平台不支持 LAYA-MLX。", 409);
    this.deps.configureDecision({ ...this.deps.decisionConfig(), enabled });
  }
  dispose(): void { this.disposed = true; for (const job of this.jobs.values()) job.abort.abort(); }
}
