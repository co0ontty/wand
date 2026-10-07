import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getErrorMessage } from "./error-utils.js";
import type { HarnessConfig, SessionProvider } from "./types.js";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** core = Wand 进程内跑 agent loop；cli = 既有 CLI runner。 */
export type RunEngine = "core" | "cli";

/** core 引擎首期只服务 pi：只有它的事件流与 Pi 官方 harness 同源。 */
export const CORE_HARNESS_PROVIDERS: readonly SessionProvider[] = ["pi"];

export interface CoreHarnessStatus {  /** 至少有一个已认证 provider 且能解析出 chat 模型。 */
  available: boolean;
  /** 不可用或降级原因（人类可读，可直接给客户端展示）。 */
  reason: string;
  /** 已认证的 Pi provider 数。 */
  providerCount: number;
  /** 可用 chat 模型数。 */
  modelCount: number;
  /**
   * 实际使用的 agent 目录。
   */
  agentDir: string;
}

export interface EngineResolution {
  engine: RunEngine;
  /** 选这个引擎的原因（降级时可直接给用户看）。 */
  reason: string;
}

export class CoreHarnessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreHarnessUnavailableError";
  }
}

export interface ResolvedCoreModel {
  model: Model<Api>;
  /** Pi 侧 provider id（anthropic / openai-codex / xai …），不是 Wand 的 session provider。 */
  providerId: string;
  modelId: string;
  /** 该 provider 是否走订阅（用于 UI 提示与默认挑选偏好）。 */
  subscription: boolean;
}

interface CoreHarnessHandle {
  runtime: ModelRuntime;
  agentDir: string;
}

type PiAiModule = typeof import("@earendil-works/pi-ai");

let piAiPromise: Promise<PiAiModule> | null = null;
let handlePromise: Promise<CoreHarnessHandle> | null = null;
let handleError: { at: number; reason: string; agentDir: string } | null = null;
let cachedAgentDir = "";
let statusCache: { at: number; agentDir: string; status: CoreHarnessStatus } | null = null;
/** 正在进行的探测：并发调用共享同一次探测，不重复起多个。 */
let refreshing: { agentDir: string; promise: Promise<CoreHarnessStatus> } | null = null;

/** 状态缓存窗口：认证/模型目录变化由 Pi 自己写入磁盘，这里只避免高频探测。 */
const STATUS_TTL_MS = 10 * 60 * 1000;

/** 探测超时：core 预热不能拖住服务启动。 */
const STATUS_PROBE_TIMEOUT_MS = 15_000;

export function defaultCoreHarnessAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

export function coreHarnessAgentDir(config: Pick<HarnessConfig, "agentDir"> | undefined): string {
  const configured = config?.agentDir?.trim();
  return configured ? configured : defaultCoreHarnessAgentDir();
}

/** 测试与配置热更新用：清掉懒加载句柄与状态缓存。 */
export function resetCoreHarnessRuntime(): void {
  handlePromise = null;
  handleError = null;
  statusCache = null;
  refreshing = null;
  cachedAgentDir = "";
}

/** pi-ai 只在真正跑 core 会话时加载，纯 CLI 部署不付这份启动成本。 */
export function loadPiAi(): Promise<PiAiModule> {
  if (!piAiPromise) piAiPromise = import("@earendil-works/pi-ai");
  return piAiPromise;
}

type PiAgentCoreModule = typeof import("@earendil-works/pi-agent-core");
type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

let piAgentCorePromise: Promise<PiAgentCoreModule> | null = null;
let piCodingAgentPromise: Promise<PiCodingAgentModule> | null = null;

/** pi-agent-core 的 agent loop 只在第一次 core 回合时加载。 */
export function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  if (!piAgentCorePromise) piAgentCorePromise = import("@earendil-works/pi-agent-core");
  return piAgentCorePromise;
}

/** pi-coding-agent 提供已发布的工具实现、模型运行时与压缩原语。 */
export function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  if (!piCodingAgentPromise) piCodingAgentPromise = import("@earendil-works/pi-coding-agent");
  return piCodingAgentPromise;
}

