import assert from "node:assert/strict";
import test from "node:test";

import { compactToolMessagesForTransport } from "../src/message-truncator.js";
import { stampNewToolUseTimes } from "../src/tool-use-timestamps.js";
import type { ContentBlock, ToolUseBlock } from "../src/types.js";

const first = "2026-09-30T08:00:00.000Z";
const later = "2026-09-30T08:01:00.000Z";
const use = (id: string, command: string): ToolUseBlock => ({
  type: "tool_use", id, name: "Bash", input: { command },
});

test("first observed tool time survives streaming updates, result and compact projection", () => {
  const started = stampNewToolUseTimes([use("one", "private command")], [], first);
  const updated: ContentBlock[] = [use("one", "private updated command"),
    { type: "tool_result", tool_use_id: "one", content: "private result" },
    use("two", "next command")];
  const next = stampNewToolUseTimes(updated, started, later);
  assert.equal((next[0] as ToolUseBlock).occurredAt, first);
  assert.equal((next[2] as ToolUseBlock).occurredAt, later);

  const projected = compactToolMessagesForTransport([{ role: "assistant", content: next }]);
  const firstProjected = projected[0].content[0] as ToolUseBlock;
  assert.equal(firstProjected.activity?.occurredAt, first);
  assert.deepEqual(firstProjected.input, {});
  assert.doesNotMatch(JSON.stringify(projected), /private|next command/);
});

test("legacy and replayed commands never acquire recovery time", () => {
  const legacy = [use("old", "old command")];
  const replay = stampNewToolUseTimes([use("old", "old command"), use("during-downtime", "x")],
    legacy, later, false);
  assert.equal((replay[0] as ToolUseBlock).occurredAt, undefined);
  assert.equal((replay[1] as ToolUseBlock).occurredAt, undefined);
  const resumed = stampNewToolUseTimes([...replay, use("after-reattach", "x")], replay, later);
  assert.equal((resumed[0] as ToolUseBlock).occurredAt, undefined);
  assert.equal((resumed[1] as ToolUseBlock).occurredAt, undefined);
  assert.equal((resumed[2] as ToolUseBlock).occurredAt, later);
});
