import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildChildEnv } from "./env-utils.js";
import { shellQuote } from "./shell-quote.js";
import { signalNumberFromName } from "./signal-utils.js";
import { createUtf8TextDecoder, type StructuredExecHost, type StructuredExecProcess, type StructuredExitEvent, type StructuredRunState, type StructuredSpawnRequest, type StructuredStreamEvent } from "./structured-exec-host.js";

const execute = promisify(execFile);
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface Job { runId: string; incarnationId: string; requestId: string; tmux: string; dir: string; state: string; stdout: string; stderr: string; ack: string; }
interface WorkerState { runId: string; incarnationId: string; status: "starting" | "running" | "exited"; pid: number; workerPid?: number; supervisorPid?: number; exitCode: number | null; signal: string | null; spawnError?: string; }
function atomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
}
function runtimeModule(name: string): string {
  const js = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
  return existsSync(js) ? js : js.replace(/\.js$/, ".ts");
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

class TmuxProcess implements StructuredExecProcess {
  readonly runId: string;
  readonly incarnationId: string;
  readonly requestId: string;
  private readonly streams = new Set<(event: StructuredStreamEvent) => void>();
  private readonly exits = new Set<(event: StructuredExitEvent) => void>();
  private readonly decoders = { stdout: createUtf8TextDecoder(), stderr: createUtf8TextDecoder() };
  private readonly offsets = { stdout: 0, stderr: 0 };
  private readonly identities: Record<"stdout" | "stderr", { dev: number; ino: number }>;
  private timer: NodeJS.Timeout | null = null;
  private ended: StructuredExitEvent | null = null;
  private observationFailed = false;
  private reportObservationFailure(): void {
    if (this.observationFailed) return;
    this.observationFailed = true;
    for (const listener of this.exits) listener({ exitCode: 1, signal: null, processExited: false });
  }
  constructor(readonly job: Job, private readonly host: StructuredTmuxHost, after?: StructuredRunState) {
    this.runId = job.runId;
    this.incarnationId = job.incarnationId;
    this.requestId = job.requestId;
    this.identities = { stdout: this.identify(job.stdout), stderr: this.identify(job.stderr) };
    if (after) {
      // attachRun already returned the replay through these absolute byte watermarks.
      // Start strictly after that snapshot; truncation affects the replay window, not seq.
      this.offsets.stdout = after.stdoutSeq;
      this.offsets.stderr = after.stderrSeq;
    }
  }
  get pid(): number { return this.host.state(this.job).pid; }
  interrupt(signal?: string): void {
    void this.host.kill(this.job, signal).catch(() => this.reportObservationFailure());
  }
  onStream(listener: (event: StructuredStreamEvent) => void): { dispose(): void } {
    this.streams.add(listener); this.start(); return { dispose: () => this.streams.delete(listener) };
  }
  onExit(listener: (event: StructuredExitEvent) => void): { dispose(): void } {
    this.exits.add(listener); this.start();
    if (this.ended) queueMicrotask(() => { if (this.exits.has(listener)) listener(this.ended!); });
    return { dispose: () => this.exits.delete(listener) };
  }
  private identify(file: string): { dev: number; ino: number } {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const stat = fstatSync(fd); return { dev: stat.dev, ino: stat.ino }; }
    finally { closeSync(fd); }
  }
  private start(): void {
    if (this.timer || this.ended) return;
    this.timer = setInterval(() => this.poll(), 100); this.timer.unref();
    setImmediate(() => this.poll());
  }
  private read(stream: "stdout" | "stderr", all: boolean): void {
    const file = stream === "stdout" ? this.job.stdout : this.job.stderr;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd); const expected = this.identities[stream];
      if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("Structured tmux replay file identity changed");
      if (stat.size < this.offsets[stream]) throw new Error("Structured tmux replay file was truncated");
      const end = Math.min(stat.size, this.offsets[stream] + (all ? stat.size : READ_BYTES));
      const buffer = Buffer.allocUnsafe(READ_BYTES);
      while (this.offsets[stream] < end) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - this.offsets[stream]), this.offsets[stream]);
        if (!count) break;
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
      this.read("stdout", state.status === "exited"); this.read("stderr", state.status === "exited");
      if (state.status !== "exited") return;
      this.ended = { exitCode: state.exitCode, signal: state.signal ? signalNumberFromName(state.signal) : null };
    } catch {
      // Fail the observation, but retain the true-exit barrier and keep monitoring.
      this.reportObservationFailure();
      return;
    }
    if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const listener of this.exits) listener(this.ended);
  }
}

