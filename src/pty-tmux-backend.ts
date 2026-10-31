import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, openSync, closeSync, readSync, statSync, renameSync, rmSync, lstatSync, existsSync } from "node:fs";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { ptyTmuxLogWriter } from "./pty-tmux-log.js";
import path from "node:path";
import pty from "node-pty";
import { ensureNodePtyHelperExecutable } from "./ensure-node-pty-helper.js";
import type { TerminalSpawnRequest, TerminalExitEvent } from "./terminal-host.js";

export interface DaemonPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /** Retire only the observer/attach client; the tmux pane keeps running. */
  detach?(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: TerminalExitEvent) => void): { dispose(): void };
}
interface RecordState {
  sessionId: string; name: string; cols: number; rows: number;
  socket?: "default"; pane?: string; panePid?: number;
  launchMarkerToken?: string; pid: number; exitCode?: number;
}
const bootstrap = `const net=require('node:net'),{spawn}=require('node:child_process');
const s=net.connect(process.argv[1]);let b='';s.on('data',d=>{b+=d;const n=b.indexOf('\\n');if(n<0)return;
s.removeAllListeners('data');const r=JSON.parse(b.slice(0,n));const c=spawn(r.file,r.args,{cwd:r.cwd,env:r.env,stdio:'inherit'});
c.on('spawn',()=>s.end(JSON.stringify({pid:c.pid})+'\\n'));c.on('error',()=>process.exit(127));
c.on('exit',(code,signal)=>process.exit(code===null?128:code));});s.on('error',()=>process.exit(125));`;
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export interface PtyTmuxGcReport {
  removedRecords: number;
  freedBytes: number;
  removedSockets: number;
}

function directoryLatestMtime(directory: string): number {
  let latest = lstatSync(directory).mtimeMs;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) latest = Math.max(latest, directoryLatestMtime(child));
    else latest = Math.max(latest, stat.mtimeMs);
  }
  return latest;
}

function directoryBytes(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += directoryBytes(child);
    else total += stat.size;
  }
  return total;
}

function streamSocketPath(recordName: string): string {
  const hash = createHash("sha256").update(recordName).digest("hex").slice(0, 16);
  const uid = process.getuid?.() ?? 0;
  return path.join("/tmp", `wand-pts-${uid}-${hash}.sock`);
}