/** 已就绪的模型运行时（认证 + 模型目录）；失败抛错，由调用方决定降级。 */
export async function coreHarnessRuntime(config: Pick<HarnessConfig, "agentDir"> | undefined): Promise<ModelRuntime> {
  const handle = await loadHandle(coreHarnessAgentDir(config));
  return handle.runtime;
}

async function loadHandle(agentDir: string): Promise<CoreHarnessHandle> {
  if (handlePromise && cachedAgentDir === agentDir) return handlePromise;
  cachedAgentDir = agentDir;
  handlePromise = (async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    return { runtime, agentDir };
  })();
  return handlePromise;
}

/**
 * 读取 core 引擎可用性。失败不抛错：不可用时回退 CLI 是常态，
 * 只有显式 `harness.engine = "core"` 才由调用方升级成错误。
 */
export function coreHarnessStatus(
  config: Pick<HarnessConfig, "agentDir"> | undefined,
  options: { force?: boolean } = {},
): Promise<CoreHarnessStatus> {
  const agentDir = coreHarnessAgentDir(config);
  const now = Date.now();
  if (!options.force && statusCache && statusCache.agentDir === agentDir && now - statusCache.at < STATUS_TTL_MS) {
    return Promise.resolve(statusCache.status);
  }
  if (!options.force && refreshing && refreshing.agentDir === agentDir) return refreshing.promise;
  const promise = probeCoreHarness(agentDir).then((status) => {
    statusCache = { at: Date.now(), agentDir, status };
    if (refreshing?.promise === promise) refreshing = null;
    return status;
  });
  refreshing = { agentDir, promise };
  return promise;
}

async function probeCoreHarness(agentDir: string): Promise<CoreHarnessStatus> {
  let handle: CoreHarnessHandle;
  try {
    handle = await loadHandle(agentDir);
  } catch (error) {
    const reason = `无法初始化进程内 harness：${getErrorMessage(error)}`;
    handleError = { at: Date.now(), reason, agentDir };
    return { available: false, reason, providerCount: 0, modelCount: 0, agentDir };
  }
  try {
    const available = await handle.runtime.getAvailable();
    const providers = new Set(available.map((model) => model.provider));
    if (available.length === 0) {
      const reason = `Pi 侧没有可用认证（${path.join(agentDir, "auth.json")}）：先在 Pi 里 /login，或改 harness.engine 为 cli`;
      handleError = { at: Date.now(), reason, agentDir };
      return { available: false, reason, providerCount: 0, modelCount: 0, agentDir };
    }
    handleError = null;
    return {
      available: true,
      reason: "",
      providerCount: providers.size,
      modelCount: available.length,
      agentDir,
    };
  } catch (error) {
    const reason = `读取 core 引擎模型目录失败：${getErrorMessage(error)}`;
    handleError = { at: Date.now(), reason, agentDir };
    return { available: false, reason, providerCount: 0, modelCount: 0, agentDir };
  }
}

export interface EngineResolutionOptions {
  forceStatus?: boolean;
  /** 宿主已注入 core runner：视为 core 能力可用（测试与嵌入式宿主用）。 */
  coreRunnerSupplied?: boolean;
  /** 宿主已注入 pi 的 CLI runner：`auto` 不覆盖这个明确决定。 */
  cliRunnerSupplied?: boolean;
}

export function decideHarnessEngine(
  config: Pick<HarnessConfig, "engine" | "agentDir"> | undefined,
  provider: SessionProvider | null | undefined,
  options: EngineResolutionOptions,
  status: CoreHarnessStatus | null,
): EngineResolution {
  const engine: HarnessConfig["engine"] = config?.engine ?? "auto";
  if (engine === "cli") return { engine: "cli", reason: "配置为 cli 引擎" };
  if (!provider || !CORE_HARNESS_PROVIDERS.includes(provider)) {
    if (engine === "core") {
      throw new CoreHarnessUnavailableError(`core 引擎首期只支持 ${CORE_HARNESS_PROVIDERS.join(" / ")}，当前 provider 是 ${String(provider)}。`);
    }
    return { engine: "cli", reason: "core 引擎暂不支持该 provider" };
  }
  if (options.coreRunnerSupplied) return { engine: "core", reason: "宿主注入了 core runner" };
  if (engine !== "core" && options.cliRunnerSupplied) {
    return { engine: "cli", reason: "宿主注入了 pi runner，auto 不覆盖" };
  }
  if (status?.available) return { engine: "core", reason: "" };
  // 上次探测的失败原因只在该 agentDir 下才有意义，不能把别处的错误当成这里的结论。
  const shareableFailure = handleError && handleError.agentDir === coreHarnessAgentDir(config) ? handleError.reason : "";
  const reason = status?.reason || shareableFailure || "core 引擎状态尚未就绪（已开始探测，下一轮会自动用上）";
  if (engine === "core") throw new CoreHarnessUnavailableError(reason);
  return { engine: "cli", reason };
}

