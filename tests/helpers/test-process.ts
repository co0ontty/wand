import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";

interface OwnedProcess {
  cancel(): void;
  kill(): void;
  cleaned: Promise<void>;
}
const ownedProcesses = new Set<OwnedProcess>();
let shutdownSignal: "SIGINT" | "SIGTERM" | undefined;
const exitCleanup = (): void => {
  for (const child of ownedProcesses) { try { child.kill(); } catch { /* process already gone */ } }
};
const interrupt = (): void => shutdown("SIGINT");
const terminate = (): void => shutdown("SIGTERM");
function removeShutdownHooks(): void {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.off("exit", exitCleanup);
}
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (shutdownSignal) return;
  shutdownSignal = signal;
  const active = [...ownedProcesses];
  for (const child of active) child.cancel();
  void Promise.all(active.map(child => child.cleaned)).finally(() => {
    removeShutdownHooks();
    process.kill(process.pid, signal);
  });
}

/** Own one process group, retain bounded diagnostics, and await cleanup on every exit path. */
export async function runTestProcess(options: {
  args: string[];
  cwd?: string | URL;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  outputLimit?: number;
  graceMs?: number;
}): Promise<string> {
  if (shutdownSignal) throw new Error(`Test worker is stopping after ${shutdownSignal}`);
  options.signal?.throwIfAborted();
  const ownerCancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, ownerCancellation.signal]) : ownerCancellation.signal;
  const grouped = process.platform !== "win32";
  const child = spawn(process.execPath, options.args, {
    cwd: options.cwd, env: options.env, detached: grouped, stdio: ["ignore", "pipe", "pipe"],
  });
  const limit = options.outputLimit ?? 128_000;
  const grace = options.graceMs ?? 1_500;
  let output = "";
  const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-limit); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let closed = false;
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const pipesClosed = new Promise<void>(resolve => child.once("close", () => { closed = true; resolve(); }));
  let signalError: unknown;
  const signalOwned = (signal: NodeJS.Signals): void => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else if (!closed) child.kill(signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      // Darwin may report EPERM while only unreaped zombies remain in our group.
      // Preserve the error and require the group to disappear within cleanup's bound.
      if (process.platform === "darwin" && code === "EPERM") { signalError = error; return; }
      throw error;
    }
  };
  const groupAlive = (): boolean => {
    if (!child.pid) return false;
    try { process.kill(grouped ? -child.pid : child.pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (process.platform === "darwin" && code === "EPERM") { signalError = error; return true; }
      throw error;
    }
  };
  const waitForGroup = async (): Promise<void> => {
    const deadline = Date.now() + grace;
    while (groupAlive() && Date.now() < deadline) await delay(25);
  };
  let markCleaned = (): void => {};
  const owned: OwnedProcess = {
    cancel: () => ownerCancellation.abort(new Error("Test worker interrupted")),
    kill: () => signalOwned("SIGKILL"),
    cleaned: new Promise<void>(resolve => { markCleaned = resolve; }),
  };
  if (ownedProcesses.size === 0) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    process.on("exit", exitCleanup);
  }
  ownedProcesses.add(owned);
  let abort: () => void = () => {};
  let timer: NodeJS.Timeout | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Test process cancelled", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error(`Test process exceeded ${options.timeoutMs}ms`)), options.timeoutMs);
    if (signal.aborted) abort();
  });
  let failure: unknown;
  try {
    const result = await Promise.race([completed, cancelled]);
    if (result.code !== 0) throw new Error(`Test process exited with ${result.signal ?? result.code}`);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    // A child can exit while its descendants still own stdout or other resources.
    // Only the isolated group created above is signalled, never a process-name match.
    try {
      signalOwned("SIGTERM");
      await waitForGroup();
      if (groupAlive()) {
        signalOwned("SIGKILL");
        await waitForGroup();
        if (groupAlive()) throw new Error(`Owned test process group ${child.pid} did not exit after SIGKILL`, { cause: signalError });
      }
      if (!closed) {
        let closeTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([pipesClosed, new Promise<void>((_resolve, reject) => {
            closeTimer = setTimeout(() => reject(new Error("Owned test process stdio did not close after group cleanup")), grace);
          })]);
        } finally { clearTimeout(closeTimer); }
      }
    } catch (error) {
      failure = failure
        ? new Error(`${failure instanceof Error ? failure.message : String(failure)}; cleanup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        : error;
    } finally {
      child.stdout.destroy();
      child.stderr.destroy();
      ownedProcesses.delete(owned);
      markCleaned();
      if (ownedProcesses.size === 0 && !shutdownSignal) removeShutdownHooks();
    }
  }
  if (failure) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}\n${output}`, { cause: failure });
  return output;
}

export function runNodeHarness(
  t: TestContext,
  file: string,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return runTestProcess({ ...options, args: [file], cwd: new URL("../..", import.meta.url),
    env: options.env ?? process.env, signal: t.signal });
}
