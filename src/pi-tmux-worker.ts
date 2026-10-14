// RUNTIME-LOADED BY PATH by pi-tmux-host.ts. This worker is the tmux pane's
// actual process and starts Pi with inherited terminal stdin/stdout (native TUI).
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

interface Launch {
  file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  state: string; stderr: string; paths: string;
}

const socketPath = process.argv[2];
if (!socketPath) throw new Error("Missing Pi native launch socket");
const launch = await new Promise<Launch>((resolve, reject) => {
  const socket = createConnection(socketPath);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setTimeout(15000, () => socket.destroy(new Error("Pi native launch timed out")));
  socket.on("data", (text) => {
    buffer += text;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { socket.destroy(new Error("Pi native launch is oversized")); return; }
    const end = buffer.indexOf("\n");
    if (end >= 0) {
      try { resolve(JSON.parse(buffer.slice(0, end)) as Launch); }
      catch (error) { reject(error); }
      socket.destroy();
    }
  });
  socket.on("error", reject);
});
const identity = JSON.parse(readFileSync(launch.state, "utf8")) as Record<string, unknown>;
const save = (fields: Record<string, unknown>): void => {
  const temporary = `${launch.state}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...identity, ...fields }) + "\n", { mode: 0o600 });
  renameSync(temporary, launch.state);
};
const env = { ...launch.env, WAND_PI_NATIVE_PATHS: launch.paths,
  TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE,
  TERM: process.env.TERM || "screen-256color", PWD: launch.cwd };
let child: ChildProcess;
try {
  child = spawn(launch.file, launch.args, { cwd: launch.cwd, env, stdio: ["inherit", "inherit", "pipe"] });
} catch (error) {
  save({ status: "exited", pid: process.pid, exitCode: 1, signal: null, spawnError: (error as NodeJS.ErrnoException).code ?? "ESPAWN" });
  process.exitCode = 1;
  throw error;
}
save({ status: "running", pid: child.pid ?? process.pid, workerPid: process.pid });
child.stderr?.on("data", (bytes: Buffer) => {
  appendFileSync(launch.stderr, bytes, { mode: 0o600 });
  process.stderr.write(bytes);
});
child.on("error", (error: NodeJS.ErrnoException) => {
  save({ status: "exited", pid: child.pid ?? process.pid, exitCode: 1, signal: null, spawnError: error.code ?? "ESPAWN" });
});
child.on("close", (code, signal) => {
  save({ status: "exited", pid: child.pid ?? process.pid, workerPid: process.pid, exitCode: code, signal });
  process.exitCode = code ?? 1;
});
// Pi owns raw-mode keyboard handling. Do not turn an abort key into a second
// signal. Explicit tmux shutdown still reaches the child through SIGHUP.
process.on("SIGINT", () => {});
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* child already closed */ } });
}