/** Persistent structured CLI execution in isolated tmux sessions, with pipe I/O. */
export class StructuredTmuxHost implements StructuredExecHost {
  readonly persistent = true;
  private readonly root: string;
  private readonly socket: string;
  private readonly prefix: string;
  private readonly owners = new Map<string, "tmux" | "legacy">();
  private readonly snapshots = new Map<string, StructuredRunState>();
  private readonly terminations = new Map<string, Promise<void>>();
  private readonly starts = new Map<string, { requestId: string; promise: Promise<StructuredExecProcess> }>();
  private readonly forgets = new Map<string, Promise<void>>();
  constructor(configDir: string, private readonly legacy: StructuredExecHost, private readonly enabled = true) {
    this.root = path.join(configDir, "structured-tmux");
    const suffix = createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 12);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    this.socket = path.join(os.tmpdir(), `wand-st-${uid}-${suffix}.sock`);
    this.prefix = `wand-st-${suffix}-`;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { chmodSync(this.root, 0o700); } catch { /* existing private directory */ }
  }
  private slot(runId: string): string { return path.join(this.root, createHash("sha256").update(runId).digest("hex").slice(0, 24)); }
  private job(runId: string): Job | null {
    const file = path.join(this.slot(runId), "current.json");
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const job = JSON.parse(text) as Job;
    if (job.runId !== runId || !job.incarnationId || !job.requestId || !job.tmux?.startsWith(this.prefix) ||
        path.dirname(job.dir) !== this.slot(runId) ||
        job.state !== path.join(job.dir, "state.json") || job.stdout !== path.join(job.dir, "stdout.log") ||
        job.stderr !== path.join(job.dir, "stderr.log") || job.ack !== path.join(job.dir, "ack")) {
      throw new Error("Invalid structured tmux owner record; refusing duplicate execution");
    }
    return job;
  }
  private async tmux(args: string[]): Promise<string> {
    const result = await execute("tmux", ["-f", "/dev/null", "-S", this.socket, ...args], { env: buildChildEnv(false), timeout: 10_000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  }
  state(job: Job): WorkerState {
    const value = JSON.parse(readFileSync(job.state, "utf8")) as WorkerState;
    if (value.runId !== job.runId || value.incarnationId !== job.incarnationId) throw new Error("Structured tmux owner identity mismatch");
    if (!["starting", "running", "exited"].includes(value.status)) throw new Error("Invalid structured tmux worker status");
    if (value.status !== "exited" && value.workerPid && !alive(value.workerPid) && !(value.supervisorPid && alive(value.supervisorPid))) {
      // The supervisor may have atomically published exit after our initial read.
      const latest = JSON.parse(readFileSync(job.state, "utf8")) as WorkerState;
      if (latest.runId === job.runId && latest.incarnationId === job.incarnationId && latest.status === "exited") return latest;
      if (existsSync(`${job.state}.supervisor-exit`)) {
        const acknowledged = JSON.parse(readFileSync(`${job.state}.supervisor-exit`, "utf8"));
        if (acknowledged.runId === job.runId && acknowledged.incarnationId === job.incarnationId && acknowledged.pid === value.pid) {
          return { ...value, status: "exited", exitCode: 1, signal: acknowledged.signal, spawnError: "EWORKERLOST" };
        }
      }
      throw new Error("Structured tmux worker disappeared; execution exit is unconfirmed");
    }
    // The child may have exited before the worker drains stdout/stderr and records
    // the close event. Only that generation's worker can authoritatively finish it.
    return value;
  }
  snapshot(job: Job): StructuredRunState {
    const state = this.state(job);
    const log = (file: string): { text: string; size: number; truncated: boolean } => {
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const size = fstatSync(fd).size; const count = Math.min(size, LOG_MAX_BYTES); const bytes = Buffer.alloc(count);
        let read = 0; while (read < count) { const n = readSync(fd, bytes, read, count - read, size - count + read); if (!n) break; read += n; }
        let begin = 0; while (begin < read && (bytes[begin] & 0xc0) === 0x80) begin++;
        let end = read;
        if (state.status !== "exited" && end > begin) {
          // Leave an incomplete final UTF-8 code point for the adopted stream.
          let lead = end - 1;
          while (lead > begin && (bytes[lead] & 0xc0) === 0x80) lead--;
          const first = bytes[lead];
          const width = first >= 0xf0 && first <= 0xf4 ? 4 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xc2 && first <= 0xdf ? 2 : 1;
          if (end - lead < width) end = lead;
        }
        const decoder = createUtf8TextDecoder();
        return { text: decoder.write(bytes.subarray(begin, end)), size: size - count + end, truncated: size > count };
      } finally { closeSync(fd); }
    };
    const stdout = log(job.stdout); const stderr = log(job.stderr);
    return { runId: job.runId, incarnationId: job.incarnationId, pid: state.pid,
      status: state.status === "exited" ? "exited" : "running", exitCode: state.exitCode,
      signal: state.signal ? signalNumberFromName(state.signal) : null,
      stdoutSeq: stdout.size, stderrSeq: stderr.size, stdoutLog: stdout.text, stderrLog: stderr.text,
      stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated };
  }
  spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    const retiring = this.forgets.get(request.runId);
    if (retiring) return retiring.then(() => this.spawnStructured(request));
    const requestId = request.requestId ?? "";
    const pending = this.starts.get(request.runId);
    if (pending) {
      if (pending.requestId !== requestId) {
        return Promise.reject(Object.assign(new Error("Structured run startup is already reserved; refusing duplicate input delivery"), { preflightBlocked: true }));
      }
      return pending.promise;
    }
    let complete!: (process: StructuredExecProcess) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<StructuredExecProcess>((resolve, reject) => { complete = resolve; fail = reject; });
    this.starts.set(request.runId, { requestId, promise });
    void this.spawnReserved(request).then(complete, fail);
    void promise.finally(() => {
      if (this.starts.get(request.runId)?.promise === promise) this.starts.delete(request.runId);
    }).catch(() => {});
    return promise;
  }
  private async spawnReserved(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    if (request.launchSignal?.aborted) throw new Error("Structured CLI startup cancelled before input delivery");
    const legacyState = await this.legacy.attachRun(request.runId);
    const existing = this.job(request.runId);
    if (legacyState?.status === "running" && !existing) {
      this.owners.set(request.runId, "legacy");
      return this.legacy.spawnStructured(request);
    }
    if (legacyState?.status === "running" && existing && !existsSync(existing.ack)) throw Object.assign(new Error("Structured run has conflicting legacy and tmux owners"), { preflightBlocked: true });
    if (existing && existsSync(existing.ack)) {
      if (this.state(existing).status !== "exited") throw Object.assign(new Error("Acknowledged structured tmux generation is not authoritatively exited"), { preflightBlocked: true });
      if (legacyState?.status === "running") {
        this.owners.set(request.runId, "legacy");
        return this.legacy.spawnStructured(request);
      }
      if (this.job(request.runId)?.incarnationId !== existing.incarnationId) {
        throw Object.assign(new Error("Structured tmux generation changed during run ID reuse"), { preflightBlocked: true });
      }
      rmSync(path.join(this.slot(request.runId), "current.json"), { force: true });
    }
    if (existing && !existsSync(existing.ack)) {
      const state = this.state(existing);
      if (request.launchSignal?.aborted) throw new Error("Structured CLI startup cancelled before input delivery");
      if (state.status !== "exited") {
        if (request.requestId && request.requestId === existing.requestId) return new TmuxProcess(existing, this);
        throw Object.assign(new Error("Structured run is already owned by a tmux execution; refusing to deliver input twice"), { preflightBlocked: true });
      }
      throw Object.assign(new Error("Previous structured tmux execution must be forgotten before run ID reuse"), { preflightBlocked: true });
    }
    if (!this.enabled) {
      this.owners.set(request.runId, "legacy");
      return this.legacy.spawnStructured(request);
    }
    const slot = this.slot(request.runId); mkdirSync(slot, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(path.join(slot, "turn-")); const incarnationId = randomUUID();
    const sid = request.runId.replace(/^structured:/, "").replace(/[^a-zA-Z0-9-]/g, "-");
    const job: Job = { runId: request.runId, incarnationId, requestId: request.requestId ?? incarnationId,
      tmux: `${this.prefix}${sid}-${incarnationId.slice(0, 8)}`, dir,
      state: path.join(dir, "state.json"), stdout: path.join(dir, "stdout.log"),
      stderr: path.join(dir, "stderr.log"), ack: path.join(dir, "ack") };
    writeFileSync(job.stdout, "", { mode: 0o600 }); writeFileSync(job.stderr, "", { mode: 0o600 });
    atomic(job.state, { runId: job.runId, incarnationId, status: "starting", pid: -1, exitCode: null, signal: null });
    const launchDir = mkdtempSync(path.join(os.tmpdir(), "wand-structured-launch-"));
    const socketPath = path.join(launchDir, "launch.sock");
    let handedOff = false; let ready = false; let created = false; let receiver: Socket | null = null;
    const deliver = (): void => {
      if (!ready || !receiver || handedOff) return;
      handedOff = true;
      receiver.end(JSON.stringify({ file: request.file, args: request.args, cwd: request.cwd, env: request.env,
        ...(request.stdinData !== undefined ? { stdinData: request.stdinData } : {}), state: job.state,
        stdout: job.stdout, stderr: job.stderr, requestId: job.requestId, identity: { runId: job.runId, incarnationId } }) + "\n");
      receiver = null;
    };
    const server = createServer((connection) => { if (handedOff || receiver) { connection.destroy(); return; } receiver = connection; deliver(); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    const command = `exec ${shellQuote(process.execPath)} ${shellQuote(runtimeModule("structured-tmux-worker"))} ${shellQuote(socketPath)} 2>>${shellQuote(path.join(dir, "worker-startup.log"))}`;
    try {
      let exists = false;
      try { await this.tmux(["has-session", "-t", job.tmux]); exists = true; } catch { /* isolated name is available */ }
      if (exists) throw new Error("tmux session name collision; refusing to adopt or stop it");
      await this.tmux(["new-session", "-d", "-s", job.tmux, "-x", "120", "-y", "36", "-c", request.cwd, command]);
      created = true;
      await this.tmux(["set-option", "-t", job.tmux, "@wand-structured-owner", job.runId]);
      const panePid = Number((await this.tmux(["list-panes", "-t", `${job.tmux}:0.0`, "-F", "#{pane_pid}"])).trim());
      if (!Number.isSafeInteger(panePid) || panePid <= 0) throw new Error("Structured tmux worker PID is unavailable");
      atomic(job.state, { runId: job.runId, incarnationId, status: "starting", pid: panePid, workerPid: panePid, exitCode: null, signal: null });
      if (request.launchSignal?.aborted) throw new Error("Structured CLI startup cancelled before input delivery");
      atomic(path.join(slot, "current.json"), job);
      this.owners.set(job.runId, "tmux");
      ready = true; deliver();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const state = this.state(job);
        if (request.launchSignal?.aborted && state.status !== "exited") await this.kill(job);
        if (state.status === "running" || state.status === "exited") return new TmuxProcess(job, this);
        await delay(25);
      }
      throw Object.assign(new Error("Structured tmux startup timed out; launch delivery is unknown"), { deliveryUnknown: handedOff });
    } catch (error) {
      if (!handedOff) {
        (receiver as Socket | null)?.destroy();
        if (created) await this.tmux(["kill-session", "-t", `=${job.tmux}`]);
        atomic(job.state, { runId: job.runId, incarnationId, status: "exited", pid: -1, exitCode: 1, signal: null });
        if (this.job(job.runId)?.incarnationId === incarnationId) writeFileSync(job.ack, "not-delivered\n", { mode: 0o600 });
        throw error;
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUnknown: true });
    } finally {
      server.close(); rmSync(launchDir, { recursive: true, force: true });
    }
  }
  async attachRun(runId: string): Promise<StructuredRunState | null> {
    if (!this.enabled && !this.job(runId)) return this.legacy.attachRun(runId);
    const job = this.job(runId);
    if (job && !existsSync(job.ack)) {
      this.owners.set(runId, "tmux");
      const snapshot = this.snapshot(job);
      this.snapshots.set(runId, snapshot);
      return snapshot;
    }
    const legacy = await this.legacy.attachRun(runId);
    if (legacy) this.owners.set(runId, "legacy");
    return legacy;
  }
  async adoptRun(runId: string): Promise<StructuredExecProcess | null> {
    if (!this.enabled && !this.job(runId)) return this.legacy.adoptRun(runId);
    const job = this.job(runId);
    if (job && !existsSync(job.ack)) {
      const observed = this.snapshots.get(runId);
      this.owners.set(runId, "tmux");
      return new TmuxProcess(job, this, observed?.incarnationId === job.incarnationId ? observed : undefined);
    }
    this.owners.set(runId, "legacy");
    return this.legacy.adoptRun(runId);
  }
  async listRuns(): Promise<StructuredRunState[]> {
    const tmux: StructuredRunState[] = [];
    for (const item of readdirSync(this.root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      let text: string;
      try { text = readFileSync(path.join(this.root, item.name, "current.json"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const record = JSON.parse(text) as Job;
      if (typeof record.runId !== "string" || this.slot(record.runId) !== path.join(this.root, item.name)) {
        throw new Error("Invalid structured tmux inventory record");
      }
      const job = this.job(record.runId);
      if (!job) throw new Error("Structured tmux inventory changed during observation");
      if (!existsSync(job.ack)) {
        tmux.push(this.snapshot(job));
        this.owners.set(job.runId, "tmux");
      }
    }
    const legacy = await this.legacy.listRuns();
    for (const run of legacy) {
      if (tmux.some((state) => state.runId === run.runId)) throw new Error(`structured run ${run.runId} has conflicting owners`);
      this.owners.set(run.runId, "legacy");
    }
    return [...legacy, ...tmux];
  }
  kill(job: Job, signal = "SIGTERM"): Promise<void> {
    try { if (this.state(job).status === "exited") return Promise.resolve(); }
    catch { /* uncertain identity/state must still fail closed in tmux ownership checks */ }
    const previous = this.terminations.get(job.incarnationId);
    if (previous) return previous;
    const stopping = (async () => {
      const state = this.state(job);
      if (!Number.isSafeInteger(state.pid) || state.pid <= 0) {
        throw new Error("Structured tmux process identity is unavailable; refusing termination");
      }
      const name = (await this.tmux(["display-message", "-p", "-t", job.tmux, "#{session_name}"])).trim();
      if (name !== job.tmux) throw new Error("Structured tmux exact target mismatch; refusing termination");
      const owner = (await this.tmux(["show-options", "-v", "-t", job.tmux, "@wand-structured-owner"])).trim();
      if (owner !== job.runId) throw new Error("Structured tmux owner mismatch; refusing termination");
      const pane = Number((await this.tmux(["list-panes", "-t", `${job.tmux}:0.0`, "-F", "#{pane_pid}"])).trim());
      if (!state.workerPid || pane !== state.workerPid) throw new Error("Structured tmux pane generation mismatch");
      const requested = signal ?? "SIGTERM";
      if (requested === "SIGKILL") {
        try { process.kill(-(state.pid), "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else {
        try { process.kill(-(state.pid), requested as NodeJS.Signals); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (this.state(job).status === "exited") return;
        await delay(25);
      }
      if (requested !== "SIGKILL") {
        try { process.kill(-(state.pid), "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      const killDeadline = Date.now() + 5000;
      while (Date.now() < killDeadline) {
        if (this.state(job).status === "exited") return;
        await delay(25);
      }
      throw new Error("Structured tmux execution termination is unconfirmed");
    })();
    this.terminations.set(job.incarnationId, stopping);
    void stopping.catch(() => this.terminations.delete(job.incarnationId));
    return stopping;
  }
  forgetRun(runId: string): void {
    const current = this.job(runId);
    if (!current || existsSync(current.ack)) { this.legacy.forgetRun(runId); return; }
    this.owners.set(runId, "tmux");
    const job = this.job(runId);
    if (!job) throw new Error("Structured tmux owner record is unavailable; refusing forget");
    const existing = this.forgets.get(runId);
    if (existing) return;
    const forgetting = (async () => {
      await this.kill(job);
      if (this.job(runId)?.incarnationId !== job.incarnationId) {
        throw new Error("Structured tmux generation changed before forget acknowledgement");
      }
      if (this.state(job).status !== "exited") throw new Error("Structured tmux execution is still running; refusing forget");
      writeFileSync(job.ack, "consumed\n", { mode: 0o600 });
    })();
    this.forgets.set(runId, forgetting);
    void forgetting.finally(() => { if (this.forgets.get(runId) === forgetting) this.forgets.delete(runId); }).catch(() => {});
  }
}
