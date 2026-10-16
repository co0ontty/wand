import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { buildChildEnv } from "./env-utils.js";
import { acquireDeploymentLock, releaseDeploymentLock } from "./deployment-lock.js";
import { parseOpenCodeModelRecords } from "./models/parsers/opencode.js";
import { orderModelIds, type ModelGroup } from "./model-groups.js";
import { isOpenCodeNativeModelId, OPENCODE_FREE_GROUP_ID, OPENCODE_FREE_GROUP_SELECTOR } from "./opencode-free-selection.js";
import { AI_TEAM_MAX_CANDIDATES } from "./ai-team-types.js";
import { systemEmployeeDefaultAgents } from "./system-employee.js";
import { whichSync } from "./path-repair.js";
import { parseProviderCliVersion } from "./provider-cli-updater.js";
import { asRecord } from "./structured-content.js";
import { redactSystemAiText } from "./system-ai-redaction.js";
import type { WandStorage } from "./storage.js";
import type { AiCliCandidate } from "./types.js";

export interface OpenCodeTextRuntime { cwd: string; env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv }
export interface OpenCodeFreePool {
  candidates(signal?: AbortSignal): Promise<AiCliCandidate[]>;
  execution: OpenCodeTextRuntime;
}
const pools = new WeakMap<object, OpenCodeFreePool>();
export function registerOpenCodeFreePool(owner: object, pool: OpenCodeFreePool): () => void {
  pools.set(owner, pool);
  return () => { if (pools.get(owner) === pool) pools.delete(owner); };
}
export function openCodeFreePool(owner: object): OpenCodeFreePool | undefined { return pools.get(owner); }
/** One requested default migration, not a restart-time rewrite of later user edits. */
export function adoptSystemOpenCodeFreeDefault(storage: WandStorage): "adopted" | "unchanged" | "full" {
  return storage.transaction(() => {
    const key = "migration:system-opencode-free-default:v1";
    if (storage.getConfigValue(key)) return "unchanged";
    const employee = storage.getSystemSiliconEmployee();
    if (!employee) return "unchanged";
    if (employee.agents.some(agent => agent.provider === "opencode" && agent.model === OPENCODE_FREE_GROUP_SELECTOR)) {
      storage.setConfigValue(key, "done"); return "unchanged";
    }
    if (employee.agents.length >= AI_TEAM_MAX_CANDIDATES) return "full";
    storage.saveSiliconEmployee({ ...employee, agents: [...systemEmployeeDefaultAgents(), ...employee.agents], updatedAt: new Date().toISOString() });
    storage.setConfigValue(key, "done"); return "adopted";
  });
}

export const OPENCODE_FREE_REFRESH_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "opencode-free-models-v1";
const NATIVE_SDKS = new Set(["@ai-sdk/openai-compatible", "@ai-sdk/openai"]);

/** Price, native route and capabilities are all mandatory; never trust names or bare IDs. */
export function parseOpenCodeFreeModels(stdout: string): string[] {
  const zero = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value === 0;
  const allZero = (value: unknown): boolean => {
    if (zero(value)) return true;
    const row = asRecord(value);
    return !!row && Object.keys(row).length > 0 && Object.values(row).every(allZero);
  };
  return [...new Set(parseOpenCodeModelRecords(stdout).flatMap(({ id, record }) => {
    const api = asRecord(record.api), cost = asRecord(record.cost), capabilities = asRecord(record.capabilities);
    if (!isOpenCodeNativeModelId(id) || record.providerID !== "opencode" || record.status !== "active"
      || api?.id !== id.slice("opencode/".length) || api.url !== "https://opencode.ai/inference/v1"
      || typeof api.npm !== "string" || !NATIVE_SDKS.has(api.npm) || !cost || !zero(cost.input) || !zero(cost.output) || !allZero(cost)
      || asRecord(capabilities?.input)?.text !== true || asRecord(capabilities?.output)?.text !== true
      || capabilities?.toolcall !== true) return [];
    return [id];
  }))].sort().slice(0, 128);
}

const execFileAsync = promisify(execFile);
type CommandOptions = { env: NodeJS.ProcessEnv; timeout: number; signal: AbortSignal; cwd?: string };
export type OpenCodeSetupRunner = (file: string, args: string[], options: CommandOptions) => Promise<{ stdout: string }>;
const runCommand: OpenCodeSetupRunner = async (file, args, options) => {
  if (args[0] !== "install" || process.platform === "win32") {
    const { stdout } = await execFileAsync(file, args, { ...options, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
    return { stdout };
  }
  // Hold the install lease until npm and every owned postinstall child have exited.
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: options.env, detached: true, stdio: "ignore" });
    let failure: Error | undefined;
    const stop = () => {
      failure ??= new Error("OpenCode 安装已取消或超时。");
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    };
    const timer = setTimeout(stop, options.timeout);
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    child.on("error", error => { failure = error; });
    child.once("close", code => {
      void (async () => {
        if (code !== 0) { failure ??= new Error("OpenCode 安装失败。"); stop(); }
        if (child.pid) {
          while (true) {
            try { process.kill(-child.pid, 0); }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") break; throw cause; }
            await new Promise(done => setTimeout(done, 50));
          }
        }
        if (failure) throw failure;
        return { stdout: "" };
      })().then(resolve, reject).finally(() => { clearTimeout(timer); options.signal.removeEventListener("abort", stop); });
    });
  });
};

