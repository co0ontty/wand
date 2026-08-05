import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { runGit, runGitRaw } from "./git-utils.js";
import type { MissionDiff, MissionDiffFile } from "./mission-types.js";

const DEFAULT_MAX_PATCH_BYTES = 2 * 1024 * 1024;

function appendBounded(current: string, next: string, maxBytes: number): { value: string; truncated: boolean } {
  const available = maxBytes - Buffer.byteLength(current);
  if (available <= 0) return { value: current, truncated: true };
  if (Buffer.byteLength(next) <= available) return { value: current + next, truncated: false };
  return { value: current + Buffer.from(next).subarray(0, available).toString("utf8"), truncated: true };
}

function parseNameStatus(raw: string): MissionDiffFile[] {
  return raw.split("\n").filter(Boolean).map((line) => {
    const fields = line.split("\t");
    return { status: fields[0] || "M", path: fields[fields.length - 1] || line };
  });
}

function untrackedPatch(cwd: string, relativePath: string): string {
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "--", "/dev/null", relativePath],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: DEFAULT_MAX_PATCH_BYTES,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr?.trim() || `无法读取未跟踪文件 diff：${relativePath}`);
  }
  return result.stdout || "";
}

export function buildMissionDiff(options: {
  missionId: string;
  attemptId: string;
  cwd: string;
  baseRef: string;
  maxPatchBytes?: number;
}): MissionDiff {
  if (!existsSync(options.cwd)) throw new Error("任务 worktree 不存在，无法生成 diff。");
  runGit(["rev-parse", "--verify", `${options.baseRef}^{commit}`], options.cwd);

  const maxBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const trackedNames = parseNameStatus(runGitRaw(["diff", "--name-status", options.baseRef, "--", "."], options.cwd));
  const untracked = runGitRaw(["ls-files", "--others", "--exclude-standard", "-z"], options.cwd)
    .split("\0")
    .filter(Boolean);
  const files = [...trackedNames, ...untracked.map((file) => ({ path: file, status: "?" }))];

  let patch = runGitRaw(["diff", "--no-color", "--find-renames", options.baseRef, "--", "."], options.cwd);
  let truncated = false;
  if (Buffer.byteLength(patch) > maxBytes) {
    patch = Buffer.from(patch).subarray(0, maxBytes).toString("utf8");
    truncated = true;
  }
  if (!truncated) {
    for (const file of untracked) {
      const appended = appendBounded(patch, untrackedPatch(options.cwd, file), maxBytes);
      patch = appended.value;
      if (appended.truncated) {
        truncated = true;
        break;
      }
    }
  }

  return {
    missionId: options.missionId,
    attemptId: options.attemptId,
    baseRef: options.baseRef,
    files,
    patch,
    truncated,
  };
}
