import { execFileSync } from "node:child_process";

interface GitCommandError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number | null;
  code?: string;
}

export interface RunGitOptions {
  timeout?: number;
  maxBuffer?: number;
}

export function runGit(args: string[], cwd: string, opts: RunGitOptions = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
  }).trim();
}

export function runGitRaw(args: string[], cwd: string, opts: RunGitOptions = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
  });
}

export function getGitErrorMessage(error: unknown): string {
  const e = error as GitCommandError;
  if (e?.stderr && typeof e.stderr === "string") return e.stderr.trim() || e.message || "git 命令失败";
  if (e?.message) return e.message;
  return String(error);
}