/** The default tmux server owns panes; attach transports are disposable, not execution owners. */
export class PtyTmuxBackend {
  private readonly directory: string;
  private readonly legacySocket: string;
  constructor(configPath: string) {
    this.directory = path.join(path.dirname(configPath), "pty-tmux");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 20);
    this.legacySocket = `/tmp/wand-pty-${process.getuid?.() ?? 0}-${hash}.sock`;
  }
  private connection(record: RecordState): string[] {
    if (record.socket === "default") return ["-L", "default"];
    if (record.socket !== undefined) throw new Error("Unknown tmux terminal owner socket");
    return ["-S", this.legacySocket];
  }
  private tmux(record: RecordState, ...args: string[]): string {
    return execFileSync("tmux", [...this.connection(record), ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMUX_TMPDIR: process.env.TMUX_TMPDIR },
    }).trim();
  }
  private pane(record: RecordState): string { return record.pane ?? `=${record.name}:0.0`; }
  /**
   * 只认稳定身份：会话名 + 我们创建的 pane id + 写入的 owner 标记。
   * `pane_pid` 在新建后可能还没就绪，不能作为归属证据；需要时从实时结果取。
   */
  private assertOwner(record: RecordState): number | null {
    if (record.socket !== "default") return record.panePid ?? null; // 旧私有 server 没有 owner 标记。
    let fields: string[] = [];
    try {
      fields = this.tmux(record, "list-panes", "-t", `=${record.name}`,
        "-F", "#{pane_id}\t#{session_name}\t#{@wand-pty-owner}\t#{pane_pid}").split("\n")
        .find(entry => entry.startsWith(`${record.pane}\t`))?.split("\t") ?? [];
    } catch (error) {
      if (this.isTmuxMissing(error)) return record.panePid ?? null;
      throw error;
    }
    if (fields.length > 0 && fields[2] === record.sessionId) {
      if (fields[0] !== record.pane || fields[1] !== record.name) {
        throw new Error("tmux terminal ownership changed; refusing to control another pane");
      }
      const pid = Number(fields[3]);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    }
    // A different owner tag is conclusive; pane missing or not published is non-fatal check.
    if (fields.length > 0 && fields[2]) {
      throw new Error("tmux terminal ownership changed; refusing to control another pane");
    }
    return record.panePid ?? null;
  }
  private isTmuxMissing(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const err = error as { stderr?: unknown; message?: string };
    const text = `${typeof err.stderr === "string" ? err.stderr : ""} ${err.message ?? ""}`.toLowerCase();
    return text.includes("no server running") ||
      text.includes("error connecting to") ||
      text.includes("failed to connect") ||
      text.includes("can't find session") ||
      text.includes("session not found") ||
      text.includes("can't find pane") ||
      text.includes("can't find window") ||
      text.includes("no such file or directory");
  }
  forget(sessionId: string): void {
    for (const file of readdirSync(this.directory).filter(file => file.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(path.join(this.directory, file), "utf8")) as RecordState;
      if (record.sessionId === sessionId) {
        if (record.exitCode === undefined) throw new Error("tmux termination is not acknowledged");
        try {
          this.assertOwner(record);
          this.tmux(record, "kill-session", "-t", `=${record.name}`);
        } catch (error) { if (!this.isTmuxMissing(error)) throw error; }
        unlinkSync(path.join(this.directory, file));
        rmSync(path.join(this.directory, `${record.name}.output`), { recursive: true, force: true });
      }
    }
  }

  collectGarbage(options: {
    activeSessionIds: ReadonlySet<string>;
    retentionMs: number;
    now?: number;
  }): PtyTmuxGcReport {
    return PtyTmuxBackend.collectGarbage(path.dirname(this.directory), options);
  }

  static collectGarbage(configDir: string, options: {
    activeSessionIds: ReadonlySet<string>;
    retentionMs: number;
    now?: number;
  }): PtyTmuxGcReport {
    const report: PtyTmuxGcReport = { removedRecords: 0, freedBytes: 0, removedSockets: 0 };
    const now = options.now ?? Date.now();
    const directory = path.join(configDir, "pty-tmux");

    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { /* directory not created */ }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const jsonPath = path.join(directory, entry.name);
      let record: RecordState;
      try { record = JSON.parse(readFileSync(jsonPath, "utf8")) as RecordState; }
      catch { continue; }
      if (options.activeSessionIds.has(record.sessionId)) continue;
      if (record.exitCode === undefined) continue;

      const outputDir = path.join(directory, `${record.name}.output`);
      let latestMtime = statSync(jsonPath).mtimeMs;
      let bytes = statSync(jsonPath).size;
      if (existsSync(outputDir)) {
        try {
          latestMtime = Math.max(latestMtime, directoryLatestMtime(outputDir));
          bytes += directoryBytes(outputDir);
        } catch { continue; }
      }

      if (now - latestMtime < options.retentionMs) continue;

      try {
        unlinkSync(jsonPath);
        if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
        report.removedRecords += 1;
        report.freedBytes += bytes;
      } catch { /* concurrent removal or permission error */ }
    }

    const uid = process.getuid?.() ?? 0;
    const prefix = `wand-pty-${uid}-`;
    const streamPrefix = `wand-pts-${uid}-`;
    let tmpEntries: string[] = [];
    try { tmpEntries = readdirSync("/tmp"); } catch { tmpEntries = []; }
    for (const name of tmpEntries) {
      if ((!name.startsWith(prefix) && !name.startsWith(streamPrefix)) || !name.endsWith(".sock")) continue;
      const socketPath = path.join("/tmp", name);
      try {
        const stat = lstatSync(socketPath);
        if (!stat.isSocket()) continue;
        if (name.startsWith(streamPrefix)) {
          const probe = net.connect(socketPath);
          probe.on("error", () => {
            try { unlinkSync(socketPath); report.removedSockets += 1; } catch { /* ignore */ }
          });
          probe.on("connect", () => { probe.destroy(); });
          continue;
        }
        try {
          execFileSync("tmux", ["-S", socketPath, "-f", "/dev/null", "ls"], {
            encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1000,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
          });
        } catch (probeError) {
          const err = probeError as { stderr?: unknown; message?: string };
          const text = `${typeof err.stderr === "string" ? err.stderr : ""} ${err.message ?? ""}`.toLowerCase();
          if (text.includes("no server running") || text.includes("error connecting to") || text.includes("failed to connect")) {
            try {
              unlinkSync(socketPath);
              report.removedSockets += 1;
            } catch { /* ignore */ }
          }
        }
      } catch { /* socket vanished during iteration */ }
    }

    return report;
  }
  recover(exclude: ReadonlySet<string> = new Set()): Array<{ request: TerminalSpawnRequest; child: DaemonPty }> {
    return readdirSync(this.directory).filter(file => file.endsWith(".json"))
      .map(file => JSON.parse(readFileSync(path.join(this.directory, file), "utf8")) as RecordState)
      .filter(record => !exclude.has(record.sessionId)).map(record => {
      const request: TerminalSpawnRequest = { ...record, file: "", args: [], cwd: this.directory, env: {}, name: "xterm-256color" };
      return { request, child: this.attach(record) };
    });
  }
  async spawn(request: TerminalSpawnRequest): Promise<DaemonPty> {
    for (const file of readdirSync(this.directory).filter(file => file.endsWith(".json"))) {
      const previous = JSON.parse(readFileSync(path.join(this.directory, file), "utf8")) as RecordState;
      if (previous.sessionId === request.sessionId) throw new Error("Previous tmux ownership remains; refusing to replay launch");
    }
    if (process.platform === "win32") throw new Error("tmux PTY requires a POSIX host");
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    const name = `wand-pty-${request.sessionId.replace(/[^a-zA-Z0-9-]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const ipc = `/tmp/wand-pty-launch-${randomUUID()}.sock`;
    let accept!: (pid: number) => void;
    let reject!: (error: Error) => void;
    const delivered = new Promise<number>((yes, no) => { accept = yes; reject = no; });
    let ready!: () => void;
    const configured = new Promise<void>(resolve => { ready = resolve; });
    const server = net.createServer(socket => {
      server.close();
      // node-pty and Render derive TERM from name. This bootstrap uses ordinary
      // spawn with a replacement env, so it must apply the same contract itself.
      const launchRequest = { ...request, env: {
        ...request.env,
        TERM: request.name || request.env.TERM || "xterm-color",
      } };
      void configured.then(() => socket.write(`${JSON.stringify(launchRequest)}\n`));
      let response = "";
      socket.on("data", data => { response += data; });
      socket.on("end", () => {
        try {
          const pid = JSON.parse(response).pid;
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid tmux shell PID");
          accept(pid);
        } catch (error) { reject(error as Error); }
      });
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, fail) => { server.once("error", fail); server.listen(ipc, () => { chmodSync(ipc, 0o600); resolve(); }); });
    const timer = setTimeout(() => reject(new Error("tmux launch acknowledgement missing; input was not retried")), 10000);
    const record: RecordState = { sessionId: request.sessionId, name, socket: "default", cols: request.cols, rows: request.rows,
      launchMarkerToken: request.launchMarkerToken, pid: 0 };
    // Publish ownership before launch, never persist the command, environment or prompt.
    this.save(record);
    try {
      record.pane = this.tmux(record, "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name,
        "-x", String(request.cols), "-y", String(request.rows),
        `${quote(process.execPath)} -e ${quote(bootstrap)} ${quote(ipc)}`);
      if (!/^%\d+$/.test(record.pane)) throw new Error("tmux terminal pane identity is unavailable");
      record.panePid = Number(this.tmux(record, "display-message", "-p", "-t", record.pane, "#{pane_pid}"));
      if (!Number.isSafeInteger(record.panePid) || record.panePid <= 0) throw new Error("Invalid tmux terminal pane PID");
      this.tmux(record, "set-option", "-t", name, "@wand-pty-owner", record.sessionId);
      this.tmux(record, "set-window-option", "-t", record.pane, "remain-on-exit", "on");
      this.tmux(record, "set-option", "-t", name, "status", "off");
      this.save(record);
      const log = path.join(this.directory, `${name}.output`);
      mkdirSync(log, { mode: 0o700 });
      const sockPath = streamSocketPath(name);
      try { unlinkSync(sockPath); } catch {}
      this.tmux(record, "pipe-pane", "-O", "-t", record.pane,
        `exec ${quote(process.execPath)} -e ${quote(ptyTmuxLogWriter)} ${quote(log)} ${quote(sockPath)}`);
      ready();
      record.pid = await delivered;
      this.save(record);
      return this.attach(record);
    } finally {
      clearTimeout(timer);
      server.close();
      try { unlinkSync(ipc); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  private save(record: RecordState): void {
    const target = path.join(this.directory, `${record.name}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, target);
  }
  private attach(record: RecordState): DaemonPty {
    const data = new Set<(data: string) => void>();
    const exits = new Set<(event: TerminalExitEvent) => void>();
    let transport: pty.IPty | null = null;
    let exited: TerminalExitEvent | null = null;
    let stopping = false;
    let observationFailed = false;
    const reportFailure = (): void => {
      if (observationFailed) return;
      observationFailed = true;
      const message = "\r\n[Wand: terminal output observation failed; execution ownership retained, input blocked. Stop this terminal explicitly.]\r\n";
      for (const listener of data) listener(message);
      console.error(`[wand] tmux terminal observation failed: ${record.sessionId}; ownership retained`);
    };
    let offset = 0;
    let decoder = new StringDecoder("utf8");
    let segment = 0;
    let preservedMarker = "";
    const log = path.join(this.directory, `${record.name}.output`);
    const drain = (targetSegment?: number, targetSize?: number): boolean => {
      let segments: number[] = [];
      try {
        segments = readdirSync(log).filter(file => /^\d+\.chunk$/.test(file)).map(file => Number(file.split(".")[0])).sort((a, b) => a - b);
      } catch { return false; }
      if (!segments.length) return false;
      if (segment < segments[0]) {
        segment = segments[0]; offset = 0; decoder = new StringDecoder("utf8");
        for (const listener of data) listener("\u001bc[Wand: terminal replay truncated]\r\n");
        try { preservedMarker = readFileSync(path.join(log, "marker"), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const maxSegment = typeof targetSegment === "number" ? Math.min(targetSegment, segments[segments.length - 1]) : segments[segments.length - 1];
      while (segment <= maxSegment) {
        const file = path.join(log, `${segment}.chunk`);
        let size = 0;
        try { size = statSync(file).size; } catch { break; }
        const limitSize = (typeof targetSegment === "number" && segment === targetSegment && typeof targetSize === "number")
          ? Math.min(size, targetSize)
          : size;
        if (offset >= limitSize) {
          if (segment < maxSegment) { segment++; offset = 0; continue; }
          if (preservedMarker) { for (const listener of data) listener(preservedMarker); preservedMarker = ""; }
          return true;
        }
        const fd = openSync(file, "r");
        try {
          const buffer = Buffer.alloc(Math.min(limitSize - offset, 256 * 1024));
          const count = readSync(fd, buffer, 0, buffer.length, offset);
          offset += count;
          const chunk = decoder.write(buffer.subarray(0, count));
          if (chunk) for (const listener of data) listener(chunk);
        } finally { closeSync(fd); }
        if (offset >= limitSize) {
          if (segment < maxSegment) { segment++; offset = 0; continue; }
          return true;
        }
      }
      return false;
    };
    const inspect = (): string => {
      this.assertOwner(record);
      return this.tmux(record, "display-message", "-p", "-t", this.pane(record), "#{pane_dead}:#{pane_dead_status}:#{pane_pipe}");
    };
    const finish = (exitCode: number): void => {
      if (exited) return;
      exited = { exitCode };
      record.exitCode = exitCode;
      this.save(record);
      clearInterval(timer);
      if (streamSocket) { try { streamSocket.destroy(); } catch {} streamSocket = null; }
      transport?.kill();
      for (const listener of exits) listener(exited);
    };
    const connect = (): void => {
      ensureNodePtyHelperExecutable();
      transport = pty.spawn("tmux", [...this.connection(record), "attach-session", "-t", `=${record.name}`], {
        name: "xterm-256color", cols: record.cols, rows: record.rows,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color", TMUX_TMPDIR: process.env.TMUX_TMPDIR },
      });
      transport.onData(() => {}); // Raw pipe-pane bytes, not screen repaint, are the PTY stream.
      transport.onExit(() => { transport = null; });
    };

    const sockPath = streamSocketPath(record.name);
    let streamSocket: net.Socket | null = null;
    let handshaked = false;
    let handshakeBuffer = "";
    let connectAttempts = 0;

    const checkExitAndFinish = (): void => {
      if (exited) return;
      try {
        const state = inspect();
        if (state.startsWith("1:")) {
          finish(Number(state.split(":")[1]) || 0);
        } else {
          finish(0);
        }
      } catch (error) {
        if (this.isTmuxMissing(error)) finish(137);
        else finish(0);
      }
    };

    const tryConnectStream = (): void => {
      if (stopping || exited) return;
      const client = net.connect(sockPath);
      streamSocket = client;

      client.on("data", (chunk: Buffer) => {
        if (stopping || exited) return;
        if (!handshaked) {
          handshakeBuffer += chunk.toString("utf8");
          const newline = handshakeBuffer.indexOf("\n");
          if (newline < 0) return;
          const line = handshakeBuffer.slice(0, newline);
          const rest = handshakeBuffer.slice(newline + 1);
          handshaked = true;
          let targetSeg: number | undefined;
          let targetSz: number | undefined;
          try {
            const meta = JSON.parse(line) as { segment?: number; size?: number };
            if (typeof meta.segment === "number") targetSeg = meta.segment;
            if (typeof meta.size === "number") targetSz = meta.size;
          } catch {}
          drain(targetSeg, targetSz);
          if (rest.length > 0) {
            for (const listener of data) listener(rest);
          }
          return;
        }
        const text = decoder.write(chunk);
        if (text) {
          for (const listener of data) listener(text);
        }
      });

      client.on("end", () => {
        if (stopping || exited) return;
        drain();
        checkExitAndFinish();
      });

      client.on("error", () => {
        if (streamSocket === client) streamSocket = null;
        if (stopping || exited || handshaked) return;
        if (connectAttempts++ < 30) {
          setTimeout(tryConnectStream, 40).unref();
        } else {
          drain();
          if (record.exitCode !== undefined) {
            finish(record.exitCode);
          } else {
            checkExitAndFinish();
          }
        }
      });

      client.on("close", () => {
        if (streamSocket === client) streamSocket = null;
      });
    };

    tryConnectStream();

    const timer = setInterval(() => {
      if (stopping || exited || observationFailed) {
        clearInterval(timer);
        return;
      }
      try {
        const state = record.exitCode === undefined ? inspect() : null;
        if (state && !state.startsWith("0:") && !state.startsWith("1:")) {
          reportFailure();
          clearInterval(timer);
          return;
        }
        if (state?.startsWith("0:") && state.split(":")[2] !== "1") {
          reportFailure();
          clearInterval(timer);
          return;
        }
        if (state?.startsWith("1:")) {
          drain();
          finish(Number(state.split(":")[1]) || 0);
          clearInterval(timer);
          return;
        }
        if (!transport && !stopping && record.exitCode === undefined) {
          connect();
        }
      } catch (error) {
        if (this.isTmuxMissing(error)) {
          clearInterval(timer);
          finish(137);
        } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          reportFailure();
          clearInterval(timer);
        }
      }
    }, 2000);
    timer.unref();

    if (record.exitCode === undefined) try { if (!inspect().startsWith("1:")) connect(); } catch { /* Keep unknown published ownership visible and block new launches. */ }
    return {
      pid: record.pid,
      detach() {
        stopping = true;
        clearInterval(timer);
        if (streamSocket) { try { streamSocket.destroy(); } catch {} streamSocket = null; }
        transport?.kill(); transport = null;
        data.clear(); exits.clear();
      },
      write(chunk) { if (!transport || stopping || observationFailed) throw new Error("tmux terminal transport unavailable"); transport.write(chunk); },
      resize: (cols, rows) => {
        this.assertOwner(record);
        this.tmux(record, "resize-window", "-t", this.pane(record), "-x", String(cols), "-y", String(rows));
        transport?.resize(cols, rows);
      },
      kill: () => {
        if (exited) return;
        stopping = true;
        clearInterval(timer);
        if (streamSocket) { try { streamSocket.destroy(); } catch {} streamSocket = null; }
        // Successful kill-session is the acknowledgement that the pane, not merely its client, was destroyed.
        let panePid: number | null = null;
        try {
          panePid = this.assertOwner(record);
        } catch (error) {
          if (!this.isTmuxMissing(error)) throw error;
        }

        const killTree = (rootPid: number): void => {
          try {
            const tree = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
              .map(line => line.trim().split(/\s+/).map(Number));
            const descendants = (pid: number): number[] => tree.filter(row => row[1] === pid)
              .flatMap(row => [...descendants(row[0]), row[0]]);
            for (const pid of descendants(rootPid)) {
              try { process.kill(pid, "SIGKILL"); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              }
            }
          } catch { /* ps or process traversal unavailable */ }
        };

        if (panePid !== null) {
          killTree(panePid);
        } else if (record.socket === undefined && record.pid > 0) {
          killTree(record.pid);
          try { process.kill(record.pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }

        try {
          this.tmux(record, "kill-session", "-t", `=${record.name}`);
        } catch (error) {
          if (!this.isTmuxMissing(error)) throw error;
        }
        finish(137);
      },
      onData(listener) { data.add(listener); return { dispose() { data.delete(listener); } }; },
      onExit(listener) { exits.add(listener); if (exited) queueMicrotask(() => listener(exited!)); return { dispose() { exits.delete(listener); } }; },
    };
  }
}
