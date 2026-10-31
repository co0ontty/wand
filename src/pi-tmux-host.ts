import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildChildEnv, systemEnvValue } from "./env-utils.js";
import { shellQuote } from "./shell-quote.js";
import { logInfo } from "./runtime-log.js";
import { signalNumberFromName } from "./signal-utils.js";
import { offerNativeInput, resolveNativeInput, type PiInputHandoff, type PiInputResolution } from "./pi-native-input.js";
import { createUtf8TextDecoder, type StructuredExecHost, type StructuredExecProcess, type StructuredSpawnRequest, type StructuredRunState, type StructuredStreamEvent, type StructuredExitEvent } from "./structured-exec-host.js";

const execute = promisify(execFile);
const REPLAY_BYTES = 8 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const TICK_BYTES = 256 * 1024;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface NativeJob {
  runId: string; requestId: string; incarnationId: string; tmux: string; pane?: string;
  events: string; stderr: string; state: string; ready: string; ack: string; input?: string;
}
interface WorkerState { status: "starting" | "running" | "exited"; pid: number; workerPid?: number; exitCode: number | null; signal: string | null; spawnError?: string; }
function atomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 }); renameSync(temporary, file);
}
function runtimeModule(name: string): string {
  const js = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
  return existsSync(js) ? js : js.replace(/\.js$/, ".ts");
}

class NativeProcess implements StructuredExecProcess {
  readonly runId: string;
  readonly incarnationId: string;
  private readonly streams = new Set<(event: StructuredStreamEvent) => void>();
  private readonly exits = new Set<(event: StructuredExitEvent) => void>();
  private readonly offsets = { stdout: 0, stderr: 0 };
  private readonly decoders = { stdout: createUtf8TextDecoder(), stderr: createUtf8TextDecoder() };
  private timer: NodeJS.Timeout | null = null;
  private ended: StructuredExitEvent | null = null;
  private observationFailed = false;
  private readonly identities: Record<"stdout" | "stderr", { dev: number; ino: number }>;
  constructor(readonly job: NativeJob, private readonly host: PiTmuxHost, after?: StructuredRunState) {
    this.runId = job.runId; this.incarnationId = job.incarnationId;
    this.identities = { stdout: lstatSync(job.events), stderr: lstatSync(job.stderr) };
    if (after) { this.offsets.stdout = after.stdoutSeq; this.offsets.stderr = after.stderrSeq; }
  }
  get protocolSource(): { file: string; dev: number; ino: number } {
    return { file: this.job.events, ...this.identities.stdout };
  }
  get pid(): number { return this.host.state(this.job).pid; }
  interrupt(): void { void this.host.kill(this.job).catch((error) => logInfo(`Pi native stop failed: ${error instanceof Error ? error.message : String(error)}`)); }
  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void } {
    this.streams.add(listener); this.start(); return { dispose: () => this.streams.delete(listener) };
  }
  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void } {
    this.exits.add(listener); this.start();
    if (this.ended) queueMicrotask(() => { if (this.exits.has(listener)) listener(this.ended!); });
    return { dispose: () => this.exits.delete(listener) };
  }
  private start(): void {
    if (this.timer || this.ended) return;
    this.timer = setInterval(() => this.poll(), 100); this.timer.unref();
    setImmediate(() => this.poll());
  }
  private read(stream: "stdout" | "stderr", all: boolean): void {
    const file = stream === "stdout" ? this.job.events : this.job.stderr;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      const identity = this.identities[stream];
      if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw new Error("Pi 原生事件文件被替换；不重放输入。");
      const size = opened.size;
      if (size < this.offsets[stream]) throw new Error("Pi 原生事件文件被截断；不重放输入。");
      const end = Math.min(size, this.offsets[stream] + (all ? size : TICK_BYTES));
      const buffer = Buffer.allocUnsafe(READ_BYTES);
      while (this.offsets[stream] < end) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - this.offsets[stream]), this.offsets[stream]);
        if (!count) throw new Error("Pi 原生事件文件读取不完整。");
        this.offsets[stream] += count;
        const text = this.decoders[stream].write(buffer.subarray(0, count));
        if (text) for (const listener of this.streams) listener({ stream, data: text, seq: this.offsets[stream] });
      }
    } finally { closeSync(fd); }
  }
  private poll(): void {
    if (this.ended) return;
    try {
      const state = this.host.state(this.job);
      if (!this.observationFailed) {
        this.read("stdout", state.status === "exited"); this.read("stderr", state.status === "exited");
      }
      if (state.status !== "exited") return;
      this.ended = { exitCode: state.exitCode, signal: state.signal ? signalNumberFromName(state.signal) : null };
    } catch (error) {
      if (!this.observationFailed) {
        this.observationFailed = true;
        logInfo(`Pi native file observation failed: ${error instanceof Error ? error.message : String(error)}`);
        for (const listener of this.exits) listener({ exitCode: 1, signal: null, processExited: false });
        void this.host.kill(this.job).catch(error => logInfo(`Pi native cleanup failed: ${String(error)}`));
      }
      // An observation failure ends the response, not ownership of the process.
      // Keep watching state so actual termination can release deletion barriers.
      return;
    }
    if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const listener of this.exits) listener(this.ended);
  }
}

