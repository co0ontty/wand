import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, openSync, closeSync, readSync, statSync, renameSync, rmSync } from "node:fs";
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
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: TerminalExitEvent) => void): { dispose(): void };
}
interface RecordState {
  sessionId: string; name: string; cols: number; rows: number;
  launchMarkerToken?: string; pid: number; exitCode?: number;
}
const bootstrap = `const net=require('node:net'),{spawn}=require('node:child_process');
const s=net.connect(process.argv[1]);let b='';s.on('data',d=>{b+=d;const n=b.indexOf('\\n');if(n<0)return;
s.removeAllListeners('data');const r=JSON.parse(b.slice(0,n));const c=spawn(r.file,r.args,{cwd:r.cwd,env:r.env,stdio:'inherit'});
c.on('spawn',()=>s.end(JSON.stringify({pid:c.pid})+'\\n'));c.on('error',()=>process.exit(127));
c.on('exit',(code,signal)=>process.exit(code===null?128:code));});s.on('error',()=>process.exit(125));`;
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** A private tmux server owns panes; attach transports are disposable, not execution owners. */
export class PtyTmuxBackend {
  private readonly directory: string;
  private readonly socket: string;
  constructor(configPath: string) {
    this.directory = path.join(path.dirname(configPath), "pty-tmux");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 20);
    this.socket = `/tmp/wand-pty-${process.getuid?.() ?? 0}-${hash}.sock`;
  }
  private tmux(...args: string[]): string {
    return execFileSync("tmux", ["-S", this.socket, "-f", "/dev/null", ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
    }).trim();
  }
  forget(sessionId: string): void {
    for (const file of readdirSync(this.directory).filter(file => file.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(path.join(this.directory, file), "utf8")) as RecordState;
      if (record.sessionId === sessionId) {
        if (record.exitCode === undefined) throw new Error("tmux termination is not acknowledged");
        try { this.tmux("kill-session", "-t", record.name); } catch { /* Already destroyed or naturally exited. */ }
        unlinkSync(path.join(this.directory, file));
        rmSync(path.join(this.directory, `${record.name}.output`), { recursive: true, force: true });
      }
    }
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
    const name = `w${randomUUID().replaceAll("-", "")}`;
    const ipc = `/tmp/wand-pty-launch-${randomUUID()}.sock`;
    let accept!: (pid: number) => void;
    let reject!: (error: Error) => void;
    const delivered = new Promise<number>((yes, no) => { accept = yes; reject = no; });
    let ready!: () => void;
    const configured = new Promise<void>(resolve => { ready = resolve; });
    const server = net.createServer(socket => {
      server.close();
      void configured.then(() => socket.write(`${JSON.stringify(request)}\n`));
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
    const record: RecordState = { sessionId: request.sessionId, name, cols: request.cols, rows: request.rows,
      launchMarkerToken: request.launchMarkerToken, pid: 0 };
    // Publish ownership before launch, never persist the command, environment or prompt.
    this.save(record);
    try {
      this.tmux("new-session", "-d", "-s", name, "-x", String(request.cols), "-y", String(request.rows),
        `${quote(process.execPath)} -e ${quote(bootstrap)} ${quote(ipc)}`,
        ";", "set-option", "-t", name, "remain-on-exit", "on",
        ";", "set-option", "-t", name, "status", "off");
      const log = path.join(this.directory, `${name}.output`);
      mkdirSync(log, { mode: 0o700 });
      this.tmux("pipe-pane", "-O", "-t", `${name}:0.0`,
        `exec ${quote(process.execPath)} -e ${quote(ptyTmuxLogWriter)} ${quote(log)}`);
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
    const drain = (): boolean => {
      const segments = readdirSync(log).filter(file => /^\d+\.chunk$/.test(file)).map(file => Number(file.split(".")[0])).sort((a, b) => a - b);
      if (!segments.length) return false;
      if (segment < segments[0]) {
        segment = segments[0]; offset = 0; decoder = new StringDecoder("utf8");
        for (const listener of data) listener("\u001bc[Wand: terminal replay truncated]\r\n");
        try { preservedMarker = readFileSync(path.join(log, "marker"), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const file = path.join(log, `${segment}.chunk`);
      const size = statSync(file).size;
      if (offset >= size) {
        if (segment < segments[segments.length - 1]) { segment++; offset = 0; return false; }
        if (preservedMarker) { for (const listener of data) listener(preservedMarker); preservedMarker = ""; }
        return true;
      }
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(Math.min(size - offset, 256 * 1024));
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        offset += count;
        const chunk = decoder.write(buffer.subarray(0, count));
        if (chunk) for (const listener of data) listener(chunk);
      } finally { closeSync(fd); }
      return offset >= size && segment === segments[segments.length - 1] && !preservedMarker;
    };
    const inspect = (): string => this.tmux("display-message", "-p", "-t", `${record.name}:0.0`, "#{pane_dead}:#{pane_dead_status}:#{pane_pipe}");
    const finish = (exitCode: number): void => {
      if (exited) return;
      exited = { exitCode };
      record.exitCode = exitCode;
      this.save(record);
      clearInterval(timer);
      transport?.kill();
      for (const listener of exits) listener(exited);
    };
    const connect = (): void => {
      ensureNodePtyHelperExecutable();
      transport = pty.spawn("tmux", ["-S", this.socket, "attach-session", "-t", record.name], {
        name: "xterm-256color", cols: record.cols, rows: record.rows,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color" },
      });
      transport.onData(() => {}); // Raw pipe-pane bytes, not screen repaint, are the PTY stream.
      transport.onExit(() => { transport = null; });
    };
    const timer = setInterval(() => {
      try {
        const state = record.exitCode === undefined ? inspect() : null;
        if (state?.startsWith("0:") && state.split(":")[2] !== "1") reportFailure();
        if (observationFailed) return;
        const drained = drain();
        if (record.exitCode !== undefined) { if (drained) finish(record.exitCode); return; }
        if (state?.startsWith("1:")) { if (drained) finish(Number(state.split(":")[1]) || 0); }
        else if (!transport && !stopping) connect();
      } catch (error) {
        // A segment can disappear between listing and opening during ring rotation.
        // Other observation failures never acknowledge execution exit.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") reportFailure();
      }
    }, 100);
    timer.unref();
    if (record.exitCode === undefined) try { if (!inspect().startsWith("1:")) connect(); } catch { /* Keep unknown published ownership visible and block new launches. */ }
    return {
      pid: record.pid,
      write(chunk) { if (!transport || stopping || observationFailed) throw new Error("tmux terminal transport unavailable"); transport.write(chunk); },
      resize: (cols, rows) => { this.tmux("resize-window", "-t", record.name, "-x", String(cols), "-y", String(rows)); transport?.resize(cols, rows); },
      kill: () => {
        if (exited) return;
        // Successful kill-session is the acknowledgement that the pane, not merely its client, was destroyed.
        const panePid = Number(this.tmux("display-message", "-p", "-t", `${record.name}:0.0`, "#{pane_pid}"));
        if (!Number.isSafeInteger(panePid) || panePid <= 0) throw new Error("Invalid tmux pane owner PID");
        const tree = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
          .map(line => line.trim().split(/\s+/).map(Number));
        const descendants = (pid: number): number[] => tree.filter(row => row[1] === pid)
          .flatMap(row => [...descendants(row[0]), row[0]]);
        for (const pid of descendants(panePid)) {
          try { process.kill(pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        this.tmux("kill-session", "-t", record.name);
        stopping = true;
        finish(137);
      },
      onData(listener) { data.add(listener); return { dispose() { data.delete(listener); } }; },
      onExit(listener) { exits.add(listener); if (exited) queueMicrotask(() => listener(exited!)); return { dispose() { exits.delete(listener); } }; },
    };
  }
}
