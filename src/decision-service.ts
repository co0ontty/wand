import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "./env-utils.js";
import { DecisionError, parseDecisionRequest, parseDecisionResult, type DecisionRequest, type DecisionResult, type LocalDecisionConfig } from "./decision-types.js";

interface Job {
  id: number;
  request: DecisionRequest;
  resolve: (result: DecisionResult) => void;
  reject: (error: DecisionError) => void;
  timer: NodeJS.Timeout;
  removeAbort: () => void;
}
interface DecisionServiceOptions {
  workerPath?: string;
  timeoutMs?: number;
  idleMs?: number;
  supported?: () => boolean;
}

/** One bounded worker per server. It owns no sessions, permissions, tasks, or model downloads. */
export class DecisionService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private stdout = "";
  private queue: Job[] = [];
  private active: Job | null = null;
  private sequence = 0;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private cooldownUntil = 0;
  private readonly rates = new Map<string, { start: number; count: number }>();
  private completed = 0;
  private failed = 0;
  private readonly initializations = new Set<{ resolve(): void; reject(error: DecisionError): void; clear(): void }>();

  constructor(private config: LocalDecisionConfig | undefined, private readonly options: DecisionServiceOptions = {}) {}

  status(): { enabled: boolean; supported: boolean; configured: boolean; state: string; queued: number; completed: number; failed: number; experimental: true } {
    const supported = (this.options.supported ?? (() => process.platform === "darwin" && process.arch === "arm64"))();
    const configured = !!this.config && isAbsolute(this.config.pythonPath) && isAbsolute(this.config.modelPath)
      && existsSync(this.config.pythonPath) && existsSync(this.config.modelPath);
    return { enabled: this.config?.enabled === true, supported, configured,
      state: this.disposed ? "closed" : this.stopping ? "stopping" : this.child ? this.ready ? "ready" : "loading" : "stopped",
      queued: this.queue.length + Number(!!this.active), completed: this.completed, failed: this.failed, experimental: true };
  }

  assertConfigurable(): void {
    if (this.active || this.queue.length || this.initializations.size || (this.child && !this.ready)) {
      throw new DecisionError("BUSY", "本地决策正在执行或初始化，请等待后重试。", 409);
    }
    if (this.disposed) throw new DecisionError("UNAVAILABLE", "决策服务已关闭。", 503);
  }

  configure(config: LocalDecisionConfig): void {
    this.assertConfigurable();
    const changedRuntime = config.pythonPath !== this.config?.pythonPath || config.modelPath !== this.config?.modelPath;
    if (changedRuntime || !config.enabled) this.stopWorker();
    this.config = { ...config };
    this.cooldownUntil = 0;
  }

  /** Explicit admin warm-up; it does not evaluate a user's task or implicitly enable the model. */
  initialize(signal?: AbortSignal): Promise<void> {
    const status = this.status();
    if (this.disposed || !status.supported || !status.configured) throw new DecisionError("UNAVAILABLE", "LAYA 平台不支持或运行环境/模型尚未安装。", 503);
    if (signal?.aborted) throw new DecisionError("CANCELLED", "初始化已取消。", 499);
    if (this.ready) return Promise.resolve();
    this.clearIdle();
    return new Promise((resolve, reject) => {
      const finish = (error?: DecisionError): void => {
        if (!this.initializations.delete(waiter)) return;
        waiter.clear();
        if (error) reject(error); else resolve();
        if (!this.initializations.size && !this.active && !this.queue.length) {
          if (error) this.stopWorker(); else this.pump();
        }
      };
      const abort = (): void => finish(new DecisionError("CANCELLED", "初始化已取消。", 499));
      const timer = setTimeout(() => finish(new DecisionError("TIMEOUT", "LAYA 初始化超时，请检查运行环境和模型。", 504)), this.options.timeoutMs ?? 45_000);
      const waiter = { resolve: () => finish(), reject: (error: DecisionError) => finish(error),
        clear: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
      this.initializations.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.pump();
    });
  }

  evaluate(value: unknown, caller: string, signal?: AbortSignal): Promise<DecisionResult> {
    const request = parseDecisionRequest(value);
    const status = this.status();
    if (this.disposed || !status.enabled || !status.supported || !status.configured) {
      throw new DecisionError("UNAVAILABLE", "本地决策未启用、平台不支持或运行环境未安装。", 503);
    }
    if (signal?.aborted) throw new DecisionError("CANCELLED", "决策请求已取消。", 499);
    if (Date.now() < this.cooldownUntil) throw new DecisionError("COOLDOWN", "决策引擎暂不可用，请稍后重试。", 503);
    if (this.queue.length + Number(!!this.active) >= 8) throw new DecisionError("BUSY", "决策队列已满。", 503);
    const now = Date.now();
    for (const [key, rate] of this.rates) if (now - rate.start >= 60_000) this.rates.delete(key);
    const rate = this.rates.get(caller) ?? { start: now, count: 0 };
    if (rate.count >= 60 || (!this.rates.has(caller) && this.rates.size >= 4096)) {
      throw new DecisionError("RATE_LIMIT", "决策调用过于频繁。", 429);
    }
    rate.count++;
    this.rates.set(caller, rate);
    this.clearIdle();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cancel = (error: DecisionError): void => {
        const queued = this.queue.find((job) => job.id === id);
        if (queued) {
          this.queue = this.queue.filter((job) => job.id !== id);
          this.finish(queued, error);
          // The first request can time out while Python is still loading, before active is set.
          if (!this.active && !this.queue.length) this.stopWorker();
        } else if (this.active?.id === id) this.failWorker(error);
      };
      const abort = (): void => cancel(new DecisionError("CANCELLED", "决策请求已取消。", 499));
      const timer = setTimeout(() => cancel(new DecisionError("TIMEOUT", "决策请求超时。", 504)), this.options.timeoutMs ?? 45_000);
      const job: Job = { id, request, resolve, reject, timer, removeAbort: () => signal?.removeEventListener("abort", abort) };
      this.queue.push(job);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failWorker(new DecisionError("UNAVAILABLE", "决策服务已关闭。", 503));
    this.rates.clear();
  }

  private finish(job: Job, error?: DecisionError, value?: DecisionResult): void {
    clearTimeout(job.timer);
    job.removeAbort();
    if (error) { this.failed++; job.reject(error); }
    else { this.completed++; job.resolve(value!); }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private stopWorker(): void {
    this.clearIdle();
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.stdout = "";
    if (child) {
      this.stopping = child;
      child.stdin.destroy();
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1000);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        if (this.stopping === child) this.stopping = null;
        this.pump();
      });
    }
  }

  private failWorker(error: DecisionError): void {
    for (const waiter of [...this.initializations]) waiter.reject(error);
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    this.stopWorker();
    this.cooldownUntil = Date.now() + 1000;
    for (const job of jobs) this.finish(job, error);
  }

  private pump(): void {
    if (this.disposed || this.active || this.stopping) return;
    if (!this.queue.length && !this.initializations.size) {
      if (this.child && !this.idleTimer) {
        this.idleTimer = setTimeout(() => this.stopWorker(), this.options.idleMs ?? 5 * 60_000);
        this.idleTimer.unref();
      }
      return;
    }
    if (!this.child) { this.startWorker(); return; }
    if (!this.ready) return;
    const job = this.queue.shift()!;
    this.active = job;
    this.child.stdin.write(`${JSON.stringify({ id: job.id, request: job.request })}\n`, (error) => {
      if (error && this.active === job) this.failWorker(new DecisionError("WORKER_FAILED", "决策引擎通信失败。", 502));
    });
  }

  private startWorker(): void {
    const child = spawn(this.config!.pythonPath, [this.options.workerPath ?? fileURLToPath(new URL("./decision-worker.py", import.meta.url)), this.config!.modelPath], {
      env: buildChildEnv(false, { HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // Never reflect stderr (it can include a local path or untrusted input) into HTTP or logs.
    child.stderr.resume();
    child.stdin.on("error", () => { if (this.child === child) this.failWorker(new DecisionError("WORKER_FAILED", "决策引擎通信失败。", 502)); });
    child.on("error", () => { if (this.child === child) this.failWorker(new DecisionError("WORKER_FAILED", "无法启动决策引擎。", 503)); });
    child.on("exit", () => { if (this.child === child) this.failWorker(new DecisionError("WORKER_FAILED", "决策引擎已退出。", 502)); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.stdout += chunk;
      if (Buffer.byteLength(this.stdout) > 128 * 1024) {
        this.failWorker(new DecisionError("INVALID_RESULT", "决策引擎输出过大。", 502));
        return;
      }
      while (this.stdout.includes("\n") && this.child === child) {
        const end = this.stdout.indexOf("\n");
        const line = this.stdout.slice(0, end);
        this.stdout = this.stdout.slice(end + 1);
        try { this.receive(JSON.parse(line)); }
        catch { this.failWorker(new DecisionError("INVALID_RESULT", "决策引擎协议错误。", 502)); }
      }
    });
  }

  private receive(message: Record<string, unknown>): void {
    if (!this.ready) {
      if (message.type !== "ready" || message.protocol !== 1) throw new Error("Unexpected ready");
      this.ready = true;
      for (const waiter of [...this.initializations]) waiter.resolve();
      this.pump();
      return;
    }
    const job = this.active;
    if (!job || message.id !== job.id) throw new Error("Unexpected result");
    const errors: Record<string, string> = {
      CONTEXT_LIMIT: "超过模型1024 token上下文，请缩短输入；未返回截断后的判断。",
      OPTIONS_COLLAPSED: "选项超出token预算、无法区分，请减少或缩短选项。",
      QUESTION_LIMIT: "问题指令或选项超过模型前缀token预算，请缩短；不会静默截断。",
      INVALID_REQUEST: "决策引擎无法处理该问题格式。",
    };
    if (typeof message.error === "string") {
      if (!Object.hasOwn(errors, message.error)) {
        this.failWorker(new DecisionError("INFERENCE_FAILED", "本地推理失败。", 502));
        return;
      }
      this.active = null;
      this.finish(job, new DecisionError(message.error, errors[message.error]!, 422));
    } else {
      const result = parseDecisionResult(message.result, job.request);
      this.active = null;
      this.finish(job, undefined, result);
    }
    this.pump();
  }
}
