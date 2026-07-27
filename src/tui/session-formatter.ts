import path from "node:path";
import os from "node:os";
import { SessionSnapshot } from "../types.js";
import { durationBetween, relativeAge } from "./relative-time.js";

export interface SessionRow {
  id: string;
  glyph: string;
  runner: string;
  cwd: string;
  state: string;
  duration: string;
  /** 用于上色的语义级别（blessed tag 由调用方决定）。 */
  tone: "running" | "idle" | "exited" | "failed" | "stopped";
}

/** 把绝对路径压缩为友好显示：`~/foo` 或者长路径只保留尾部。 */
export function shortenCwd(cwd: string, max = 28): string {
  const home = os.homedir();
  let out = cwd;
  if (home && cwd.startsWith(home)) out = "~" + cwd.slice(home.length);
  if (out.length <= max) return out;
  // 保留头部 1 段 + 尾部尽可能多
  const parts = out.split(path.sep).filter(Boolean);
  if (parts.length <= 2) return "…" + out.slice(out.length - max + 1);
  const head = parts[0].startsWith("~") ? parts[0] : "";
  const tail = parts.slice(-2).join(path.sep);
  const candidate = (head ? head + path.sep : "/") + "…" + path.sep + tail;
  return candidate.length <= max ? candidate : "…" + tail.slice(tail.length - max + 1);
}

/** 从 SessionSnapshot 推导出一行表格数据。状态规则见 plan。 */
export function formatSession(snap: SessionSnapshot, now = Date.now()): SessionRow {
  const runner = (snap.runner || snap.provider || "pty").toString();
  const cwd = shortenCwd(snap.cwd);

  switch (snap.status) {
    case "running": {
      const hasTask = typeof snap.currentTaskTitle === "string" && snap.currentTaskTitle.length > 0;
      return {
        id: snap.id,
        glyph: "●",
        runner,
        cwd,
        state: hasTask ? "running" : "idle",
        duration: relativeAge(snap.startedAt, now),
        tone: hasTask ? "running" : "idle",
      };
    }
    case "failed":
      return {
        id: snap.id,
        glyph: "○",
        runner,
        cwd,
        state: "failed",
        duration: durationBetween(snap.startedAt, snap.endedAt),
        tone: "failed",
      };
    case "stopped":
      return {
        id: snap.id,
        glyph: "○",
        runner,
        cwd,
        state: "stopped",
        duration: durationBetween(snap.startedAt, snap.endedAt),
        tone: "stopped",
      };
    case "exited":
    default:
      return {
        id: snap.id,
        glyph: "○",
        runner,
        cwd,
        state: "exited",
        duration: durationBetween(snap.startedAt, snap.endedAt),
        tone: "exited",
      };
  }
}

/** 单一会话列表按开始时间倒序展示，不再按归档状态分组。 */
export function sortRows(snaps: SessionSnapshot[]): SessionSnapshot[] {
  return [...snaps].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
