import { createHash } from "node:crypto";

import type { WandStorage } from "./storage.js";
import { provisionalTaskTitleFromDescription } from "./task-title.js";
import type { WandTask } from "./task-types.js";
import type { SessionSnapshot } from "./types.js";

/** 未命名任务的占位名；服务端新建时写入，自动命名成功后被真实标题覆盖。 */
export const UNNAMED_WORKSPACE_TASK_NAME = "未命名任务";

/** 历史客户端（Android / 桌面）留空时回传的默认名，同样视为未命名。 */
const LEGACY_UNNAMED_TASK_NAMES = new Set(["新任务"]);

export function isUnnamedWorkspaceTaskName(name: string): boolean {
  const trimmed = name.trim();
  return !trimmed || trimmed === UNNAMED_WORKSPACE_TASK_NAME || LEGACY_UNNAMED_TASK_NAMES.has(trimmed);
}

/** Legacy title helper; prompts name sessions, not their containing task. */
export function boardTitleFromSession(session: SessionSnapshot): string {
  const title = session.title?.trim();
  if (title && !isUnnamedWorkspaceTaskName(title)) return provisionalTaskTitleFromDescription(title);
  const description = session.description?.trim();
  if (description) return provisionalTaskTitleFromDescription(description);
  for (const turn of session.messages ?? []) {
    if (turn.role !== "user") continue;
    const text = turn.content.flatMap((block) => block.type === "text" ? [block.text.trim()] : [])
      .filter(Boolean).join("\n");
    if (text) return provisionalTaskTitleFromDescription(text);
  }
  return "";
}

/**
 * 自动命名只覆盖「还没有人为名字」的任务：标题来源是 auto，或仍是占位名的历史卡片
 * （老版本把未命名任务写成了 titleSource=user）。用户在面板 / 侧栏改过名后此处为 false。
 */
export function isAutoNameableBoardTask(card: Pick<WandTask, "title" | "titleSource">): boolean {
  return card.titleSource === "auto" || isUnnamedWorkspaceTaskName(card.title);
}

/** 任务下所有会话（先按看板绑定，再看侧栏 workspace_task_id 兜底），最近的排在前面。 */
function taskNamingSessions(storage: WandStorage, card: WandTask): SessionSnapshot[] {
  const sessions = new Map<string, SessionSnapshot>();
  const add = (session: SessionSnapshot | null | undefined): void => {
    if (session && !sessions.has(session.id)) sessions.set(session.id, session);
  };
  const needsMessageFallback: string[] = [];
  const addSlim = (session: SessionSnapshot | null | undefined): void => {
    if (!session) return;
    add(session);
    // boardTitleFromSession 只在 title/description 都缺时才翻 messages 找首条用户输入。
    if (!session.title?.trim() && !session.description?.trim()) needsMessageFallback.push(session.id);
  };
  if (card.workspaceTaskId) {
    for (const session of storage.listSessionsByWorkspaceTaskSlim(card.workspaceTaskId)) addSlim(session);
  }
  for (const sessionId of storage.listWandTaskSessionIds(card.id)) addSlim(storage.getSessionSlim(sessionId));
  // 只有真的需要 messages 的那几个会话才去解析大字段。
  for (const sessionId of needsMessageFallback) {
    const full = storage.getSession(sessionId);
    if (full && (full.messages?.length ?? 0) > 0) sessions.set(sessionId, full);
  }
  return [...sessions.values()].sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}

/**
 * 自动命名的输入：任务描述（去掉「项目：/ 目录：/ 分支：」同步元信息）+ 每个会话的可读摘要。
 * 为空表示这个任务还没有可命名的内容，调用方应保留占位标题。
 */
export function taskAutoNameSourceText(storage: WandStorage, card: WandTask): string {
  const parts: string[] = [];
  for (const line of card.description.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:项目|目录|分支)[：:]/.test(trimmed)) continue;
    parts.push(trimmed);
  }
  for (const session of taskNamingSessions(storage, card)) {
    const candidate = boardTitleFromSession(session);
    if (candidate) parts.push(candidate);
  }
  return parts.join("\n").slice(0, 4_000);
}

/** 输入指纹：内容没变就没必要再总结一次，也避免自动标题与模型结果来回震荡。 */
export function taskAutoNameSignature(source: string): string {
  return createHash("sha1").update(source).digest("hex");
}