/**
 * 同步裁决执行引擎。
 * `sendMessage` 必须在一个 tick 内完成 runner 注册，所以这里不做任何 await；
 * 可用性来自后台预热的缓存，缓存未就绪时先走 CLI（下一轮自动切回 core）。
 */
export function resolveHarnessEngineSync(
  config: Pick<HarnessConfig, "engine" | "agentDir"> | undefined,
  provider: SessionProvider | null | undefined,
  options: EngineResolutionOptions = {},
): EngineResolution {
  const status = coreHarnessCachedStatus(config);
  if (!status) primeCoreHarnessStatus(config);
  return decideHarnessEngine(config, provider, options, status);
}

/**
 * 异步裁决：需要等探测结果、或需要强制刷新时用（测试、运维接口）。
 * 语义与 resolveHarnessEngineSync 一致。
 */
export async function resolveHarnessEngine(
  config: Pick<HarnessConfig, "engine" | "agentDir"> | undefined,
  provider: SessionProvider | null | undefined,
  options: EngineResolutionOptions = {},
): Promise<EngineResolution> {
  const engine: HarnessConfig["engine"] = config?.engine ?? "auto";
  const needsStatus = engine !== "cli"
    && !!provider && CORE_HARNESS_PROVIDERS.includes(provider)
    && !options.coreRunnerSupplied
    && !(engine !== "core" && options.cliRunnerSupplied);
  const status = needsStatus ? await coreHarnessStatus(config, { force: options.forceStatus }) : coreHarnessCachedStatus(config);
  return decideHarnessEngine(config, provider, options, status);
}

/**
 * 缓存状态：**过期也照旧返回最后一次已知结果**，只在后台刷新。
 * 引擎裁决是同步的（sendMessage 必须同 tick 注册 runner），如果过期就当“不可用”，
 * 用户每隔一会儿发第一句就会被退回 CLI：那会让同一个会话在两个引擎之间跳。
 */
export function coreHarnessCachedStatus(
  config: Pick<HarnessConfig, "agentDir"> | undefined,
): CoreHarnessStatus | null {
  const agentDir = coreHarnessAgentDir(config);
  if (!statusCache || statusCache.agentDir !== agentDir) return null;
  if (Date.now() - statusCache.at >= STATUS_TTL_MS) primeCoreHarnessStatus(config);
  return statusCache.status;
}

/** 后台预热：只读本地认证与模型目录，不联网，不阻塞调用方。 */
export function primeCoreHarnessStatus(config: Pick<HarnessConfig, "agentDir"> | undefined): void {
  void coreHarnessStatus(config).catch(() => undefined);
}

/**
 * 启动预热：在服务开始接收输入前把能力探完，避免第一轮引擎裁决靠运气。
 * 失败/超时都不影响启动（只是这一轮会按不可用处理）。
 */
export async function warmCoreHarness(config: Pick<HarnessConfig, "engine" | "agentDir"> | undefined): Promise<CoreHarnessStatus | null> {
  if ((config?.engine ?? "auto") === "cli") return null;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      coreHarnessStatus(config, { force: true }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), STATUS_PROBE_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 去掉 `provider/` 前缀，兼容 Wand 的 `provider/model` 选择器与裸模型 id。 */
export function splitModelSelector(selector: string): { providerId: string | null; modelId: string } {
  const trimmed = selector.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0) return { providerId: null, modelId: trimmed };
  // Bedrock / gateway 的模型 id 里带 `/`：只认第一段是已知 provider 前缀的情况由调用方兜底。
  return { providerId: trimmed.slice(0, separator), modelId: trimmed.slice(separator + 1) };
}

