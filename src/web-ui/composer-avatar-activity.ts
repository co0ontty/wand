import type { ConversationTurn } from "../types.js";
import { computeRunningPhase, type RunningActivityShape } from "./running-activity.js";

export type AvatarFileActivity = "idle" | "reading" | "writing";

/** Project only unfinished file tools in the current turn. Results retire their
 * own invocation, including errors; a concurrent older tool can remain active. */
export function composerAvatarActivity(activity: RunningActivityShape | undefined,
  messages: readonly ConversationTurn[] = []): AvatarFileActivity {
  if (computeRunningPhase(activity) !== "executing") return "idle";
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== "user") start--;
  const calls = new Map<string, AvatarFileActivity>();
  const completed = new Set<string>();
  for (let index = start + 1; index < messages.length; index++) {
    const message = messages[index];
    for (const block of message.content ?? []) {
      if (block.__subagent) continue;
      if (block.type === "tool_result") completed.add(block.tool_use_id);
      if (block.type !== "tool_use" || message.completedAt) continue;
      const kind = block.activity?.kind;
      if (kind === "read_file" || kind === "edit_file") {
        // Duplicate snapshots update the same invocation without reordering it.
        calls.set(block.id, kind === "read_file" ? "reading" : "writing");
      }
    }
  }
  return [...calls].reverse().find(([id]) => !completed.has(id))?.[1] ?? "idle";
}
