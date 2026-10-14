import {
  execFile,
  spawnSync,
  type ExecFileOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { buildChildEnv } from "./env-utils.js";

/** Default cap for captured stdout/stderr of one-shot CLI probes (1 MiB). */
export const RUN_COMMAND_MAX_BUFFER = 1024 * 1024;
/** Default wall-clock limit for one-shot probes; callers with longer work pass their own. */
export const RUN_COMMAND_TIMEOUT_MS = 30_000;

export interface RunCommandOptions {
  /** Accepted for call-site compatibility with spawnSync; output is always utf8. */
  encoding?: "utf8";
  /** Explicit child env wins; otherwise the shared child-env base (buildChildEnv) is used. */
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  input?: string;
  stdio?: SpawnSyncOptionsWithStringEncoding["stdio"];
}

/**
 * Single entry point for one-shot child processes (git/npm/launchctl/systemctl probes).
 * Always: argv-only (no shell), shared env base, bounded time and captured output.
 * Long-lived or detached children (PTY, structured, detached update helper) must not use it.
 */
function commandEnv(options: RunCommandOptions): NodeJS.ProcessEnv {
  const env = options.env ? { ...options.env } : buildChildEnv(options.inheritEnv !== false);
  for (const key of Object.keys(env)) {
    if (key.startsWith("WAND_DECISION_")) delete env[key];
  }
  return env;
}

export function runCommandSync(
  file: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(file, [...args], {
    encoding: "utf8",
    env: commandEnv(options),
    cwd: options.cwd,
    timeout: options.timeout ?? RUN_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? RUN_COMMAND_MAX_BUFFER,
    input: options.input,
    stdio: options.stdio,
    windowsHide: true,
    shell: false,
  });
}

export interface RunCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Async variant with the same env/timeout/output-cap contract; never rejects. */
export function runCommand(
  file: string,
  args: readonly string[],
  options: Omit<RunCommandOptions, "stdio" | "input"> = {},
): Promise<RunCommandResult> {
  const execOptions: ExecFileOptions = {
    encoding: "utf8",
    env: commandEnv(options),
    cwd: options.cwd,
    timeout: options.timeout ?? RUN_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? RUN_COMMAND_MAX_BUFFER,
    windowsHide: true,
    shell: false,
  };
  return new Promise((resolve) => {
    execFile(file, [...args], execOptions, (error, stdout, stderr) => {
      const code = error
        ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : null)
        : 0;
      resolve({
        ok: !error,
        code,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        ...(error ? { error: error as Error } : {}),
      });
    });
  });
}
