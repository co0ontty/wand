// Runs inside a private tmux pane. Launch details arrive over a one-shot local socket;
// prompts and credentials are never persisted in the recovery metadata.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { fileURLToPath } from "node:url";

interface Launch {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinData?: string;
  state: string;
  stdout: string;
  stderr: string;
  requestId: string;
  identity: { runId: string; incarnationId: string };
}

const socketPath = process.argv[2];
if (!socketPath) throw new Error("Missing structured tmux launch socket");
const launch = await new Promise<Launch>((resolve, reject) => {
  const socket = createConnection(socketPath);
  let buffer = "";
  let received = false;
  socket.setEncoding("utf8");
  socket.setTimeout(15_000, () => socket.destroy(new Error("Structured tmux launch timed out")));
  socket.on("data", (text) => {
    buffer += text;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { socket.destroy(new Error("Structured tmux launch is oversized")); return; }
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    try { received = true; resolve(JSON.parse(buffer.slice(0, end)) as Launch); }
    catch (error) { reject(error); }
    socket.destroy();
  });
  socket.on("error", reject);
  socket.on("close", () => { if (!received) reject(new Error("Structured tmux launch closed before delivery")); });
});

const validateIdentity = (): void => {
  const identity = JSON.parse(readFileSync(launch.state, "utf8")) as Record<string, unknown>;
  if (identity.runId !== launch.identity.runId || identity.incarnationId !== launch.identity.incarnationId) {
    throw new Error("Structured tmux launch identity changed");
  }
};
validateIdentity();
const save = (fields: Record<string, unknown>): void => {
  validateIdentity();
  const temporary = `${launch.state}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...launch.identity, requestId: launch.requestId, ...fields }) + "\n", { mode: 0o600 });
  renameSync(temporary, launch.state);
};
const supervisorJs = fileURLToPath(new URL("./structured-tmux-supervisor.js", import.meta.url));
const supervisorFile = existsSync(supervisorJs) ? supervisorJs : supervisorJs.replace(/\.js$/, ".ts");
const child = spawn(process.execPath, [supervisorFile], {
  cwd: launch.cwd,
  env: { ...launch.env, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE },
  stdio: [launch.stdinData === undefined ? "ignore" : "pipe", "pipe", "pipe", "ipc"],
  detached: true,
});
let cliPid = -1;
let cliExit: { exitCode: number | null; signal: string | null; failure?: string } | undefined;
let failure: string | undefined;
let escalation: NodeJS.Timeout | undefined;
let closed = false;
const signalChild = (signal: NodeJS.Signals): void => {
  const pid = cliPid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || closed) return;
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
};
const stopOnFailure = (error: unknown): void => {
  failure ??= (error as NodeJS.ErrnoException).code ?? "EWORKER";
  signalChild("SIGTERM");
  escalation ??= setTimeout(() => signalChild("SIGKILL"), 1000);
  escalation.unref();
};
// A synchronous logging/state failure must not strand the detached process group.
process.on("uncaughtException", stopOnFailure);
const sizes = { stdout: 0, stderr: 0 };
const append = (stream: "stdout" | "stderr", bytes: Buffer): void => {
  if (failure) return;
  try {
    // Never silently drop protocol output. Exceeding the disk budget fails this run.
    if (sizes[stream] + bytes.length > 64 * 1024 * 1024) throw Object.assign(new Error("Structured output limit exceeded"), { code: "EOUTPUTLIMIT" });
    appendFileSync(launch[stream], bytes, { mode: 0o600 });
    sizes[stream] += bytes.length;
  } catch (error) { stopOnFailure(error); }
};
child.once("spawn", () => {
  save({ status: "starting", pid: process.pid, workerPid: process.pid, supervisorPid: child.pid, exitCode: null, signal: null });
  child.send({ ...launch, workerPid: process.pid,
    env: { ...launch.env, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE } });
});
child.on("message", (message: { pid?: number; exitCode?: number | null; signal?: string | null; failure?: string }) => {
  if (message.pid) {
    cliPid = message.pid;
    save({ status: "running", pid: cliPid, workerPid: process.pid, supervisorPid: child.pid, exitCode: null, signal: null });
    if (launch.stdinData !== undefined) child.stdin?.end(launch.stdinData);
  } else {
    cliExit = { exitCode: message.exitCode ?? null, signal: message.signal ?? null, failure: message.failure };
    failure ??= message.failure;
  }
});
child.stdout?.on("data", (bytes: Buffer) => append("stdout", bytes));
child.stderr?.on("data", (bytes: Buffer) => append("stderr", bytes));
child.stdout?.on("error", stopOnFailure);
child.stderr?.on("error", stopOnFailure);
child.stdin?.on("error", stopOnFailure);
child.once("error", (error: NodeJS.ErrnoException) => { failure ??= error.code ?? "ESPAWN"; });
child.once("close", (code, signal) => {
  closed = true;
  if (escalation) clearTimeout(escalation);
  // Losing the supervisor is not evidence that its CLI exited.
  if (!cliExit && cliPid > 0) { process.exitCode = 1; return; }
  // close follows closure of both output pipes, including failed-spawn cases.
  try {
    save({ status: "exited", pid: cliPid, workerPid: process.pid, supervisorPid: child.pid,
      exitCode: failure ? 1 : cliExit?.exitCode ?? code, signal: cliExit?.signal ?? signal ?? null, ...(failure ? { spawnError: failure } : {}) });
  } catch { process.exitCode = 1; return; }
  process.exitCode = failure ? 1 : code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => signalChild(signal));
}
