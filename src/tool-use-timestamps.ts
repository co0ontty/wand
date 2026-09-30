import type { ContentBlock, ToolUseBlock } from "./types.js";

/** Preserve first-observed tool times across streaming replacements of an assistant turn. */
export function stampNewToolUseTimes(
  content: ContentBlock[],
  previous: ContentBlock[] | undefined,
  observedAt: string,
  stampNew = true,
): ContentBlock[] {
  const previousById = new Map<string, ToolUseBlock>();
  for (const block of previous ?? []) {
    if (block.type === "tool_use") previousById.set(block.id, block);
  }
  return content.map((block): ContentBlock => {
    if (block.type !== "tool_use") return block;
    const prior = previousById.get(block.id);
    if (prior) {
      // A persisted legacy invocation has no trustworthy per-tool time. Keep it absent.
      if (!prior.occurredAt) {
        if (!block.occurredAt) return block;
        const { occurredAt: _ignored, ...withoutTime } = block;
        return withoutTime;
      }
      return block.occurredAt === prior.occurredAt
        ? block : { ...block, occurredAt: prior.occurredAt };
    }
    if (block.occurredAt || !stampNew) return block;
    return { ...block, occurredAt: observedAt };
  });
}
