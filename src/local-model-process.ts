import { spawn } from "node:child_process";
import { buildChildEnv, systemEnvValue } from "./env-utils.js";

/** Runs one fixed deployment command. Only whitelisted server code constructs executable/args. */
export function runModelSetup(executable: string, args: string[], cwd: string, signal: AbortSignal,
  progress: (phase: string, message: string) => void, timeoutMs = 20 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Model setup cancelled")); return; }
    const grouped = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, detached: grouped, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(false, {
        HTTPS_PROXY: systemEnvValue("HTTPS_PROXY"), HTTP_PROXY: systemEnvValue("HTTP_PROXY"), NO_PROXY: systemEnvValue("NO_PROXY"),
        WAND_LAYA_PYTHON_BIN: systemEnvValue("WAND_LAYA_PYTHON_BIN"),
      }) });
    let failed = false, buffer = "", kill: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      failed = true;
      const stop = (hard: boolean): void => {
        if (grouped && child.pid) { try { process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM"); } catch {} }
        else if (child.pid) {
          const cleanup = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { env: buildChildEnv(false), windowsHide: true, stdio: "ignore" });
          cleanup.on("error", () => { try { child.kill(); } catch {} });
        }
      };
      stop(false);
      kill ??= setTimeout(() => stop(true), 1_000); kill.unref();
    };
    const timer = setTimeout(terminate, timeoutMs); timer.unref();
    signal.addEventListener("abort", terminate, { once: true });
    // Compiler/Python diagnostics may contain proxy credentials or local paths: discard, never echo.
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_384) buffer = buffer.slice(-4096);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.startsWith("[wand-model] ")) continue;
        try {
          const value = JSON.parse(line.slice(13));
          if (["runtime", "verifying", "completed"].includes(value.phase) && typeof value.message === "string" && value.message.length < 240) progress(value.phase, value.message);
        } catch {}
      }
    });
    child.once("error", () => { failed = true; });
    child.once("close", (code) => {
      if (failed && grouped && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      clearTimeout(timer); if (kill) clearTimeout(kill); signal.removeEventListener("abort", terminate);
      if (failed || code !== 0) reject(new Error("Model runtime setup failed")); else resolve();
    });
  });
}
