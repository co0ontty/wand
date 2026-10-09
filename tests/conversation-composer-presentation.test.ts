import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationDetail } from "../src/conversation-types.js";
import type { WandTaskAgent } from "../src/task-types.js";
import { directWorkPreference, latestDirectWork } from "../src/web-ui/react/conversations/composer-presentation.ts";

test("DM continuation follows the latest available reply, never its legacy channel or another conversation", () => {
  const detail = { kind: "dm", communicationSessionId: "legacy", messages: [
    { sessionLink: { sessionId: "old", title: "已有工作" }, sessionPreview: { status: "idle" } },
    { text: "普通消息" },
    { sessionLink: { sessionId: "latest", title: "最新工作" }, sessionPreview: { status: "running" } },
    { sessionLink: { sessionId: "missing", title: "不可用" }, sessionPreview: { status: "unavailable" } },
  ] } as unknown as ConversationDetail;
  assert.deepEqual(latestDirectWork(detail), { sessionId: "latest", title: "最新工作" });
  assert.equal(latestDirectWork({ ...detail, kind: "group" }), null);
  assert.equal(latestDirectWork({ ...detail, messages: [] }), null);
  assert.equal(latestDirectWork(null), null);
  assert.equal(detail.messages.length, 4);
});

test("execution preferences distinguish Pi CLI and Wand Agent and normalize Codex permission", () => {
  const agent = { provider: "pi", engine: "cli", mode: "default" } as WandTaskAgent;
  assert.match(directWorkPreference(agent), /首选 Pi · 标准权限/);
  assert.match(directWorkPreference({ ...agent, engine: "sdk" }), /首选 Wand Agent · 标准权限/);
  assert.match(directWorkPreference({ ...agent, provider: "codex" }), /完全访问/);
  assert.equal(directWorkPreference(undefined), "执行配置未就绪");
});
