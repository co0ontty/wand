// Detached supervisor owns the CLI and survives loss of the tmux I/O worker.
// IPC disconnect is an OS-backed lifetime signal, not a PID polling heuristic.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

interface Launch {
  file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  state: string; requestId: string; identity: { runId: string; incarnationId: string };
  workerPid: number;
}
let disconnected = false;
let stop: (() => void) | undefined;
process.on("disconnect", () => {
  disconnected = true;
  if (stop) stop(); else process.exit(1);
});
process.once("message", (launch: Launch) => {
  if (disconnected) return;
  const identity = JSON.parse(readFileSync(launch.state, "utf8"));
  if (identity.runId !== launch.identity.runId || identity.incarnationId !== launch.identity.incarnationId) process.exit(1);
  const child = spawn(launch.file, launch.args, {
    cwd: launch.cwd, env: launch.env, detached: true, stdio: [0, 1, 2],
  });
  let failure: string | undefined;
  let closed = false;
  let publishLostExit: (() => void) | undefined;
  let escalation: NodeJS.Timeout | undefined;
  const kill = (signal: NodeJS.Signals): void => {
    if (closed || !child.pid || child.pid <= 0) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  stop = () => {
    if (closed) { publishLostExit?.(); return; }
    kill("SIGTERM");
    escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
  };
  child.once("spawn", () => {
    if (disconnected) stop!();
    else process.send?.({ pid: child.pid });
  });
  child.once("error", (error: NodeJS.ErrnoException) => { failure = error.code ?? "ESPAWN"; });
  child.once("close", async (code, signal) => {
    // The leader can exit while descendants ignore TERM and retain our pipe FDs.
    // Retire the complete owned group before acknowledging completion.
    kill("SIGKILL");
    closed = true;
    if (escalation) clearTimeout(escalation);
    if (child.pid) {
      const deadline = Date.now() + 5000;
      while (true) {
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        }
        if (Date.now() >= deadline) {
          // Never publish exited if descendants are still observable.
          process.exit(1);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    // Persist the OS exit acknowledgement before IPC: a successful send only
    // means queued, and the worker may die before consuming it.
    writeFileSync(`${launch.state}.supervisor-exit`, JSON.stringify({ ...launch.identity,
      pid: child.pid ?? -1, exitCode: failure ? 1 : code, signal }), { mode: 0o600 });
    publishLostExit = () => {
      // Only publish termination after waitpid/close has confirmed the real child.
      const current = JSON.parse(readFileSync(launch.state, "utf8"));
      if (current.runId !== launch.identity.runId || current.incarnationId !== launch.identity.incarnationId) process.exit(1);
      const temporary = `${launch.state}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...launch.identity, requestId: launch.requestId,
        workerPid: launch.workerPid, supervisorPid: process.pid, pid: child.pid ?? -1,
        status: "exited", exitCode: 1, signal: signal ?? null, spawnError: "EWORKERLOST" }) + "\n", { mode: 0o600 });
      renameSync(temporary, launch.state);
      process.exit(1);
    };
    if (disconnected) { publishLostExit(); return; }
    process.send?.({ exitCode: failure ? 1 : code, signal, failure }, (error) => {
      if (error || disconnected) { publishLostExit!(); return; }
      process.exit(failure ? 1 : code ?? 1);
    });
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => kill(signal));
});