/** New Pi CLI turns use real native TUI tmux panes; existing daemon runs stay with their original owner. */
export class PiTmuxHost implements StructuredExecHost {
  readonly persistent = true;
  get piNativeTui(): boolean { return this.enabled; }
  private readonly root: string;
  private readonly prefix: string;
  private readonly owners = new Map<string, "native" | "legacy">();
  private readonly observed = new Map<string, StructuredRunState>();
  private readonly terminations = new Map<string, Promise<void>>();
  constructor(configDir: string, private readonly legacy: StructuredExecHost, private readonly enabled = true) {
    this.root = path.join(configDir, "pi-native");
    this.prefix = `wand-pi-${createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 6)}-`;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  private slot(runId: string): string { return path.join(this.root, createHash("sha256").update(runId).digest("hex").slice(0, 24)); }
  private job(runId: string): NativeJob | null {
    try { return JSON.parse(readFileSync(path.join(this.slot(runId), "current.json"), "utf8")) as NativeJob; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async tmux(args: string[]): Promise<string> {
    const result = await execute("tmux", ["-L", "default", ...args], {
      env: buildChildEnv(false, { TMUX_TMPDIR: systemEnvValue("TMUX_TMPDIR") }), timeout: 10000, maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  }
  state(job: NativeJob): WorkerState {
    const value = JSON.parse(readFileSync(job.state, "utf8")) as WorkerState;
    if ((value.status === "running" || value.status === "starting") && value.pid > 0) {
      try { process.kill(value.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return { ...value, status: "exited", exitCode: 1, signal: null };
      }
    }
    return value;
  }
  private snapshot(job: NativeJob, checkpoint?: import("./pi-cli-checkpoint.js").PiCliCheckpoint): StructuredRunState {
    const state = this.state(job);
    let stdoutFrom: number | undefined;
    const log = (file: string): { text: string; size: number; truncated: boolean } => {
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        const size = stat.size;
        const matched = file === job.events && checkpoint?.incarnationId === job.incarnationId
          && checkpoint.source.file === file && checkpoint.source.dev === stat.dev && checkpoint.source.ino === stat.ino
          && checkpoint.offset <= size && size - checkpoint.offset <= REPLAY_BYTES;
        // A checkpoint is usable only if it ends at a real source record
        // boundary. Never splice an arbitrary byte position into JSON.
        let boundary = checkpoint?.offset === 0;
        if (matched && checkpoint.offset > 0) {
          const byte = Buffer.alloc(1);
          boundary = readSync(fd, byte, 0, 1, checkpoint.offset - 1) === 1 && byte[0] === 10;
        }
        const start = matched && boundary ? checkpoint.offset : Math.max(0, size - REPLAY_BYTES);
        if (matched && boundary) stdoutFrom = start;
        const count = size - start; const bytes = Buffer.alloc(count);
        let read = 0; while (read < count) { const n = readSync(fd, bytes, read, count - read, start + read); if (!n) break; read += n; }
        if (read !== count) throw new Error("Pi 原生事件文件读取不完整。");
        let begin = 0; while (begin < read && (bytes[begin] & 0xc0) === 0x80) begin++;
        return { text: bytes.subarray(begin, read).toString("utf8"), size, truncated: (file !== job.events || stdoutFrom === undefined) && size > count };
      } finally { closeSync(fd); }
    };
    const stdout = log(job.events); const stderr = log(job.stderr);
    return { runId: job.runId, incarnationId: job.incarnationId, pid: state.pid,
      status: state.status === "exited" ? "exited" : "running", exitCode: state.exitCode,
      signal: state.signal ? signalNumberFromName(state.signal) : null,
      stdoutSeq: stdout.size, stderrSeq: stderr.size, stdoutLog: stdout.text, stderrLog: stderr.text,
      stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
      nativeFile: job.events, ...(stdoutFrom !== undefined ? { stdoutFrom } : {}) };
  }
  async spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    if (!request.nativePi) {
      const previous = this.job(request.runId);
      if (previous && (!existsSync(previous.ack) || this.state(previous).status !== "exited")) {
        throw Object.assign(new Error("原 Pi 原生回合尚未释放；未重复发送输入。"), { preflightBlocked: true });
      }
      this.owners.set(request.runId, "legacy");
      return this.legacy.spawnStructured(request);
    }
    if (!this.enabled) throw Object.assign(new Error("Pi 原生 tmux 已禁用，未发送输入。"), { preflightBlocked: true });
    if (request.launchSignal?.aborted) throw new Error("Pi 原生启动已取消，未发送输入。");
    if (process.platform === "win32") throw new Error("Pi 原生 tmux 执行需要支持 tmux 的宿主机。");
    if (request.file !== "pi") throw Object.assign(new Error("原生 tmux 入口仅用于 Pi CLI。"), { preflightBlocked: true });
    const existingLegacy = await this.legacy.attachRun(request.runId);
    if (existingLegacy?.status === "running") {
      throw Object.assign(new Error("原 Pi 回合仍由旧执行宿主持有；未重复发送新输入。"), { preflightBlocked: true });
    }
    const previous = this.job(request.runId);
    if (previous && this.state(previous).status !== "exited") {
      if (previous.requestId === request.requestId) return new NativeProcess(previous, this);
      throw Object.assign(new Error("Pi 的上一原生回合尚未结束，请等待停止完成；没有发送新输入。"), { preflightBlocked: true });
    }
    const slot = this.slot(request.runId); mkdirSync(slot, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(slot, "turn-")); const incarnationId = randomUUID();
    const sid = request.runId.replace(/^structured:/, "").replace(/[^a-zA-Z0-9-]/g, "-");
    const job: NativeJob = { runId: request.runId, requestId: request.requestId ?? incarnationId, incarnationId,
      tmux: this.prefix + sid + "-" + incarnationId.slice(0, 8), events: path.join(dir, "events.jsonl"), stderr: path.join(dir, "stderr.log"),
      state: path.join(dir, "state.json"), ready: path.join(dir, "ready.json"), ack: path.join(dir, "ack"), input: path.join(dir, "input") };
    mkdirSync(job.input!, { mode: 0o700 });
    for (const file of [job.events, job.stderr]) writeFileSync(file, "", { mode: 0o600 });
    atomic(job.state, { status: "starting", pid: -1, exitCode: null, signal: null });
    const paths = path.join(dir, "paths.json"); atomic(paths, { events: job.events, ready: job.ready, input: job.input, initialMessageId: request.nativeInputMessageId });
    const launchDir = mkdtempSync(path.join(os.tmpdir(), "wand-pi-launch-")); const socket = path.join(launchDir, "start.sock");
    let handedOff = false;
    let launchReady = false;
    let receiver: Socket | null = null;
    const deliver = (): void => {
      if (!launchReady || !receiver || handedOff) return;
      handedOff = true;
      receiver.end(JSON.stringify({ file: request.file, args: request.args, cwd: request.cwd, env: request.env,
        state: job.state, stderr: job.stderr, paths }) + "\n");
      receiver = null;
    };
    const closeReceiver = (): void => { receiver?.destroy(); };
    const server = createServer((connection) => {
      if (handedOff || receiver) { connection.destroy(); return; }
      receiver = connection;
      deliver();
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    chmodSync(socket, 0o600);
    const command = `exec ${shellQuote(process.execPath)} ${shellQuote(runtimeModule("pi-tmux-worker"))} ${shellQuote(socket)} 2>>${shellQuote(path.join(dir, "worker-startup.log"))}`;
    try {
      let exists = false;
      try { await this.tmux(["has-session", "-t", `=${job.tmux}`]); exists = true; } catch { /* a new owned session */ }
      if (exists) {
        throw new Error("tmux 名称已被其他会话使用，未接管或停止它。");
      } else {
        job.pane = (await this.tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", job.tmux, "-x", "120", "-y", "36", "-c", request.cwd, command])).trim();
        if (!/^%\d+$/.test(job.pane)) throw new Error("Pi tmux pane identity is unavailable");
        await this.tmux(["set-option", "-t", job.tmux, "@wand-native-owner", request.runId]);
        await this.tmux(["set-window-option", "-t", job.pane, "remain-on-exit", "off"]);
      }
      const workerPid = Number((await this.tmux(["display-message", "-p", "-t", job.pane!, "#{pane_pid}"])).trim());
      atomic(job.state, { status: "starting", pid: workerPid, workerPid, exitCode: null, signal: null });
      if (request.launchSignal?.aborted) throw new Error("Pi 原生启动已取消，未发送输入。");
      atomic(path.join(slot, "current.json"), job); this.owners.set(request.runId, "native");
      launchReady = true;
      deliver();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const state = this.state(job);
        if (request.launchSignal?.aborted && state.status !== "exited") await this.kill(job);
        if (state.status === "running" || state.status === "exited") return new NativeProcess(job, this);
        await delay(25);
      }
      // Do not label a completed handoff as an unaccepted spawn error.
      throw Object.assign(new Error("Pi 原生启动结果未知；没有自动重发输入。"), { deliveryUnknown: handedOff });
    } catch (error) {
      if (!handedOff) {
        try { await this.kill(job); } catch {}
        atomic(job.state, { status: "exited", pid: this.state(job).pid, exitCode: 1, signal: null });
        throw error;
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUnknown: true });
    } finally {
      closeReceiver();
      server.close(); rmSync(launchDir, { recursive: true, force: true });
    }
  }
  offerPiInput(runId: string, boundaryId: string, take: (identity: PiInputHandoff) => string | null): boolean {
    const job = this.job(runId);
    if (!job?.input || existsSync(job.ack) || this.state(job).status !== "running") return false;
    return offerNativeInput(job.input, boundaryId, job.incarnationId, take);
  }
  resolvePiInput(runId: string, handoff: PiInputHandoff): PiInputResolution {
    const job = this.job(runId);
    if (!job?.input || job.incarnationId !== handoff.incarnationId) return { state: "unknown" };
    const exited = this.state(job).status === "exited";
    const resolution = resolveNativeInput(job.input, handoff, exited);
    if (resolution.state !== "unknown" || !exited) return resolution;
    // The CLI may exit after committing its boundary but before the next event.
    // Resolve only an exact native entry id from that execution's private session.
    const ready = readJson<{ sessionFile?: string }>(job.ready);
    if (!ready?.sessionFile) return resolution;
    try {
      const stat = lstatSync(ready.sessionFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REPLAY_BYTES * 8) return resolution;
      const records = readFileSync(ready.sessionFile, "utf8").split("\n");
      for (const line of records) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { type?: string; customType?: string; details?: { inputId?: string }; content?: string };
        if (entry.type === "custom_message" && entry.customType === "wand-user-input"
          && entry.details?.inputId === handoff.id && typeof entry.content === "string") {
          return { state: "committed", offer: { ...handoff, text: entry.content } };
        }
      }
    } catch { /* Missing or invalid native history remains unknown, never a replay permission. */ }
    return resolution;
  }
  async attachRun(runId: string, checkpoint?: import("./pi-cli-checkpoint.js").PiCliCheckpoint): Promise<StructuredRunState | null> {
    const job = this.job(runId);
    if (job && !existsSync(job.ack)) { const state = this.snapshot(job, checkpoint); this.observed.set(runId, state); this.owners.set(runId, "native"); return state; }
    this.owners.set(runId, "legacy"); return this.legacy.attachRun(runId);
  }
  async adoptRun(runId: string): Promise<StructuredExecProcess | null> {
    const job = this.job(runId);
    if (job && !existsSync(job.ack)) return new NativeProcess(job, this, this.observed.get(runId));
    return this.legacy.adoptRun(runId);
  }
  async listRuns(): Promise<StructuredRunState[]> {
    const native: StructuredRunState[] = [];
    for (const item of readdirSync(this.root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const current = path.join(this.root, item.name, "current.json");
      if (!existsSync(current)) continue;
      // A published owner with unreadable state is unknown, not an idle host.
      const job = JSON.parse(readFileSync(current, "utf8")) as NativeJob;
      if (!existsSync(job.ack) || this.state(job).status !== "exited") {
        native.push(this.snapshot(job)); this.owners.set(job.runId, "native");
      }
    }
    const legacy = await this.legacy.listRuns();
    for (const state of legacy) {
      if (native.some(other => other.runId === state.runId && (other.status === "running" || state.status === "running"))) {
        throw new Error("Pi 执行存在冲突的持久宿主，拒绝继续维护。");
      }
      if (!native.some(other => other.runId === state.runId)) this.owners.set(state.runId, "legacy");
    }
    return [...legacy.filter(state => !native.some(other => other.runId === state.runId)), ...native];
  }
  kill(job: NativeJob): Promise<void> {
    const previous = this.terminations.get(job.incarnationId);
    if (previous) return previous;
    const stopping = (async () => {
      let tag: string;
      try {
        const panes = (await this.tmux(["list-panes", "-t", `=${job.tmux}`, "-F", "#{session_name}\t#{pane_id}\t#{pane_pid}"])).trim().split("\n");
        const identity = job.pane ? panes.find(line => line.split("\t")[1] === job.pane) : panes[0];
        if (!identity || identity.split("\t")[0] !== job.tmux) throw new Error("Pi tmux 精确目标不匹配，拒绝停止。");
        const workerPid = this.state(job).workerPid;
        if (workerPid && Number(identity.split("\t")[2]) !== workerPid) throw new Error("Pi tmux pane generation changed");
        tag = (await this.tmux(["show-options", "-v", "-t", job.tmux, "@wand-native-owner"])).trim();
      } catch (error) {
        if (this.state(job).status === "exited") return;
        throw error;
      }
      if (tag !== job.runId) throw new Error("Pi tmux 所有权不匹配，拒绝停止。");
      await this.tmux(["kill-session", "-t", `=${job.tmux}`]);
    })();
    this.terminations.set(job.incarnationId, stopping);
    void stopping.catch(() => this.terminations.delete(job.incarnationId));
    return stopping;
  }
  forgetRun(runId: string): void {
    const job = this.job(runId);
    if (this.owners.get(runId) !== "native" || !job) { this.legacy.forgetRun(runId); return; }
    const acknowledge = (): void => {
      writeFileSync(job.ack, "consumed\n", { mode: 0o600 });
      if (this.observed.get(runId)?.incarnationId === job.incarnationId) this.observed.delete(runId);
    };
    if (this.state(job).status === "exited") { acknowledge(); return; }
    void this.kill(job).then(async () => {
      const deadline = Date.now() + 10000;
      while (this.state(job).status !== "exited") {
        if (Date.now() >= deadline) throw new Error("Pi process exit is not yet confirmed");
        await delay(25);
      }
      acknowledge();
    }).catch((error) => logInfo(`Pi tmux cleanup failed: ${String(error)}`));
  }

  /**
   * 回收 pi-native 下已经没用的执行产物。每次 Pi 原生回合都会在 slot 里
   * `mkdtemp` 一个新 turn 目录（events.jsonl / stderr.log / state.json 等），
   * 而 forgetRun 只写 ack 标记、从不删目录，所以会按回合数无限堆积。
   *
   * 只回收三类确定无主的东西：
   * - slot 已 ack 且 runId 不在 activeSessionIds 里：整个 slot 无主；
   * - slot 无主的，整槽删除；
   * - slot 仍有主的，只删非 current.json 引用、已 ack 且进程已退出、超保留期的 turn。
   *
   * activeSessionIds 只含未归档会话。归档后不再续接这些 turn，已 ack 且进程退出
   * 就可以整槽删除，不再额外等保留期；取消归档从会话自己的消息快照恢复。
   * 保留未归档会话 current.json 指向的 turn：`listRuns` / `adoptRun` 仍靠它的
   * events.jsonl 重放恢复；未 ack 的 slot 可能是尚未收尾的回合，一律不动。
   */
  collectGarbage(options: {
    /** 未归档会话 id；不在其中的 slot（已删除或已归档）视为无主。 */
    liveSessionIds: ReadonlySet<string>;
    /** 与 liveSessionIds 同义。传入时优先于旧字段，避免把归档会话算成仍在使用。 */
    activeSessionIds?: ReadonlySet<string>;
    retentionMs: number;
    now?: number;
  }): PiNativeGcReport {
    const activeSessionIds = options.activeSessionIds ?? options.liveSessionIds;
    const report: PiNativeGcReport = { removedSlots: 0, removedTurns: 0, freedBytes: 0 };
    const now = options.now ?? Date.now();
    let entries;
    try { entries = readdirSync(this.root, { withFileTypes: true }); } catch { return report; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slot = path.join(this.root, entry.name);
      const job = this.readJob(slot);
      if (!job) continue;
      const acked = existsSync(job.ack);
      const sessionId = job.runId.replace(/^structured:/, "");
      const orphan = !activeSessionIds.has(sessionId);
      if (orphan) {
        // 无主 slot 也得等 ack 完成：未 ack 说明回合可能还在收尾。
        // 已删除和已归档都不再续接，进程退出后不再额外等保留期。
        if (!acked) continue;
        if (!this.slotIsIdle(slot, job, now, 0)) continue;
        report.freedBytes += directoryBytes(slot);
        if (removeTree(slot)) report.removedSlots += 1;
        else report.freedBytes -= directoryBytes(slot);
        continue;
      }
      // 有主 slot：只删不被 current.json 引用的旧 turn。
      const current = path.dirname(job.events);
      let turns;
      try { turns = readdirSync(slot, { withFileTypes: true }); } catch { continue; }
      for (const turn of turns) {
        if (!turn.isDirectory() || !turn.name.startsWith("turn-")) continue;
        const directory = path.join(slot, turn.name);
        if (directory === current) continue;
        if (!existsSync(path.join(directory, "ack"))) continue;
        const state = readJson<WorkerState>(path.join(directory, "state.json"));
        // 进程还活着的回合不能被当成垃圾。state 写 running 但 PID 已消失的
        // （异常退出/被强杀）按已退出处理，否则这种回合会永久堆积。
        if (!state || stateAlive(state)) continue;
        let latest: number;
        try { latest = directoryLatestMtime(directory); } catch { continue; }
        if (now - latest < options.retentionMs) continue;
        const bytes = directoryBytes(directory);
        if (!removeTree(directory)) continue;
        report.removedTurns += 1;
        report.freedBytes += bytes;
      }
    }
    return report;
  }

  private readJob(slot: string): NativeJob | null {
    try { return JSON.parse(readFileSync(path.join(slot, "current.json"), "utf8")) as NativeJob; } catch { return null; }
  }

  /** 无主 slot 是否已整体静默：所有 turn 都不再是运行中。retentionMs 为 0 时不等待。 */
  private slotIsIdle(slot: string, job: NativeJob, now: number, retentionMs: number): boolean {
    const current = path.dirname(job.events);
    const state = readJson<WorkerState>(job.state);
    if (state && stateAlive(state)) return false;
    let latest: number;
    try { latest = directoryLatestMtime(slot); } catch { return false; }
    if (now - latest < retentionMs) return false;
    // 非 current 的 turn 里如果还有活进程，整槽不能删。
    let turns: import("node:fs").Dirent[];
    try { turns = readdirSync(slot, { withFileTypes: true }); } catch { return false; }
    for (const turn of turns) {
      if (!turn.isDirectory() || !turn.name.startsWith("turn-")) continue;
      const directory = path.join(slot, turn.name);
      if (directory === current) continue;
      const other = readJson<WorkerState>(path.join(directory, "state.json"));
      if (other && stateAlive(other)) return false;
    }
    return true;
  }
}

/** pi-native 回收结果：删了几个 slot / 几个旧 turn / 释放多少字节。 */
export interface PiNativeGcReport {
  removedSlots: number;
  removedTurns: number;
  freedBytes: number;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}

/** 回合是否仍活着：state 声称未退出且 PID 真实存在。 */
function stateAlive(state: WorkerState): boolean {
  return state.status !== "exited" && pidAlive(state.pid);
}

function pidAlive(pid: number | undefined): boolean {  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM means the PID exists but belongs to another user; treat as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function directoryLatestMtime(directory: string): number {
  let latest = lstatSync(directory).mtimeMs;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stat = lstatSync(child);
    if (stat.isDirectory()) latest = Math.max(latest, directoryLatestMtime(child));
    // 只看 mtime：ctime 无法回拨，且文件被任何元数据操作碰一下就会刷新，
    // 用它做保留期会把「早已结束的回合」永远当成刚活动过。
    else latest = Math.max(latest, stat.mtimeMs);
  }
  return latest;
}

function directoryBytes(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stat = lstatSync(child);
    if (stat.isDirectory()) total += directoryBytes(child);
    else total += stat.size;
  }
  return total;
}

/** 只删目录，不跟随符号链接。 */
function removeTree(directory: string): boolean {
  try { rmSync(directory, { recursive: true, force: false }); return true; } catch { return false; }
}