/** Server-maintained saved group: discover, really probe, add new members, remove retired/failed ones. */
export class OpenCodeFreeModelsService implements OpenCodeFreePool {
  private controller = new AbortController();
  private setup: Promise<string> | undefined;
  private pending: Promise<void> | undefined;
  private retryAfter = 0;
  private disposed = false;
  private timer: NodeJS.Timeout | undefined;
  private verified: string[] = [];
  private syncedAt = 0;
  private probeErrors = new Map<string, string>();
  private catalogSequence = 0;
  private committedSequence = 0;
  readonly execution: OpenCodeTextRuntime;
  constructor(private readonly options: {
    configDir: string;
    inheritEnv?: boolean;
    storage?: Pick<WandStorage, "getConfigValue" | "setConfigValue" | "getPreference">;
    run?: OpenCodeSetupRunner;
    find?: (command: string, env: NodeJS.ProcessEnv) => string | null;
    probe?: (model: string, runtime: OpenCodeTextRuntime, signal: AbortSignal) => Promise<boolean>;
    onModelsChanged?: (models: string[]) => void;
    onLog?: (line: string) => void;
    now?: () => number;
  }) {
    const root = path.join(options.configDir, "tools", "opencode-system");
    this.execution = { cwd: path.join(root, "work"), env: base => {
      const env = { ...base };
      for (const name of Object.keys(env)) if (name.startsWith("OPENCODE_")) delete env[name];
      return { ...env, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"), OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", compaction: { auto: false }, agent: { title: { disable: true } } }) };
    } };
    try {
      const saved = JSON.parse(options.storage?.getConfigValue(CACHE_KEY) ?? "{}");
      if (saved.version === 1 && Array.isArray(saved.models) && Number.isFinite(saved.syncedAt)) {
        this.verified = saved.models.filter((id: unknown): id is string => typeof id === "string" && isOpenCodeNativeModelId(id)).slice(0, 128);
        this.syncedAt = saved.syncedAt;
      }
    } catch { /* malformed proof is rediscovered; never adopt the editable group as proof */ }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private env(): NodeJS.ProcessEnv { return buildChildEnv(this.options.inheritEnv !== false); }
  private find(command: string): string | null {
    return this.options.find ? this.options.find(command, this.env()) : whichSync(command, { env: this.env() });
  }
  private async run(file: string, args: string[], timeout: number, signal = this.controller.signal): Promise<string> {
    const nativeModels = args[0] === "models";
    const result = await (this.options.run ?? runCommand)(file, args, { env: nativeModels ? this.execution.env(this.env()) : this.env(), timeout,
      ...(nativeModels ? { cwd: this.execution.cwd } : {}), signal: AbortSignal.any([signal, this.controller.signal]) });
    this.controller.signal.throwIfAborted(); return result.stdout;
  }
  private addPath(directory: string): void {
    const entries = (process.env.PATH ?? "").split(path.delimiter);
    if (!entries.includes(directory)) process.env.PATH = [...entries, directory].filter(Boolean).join(path.delimiter);
  }
  private async prepare(): Promise<string> {
    this.controller.signal.throwIfAborted();
    mkdirSync(this.execution.cwd, { recursive: true, mode: 0o700 });
    let executable = this.find("opencode");
    if (!executable) {
      const prefix = path.join(this.options.configDir, "tools", "opencode");
      this.addPath(path.join(prefix, "node_modules", ".bin")); executable = this.find("opencode");
      if (!executable) {
        const npm = this.find(process.platform === "win32" ? "npm.cmd" : "npm");
        if (!npm) throw new Error("未找到 npm，无法准备 OpenCode 免费分组。");
        mkdirSync(path.dirname(prefix), { recursive: true, mode: 0o700 });
        const lock = acquireDeploymentLock(`${prefix}.install-lock`);
        try {
          this.options.onLog?.("正在安装系统免费分组所需的 opencode-ai（用户级独立目录）。");
          await this.run(npm, ["install", "--global=false", "--prefix", prefix, "--no-audit", "--no-fund", "opencode-ai@latest"], 180_000);
        } finally { releaseDeploymentLock(lock); }
        executable = this.find("opencode");
        if (!executable) throw new Error("OpenCode 安装后仍不可执行。");
      }
    }
    const version = parseProviderCliVersion(await this.run(executable, ["--version"], 8_000));
    if (!version || /^0\.0\./.test(version)) throw new Error("现有 OpenCode 版本不可用；未覆盖用户安装。");
    return executable;
  }
  private ensure(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("OpenCode 免费分组已停止。"));
    if (this.setup) return this.setup;
    if (this.now() < this.retryAfter) return Promise.reject(new Error("OpenCode 免费分组准备失败，稍后重试。"));
    const setup = this.prepare(); this.setup = setup;
    void setup.catch(() => { if (this.setup === setup) { this.setup = undefined; this.retryAfter = this.now() + 60_000; } });
    return setup;
  }
  private async discover(signal?: AbortSignal): Promise<{ models: string[]; sequence: number }> {
    signal?.throwIfAborted(); const sequence = ++this.catalogSequence;
    const executable = await this.ensure(); signal?.throwIfAborted();
    return { sequence, models: parseOpenCodeFreeModels(await this.run(executable, ["models", "opencode", "--verbose", "--refresh", "--pure"], 15_000, signal)) };
  }
  private async probe(model: string): Promise<boolean> {
    try {
      if (this.options.probe) return await this.options.probe(model, this.execution, this.controller.signal);
      const { callCliAiText } = await import("./ai-text-runner.js");
      const text = await callCliAiText({ system: "只输出简短中文标题，不要使用工具，不要解释。", prompt: "用户正在验证系统免费模型连接。" },
        this.execution.cwd, "中文", { provider: "opencode", model, thinkingEffort: "off", opencodeRuntime: this.execution,
          signal: this.controller.signal, deadline: Date.now() + 20_000 });
      return text.trim().length > 0;
    } catch (error) {
      const message = redactSystemAiText(error instanceof Error ? error.message : String(error)).slice(0, 8_000);
      this.probeErrors.set(model, message);
      this.options.onLog?.(`OpenCode 免费模型验证失败 ${model}：${message}`);
      return false;
    }
  }
  private ordered(models: string[]): string[] {
    const preferred = this.options.storage?.getPreference<ModelGroup[]>("pref:modelGroups", [])
      .find(group => group.provider === "opencode" && group.id === OPENCODE_FREE_GROUP_ID)?.models ?? [];
    return orderModelIds(models, preferred);
  }
  restoreSavedGroup(): void { this.options.onModelsChanged?.(this.ordered(this.verified)); }
  private publish(models: string[], sequence: number, probed = true): void {
    this.controller.signal.throwIfAborted();
    if (sequence < this.committedSequence) return;
    this.committedSequence = sequence;
    this.verified = this.ordered(models);
    if (probed) this.syncedAt = this.now();
    this.options.storage?.setConfigValue(CACHE_KEY, JSON.stringify({ version: 1, models: this.verified, syncedAt: this.syncedAt }));
    this.options.onModelsChanged?.([...this.verified]);
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = (async () => {
      const { models, sequence } = await this.discover(), passed = new Set<string>(); let next = 0;
      this.probeErrors.clear();
      await Promise.all(Array.from({ length: Math.min(2, models.length) }, async () => {
        while (!this.controller.signal.aborted) {
          const model = models[next++]; if (!model) break;
          if (await this.probe(model)) passed.add(model);
        }
      }));
      this.publish(models.filter(model => passed.has(model)), sequence);
      this.options.onLog?.(`OpenCode 免费分组同步完成：${this.verified.length} 个实测可用，${models.length - this.verified.length} 个未通过；每6小时重新校验。`);
    })();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    return pending;
  }
  async candidates(signal?: AbortSignal): Promise<AiCliCandidate[]> {
    signal?.throwIfAborted();
    if (!this.syncedAt || this.now() - this.syncedAt >= OPENCODE_FREE_REFRESH_MS) await this.refresh();
    const { models: pricedIds, sequence } = await this.discover(signal); signal?.throwIfAborted();
    if (sequence < this.committedSequence) throw new Error("OpenCode 免费目录已变化，请重试。");
    this.committedSequence = sequence;
    const priced = new Set(pricedIds), models = this.verified.filter(model => priced.has(model));
    // Price-only removal must not renew the original usability-proof timestamp.
    if (models.length !== this.verified.length) this.publish(models, sequence, false);
    const errors = [...this.probeErrors].filter(([id]) => priced.has(id));
    if (!models.length && errors.length) throw new Error(`OpenCode 免费分组暂时没有实测可用模型：\n${errors.map(([id, error]) => `${id}: ${error}`).join("\n").slice(0, 16_000)}`);
    return this.ordered(models).map(model => ({ provider: "opencode", model, thinkingEffort: "off" }));
  }
  start(): void {
    if (this.timer || this.disposed) return;
    const refresh = () => { void this.refresh().catch(() => { if (!this.disposed) this.options.onLog?.("OpenCode 免费分组同步失败；保留上次快照，调用前仍需原生价格检查。"); }); };
    refresh(); this.timer = setInterval(refresh, OPENCODE_FREE_REFRESH_MS); this.timer.unref();
  }
  dispose(): void { this.disposed = true; this.controller.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
