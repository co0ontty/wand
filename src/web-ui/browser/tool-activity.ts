export type ToolActivityKind = "edit_file" | "read_file" | "run_command" | "other";

export interface ToolActivityCall<T> {
  block: T;
  index: number;
}

export interface ToolActivityEntry<T> {
  kind: ToolActivityKind;
  key: string;
  calls: Array<ToolActivityCall<T>>;
}

type ActivityBlock = {
  type?: string;
  id?: string;
  activity?: { kind?: string; fileKey?: string; occurredAt?: string };
};

export const TOOL_ACTIVITY_KINDS: readonly ToolActivityKind[] =
  ["edit_file", "read_file", "run_command", "other"];

/** Counts distinct files for edit/read and distinct calls for the other groups. */
export function groupToolActivities<T extends ActivityBlock>(
  items: Array<ToolActivityCall<T>>,
): Record<ToolActivityKind, Array<ToolActivityEntry<T>>> {
  const groups: Record<ToolActivityKind, Array<ToolActivityEntry<T>>> = {
    edit_file: [], read_file: [], run_command: [], other: [],
  };
  const seenIds = new Set<string>();
  const fileEntries = new Map<string, ToolActivityEntry<T>>();
  for (const [index, call] of items.entries()) {
    const block = call.block;
    if (block?.type !== "tool_use" || !block.activity) continue;
    const id = String(block.id || "");
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    const kind: ToolActivityKind = TOOL_ACTIVITY_KINDS.includes(block.activity.kind as ToolActivityKind)
      ? block.activity.kind as ToolActivityKind : "other";
    const fileKey = (kind === "edit_file" || kind === "read_file")
      && typeof block.activity.fileKey === "string" ? block.activity.fileKey : "";
    const key = fileKey ? `${kind}:${fileKey}` : `${kind}:${id || index}`;
    let entry = fileKey ? fileEntries.get(key) : undefined;
    if (!entry) {
      entry = { kind, key, calls: [] };
      groups[kind].push(entry);
      if (fileKey) fileEntries.set(key, entry);
    }
    entry.calls.push(call);
  }
  return groups;
}

/** Return the newest real command event time; older histories may not carry one. */
export function latestCommandOccurredAt<T extends ActivityBlock>(
  entries: Array<ToolActivityEntry<T>>,
): string | null {
  let newest: string | null = null;
  let newestTime = -Infinity;
  for (const entry of entries) {
    for (const call of entry.calls) {
      const occurredAt = call.block.activity?.occurredAt;
      const time = typeof occurredAt === "string" ? Date.parse(occurredAt) : NaN;
      if (Number.isFinite(time) && time > newestTime) {
        newestTime = time;
        newest = occurredAt!;
      }
    }
  }
  return newest;
}

export function commandOccurredAt<T extends ActivityBlock>(
  entries: Array<ToolActivityEntry<T>>,
  toolId: string,
): string | null {
  for (const entry of entries) {
    for (const call of entry.calls) {
      if (call.block.id !== toolId) continue;
      const occurredAt = call.block.activity?.occurredAt;
      return typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt))
        ? occurredAt : null;
    }
  }
  return null;
}

export function formatActivityElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function currentToolActivity(
  messages: Array<{ role?: string; content?: unknown }>,
  lastUserTextIndex: number,
  toolResults: Record<string, unknown[]>,
): { latestAssistantIndex: number; pendingCommandId: string | null } {
  let latestAssistantIndex = -1;
  let pendingCommandId: string | null = null;
  for (let messageIndex = messages.length - 1;
    messageIndex >= Math.max(0, lastUserTextIndex); messageIndex--) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    if (latestAssistantIndex < 0) latestAssistantIndex = messageIndex;
    const blocks = Array.isArray(message.content) ? message.content as ActivityBlock[] : [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex];
      if (block?.type !== "tool_use" || block.activity?.kind !== "run_command" || !block.id) continue;
      if (!toolResults[block.id]?.length) {
        pendingCommandId = block.id;
        break;
      }
    }
    if (pendingCommandId) break;
  }
  return { latestAssistantIndex, pendingCommandId };
}
