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
  activity?: { kind?: string; fileKey?: string };
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