function preferSubscription(runtime: ModelRuntime, models: readonly Model<Api>[]): Model<Api> | null {
  for (const model of models) {
    try {
      if (runtime.isUsingSubscription(model.provider)) return model;
    } catch {
      // 单个 provider 的订阅探测失败不影响挑选。
    }
  }
  return models[0] ?? null;
}

/**
 * 把 Wand 的模型选择器解析成 core 引擎真正要调的 Pi 模型。
 * - 空 / `default`：先看 Pi settings 的 defaultModel，再退回可用模型（优先订阅）
 * - `provider/model`：直接查；查不到再按 `provider/model` 全等匹配
 * - 裸 id：在可用模型里按 id 匹配
 * 不可用返回 null，由调用方降级或报错（订阅档位可能拒绝某个模型，那是运行期错误，不在这里过滤）。
 */
export async function resolveCoreModel(
  config: Pick<HarnessConfig, "agentDir"> | undefined,
  selector: string | null | undefined,
  options: { cwd?: string } = {},
): Promise<ResolvedCoreModel | null> {
  const handle = await loadHandle(coreHarnessAgentDir(config));
  const runtime = handle.runtime;
  const available = await runtime.getAvailable();
  if (available.length === 0) return null;
  const wrap = (model: Model<Api>): ResolvedCoreModel => ({
    model,
    providerId: model.provider,
    modelId: model.id,
    subscription: safeIsSubscription(runtime, model.provider),
  });

  const raw = (selector ?? "").trim();
  if (!raw || raw === "default") {
    const settingsDefault = readPiDefaultModel(handle);
    if (settingsDefault) {
      const match = await matchSelector(runtime, available, settingsDefault);
      if (match) return wrap(match);
    }
    const preferred = preferSubscription(runtime, available);
    return preferred ? wrap(preferred) : null;
  }
  const match = await matchSelector(runtime, available, raw);
  return match ? wrap(match) : null;
}

function safeIsSubscription(runtime: ModelRuntime, providerId: string): boolean {
  try {
    return runtime.isUsingSubscription(providerId);
  } catch {
    return false;
  }
}

/** settings.json 的 defaultModel 允许带 `:<thinking>` 后缀，这里只取模型部分。 */
export function coreModelSelector(config: Pick<HarnessConfig, "agentDir"> | undefined, selector: string | null | undefined): string {
  const raw = selector?.trim();
  return raw && raw !== "default" ? raw : readPiDefaultModel({ agentDir: coreHarnessAgentDir(config) });
}

function readPiDefaultModel(handle: Pick<CoreHarnessHandle, "agentDir">): string {
  try {
    const settingsPath = path.join(handle.agentDir, "settings.json");
    const raw = readJsonIfExists(settingsPath);
    const value = raw?.defaultModel;
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    const separator = trimmed.indexOf(":");
    const id = (separator > 0 ? trimmed.slice(0, separator) : trimmed).trim();
    const provider = typeof raw?.defaultProvider === "string" ? raw.defaultProvider.trim() : "";
    return provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
  } catch {
    return "";
  }
}

function readJsonIfExists(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function matchSelector(
  runtime: ModelRuntime,
  available: readonly Model<Api>[],
  selector: string,
): Promise<Model<Api> | null> {
  const { providerId, modelId } = splitModelSelector(selector);
  if (providerId) {
    const direct = runtime.getModel(providerId, modelId);
    if (direct) return direct;
  }
  const exact = available.find((model) => `${model.provider}/${model.id}` === selector);
  if (exact) return exact;
  const byId = available.find((model) => model.id === modelId || model.id === selector);
  if (byId) return byId;
  const bySuffix = available.find((model) => model.id.toLowerCase().endsWith(`/${modelId.toLowerCase()}`));
  return bySuffix ?? null;
}

/** 上一次探测到的不可用原因；用于日志与降级提示，没有则返回空串。 */
export function lastCoreHarnessFailure(): string {
  return handleError?.reason ?? "";
}
