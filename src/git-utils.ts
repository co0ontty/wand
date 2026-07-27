import {
  execFile,
  execFileSync,
  type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";

interface GitCommandError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number | null;
  code?: string;
}

export interface RunGitOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024;

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function gitEnvironment(opts: RunGitOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(opts.env ?? {}),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

function gitExecOptions(cwd: string, opts: RunGitOptions): ExecFileSyncOptionsWithStringEncoding {
  return {
    cwd,
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: positiveInteger(opts.timeout, DEFAULT_GIT_TIMEOUT_MS),
    maxBuffer: positiveInteger(opts.maxBuffer, DEFAULT_GIT_MAX_BUFFER),
    windowsHide: true,
    env: gitEnvironment(opts),
  };
}

function gitExecAsyncOptions(cwd: string, opts: RunGitOptions): ExecFileOptionsWithStringEncoding {
  return {
    cwd,
    encoding: "utf8",
    timeout: positiveInteger(opts.timeout, DEFAULT_GIT_TIMEOUT_MS),
    maxBuffer: positiveInteger(opts.maxBuffer, DEFAULT_GIT_MAX_BUFFER),
    windowsHide: true,
    env: gitEnvironment(opts),
    signal: opts.signal,
  };
}

export function runGit(args: string[], cwd: string, opts: RunGitOptions = {}): string {
  return execFileSync("git", args, gitExecOptions(cwd, opts)).trim();
}

export function runGitRaw(args: string[], cwd: string, opts: RunGitOptions = {}): string {
  return execFileSync("git", args, gitExecOptions(cwd, opts));
}

export async function runGitAsync(args: string[], cwd: string, opts: RunGitOptions = {}): Promise<string> {
  return (await runGitRawAsync(args, cwd, opts)).trim();
}

export function runGitRawAsync(args: string[], cwd: string, opts: RunGitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, gitExecAsyncOptions(cwd, opts), (error, stdout, stderr) => {
      if (error) {
        const commandError = error as GitCommandError;
        commandError.stdout = typeof stdout === "string" ? stdout : "";
        commandError.stderr = typeof stderr === "string" ? stderr : "";
        reject(commandError);
        return;
      }
      resolve(stdout);
    });
  });
}

export function getGitErrorMessage(error: unknown): string {
  const e = error as GitCommandError;
  if (e?.stderr && typeof e.stderr === "string") return e.stderr.trim() || e.message || "git 命令失败";
  if (e?.message) return e.message;
  return String(error);
}
