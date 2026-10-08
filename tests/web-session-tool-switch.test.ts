import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canSwitchSessionTool, sessionToolId } from "../src/web-ui/browser/session-tool-switch.js";

const blank = { id: "blank", provider: "pi", status: "idle", sessionKind: "structured", messages: [] };

test("only an unstarted interactive structured conversation can switch tools", () => {
  assert.equal(canSwitchSessionTool(blank), true);
  assert.equal(canSwitchSessionTool(blank, 1), false);
  for (const patch of [{ status: "running" }, { sessionKind: "pty" }, { archived: true },
    { messages: [{}] }, { messageTotal: 1 }, { messageCount: 1 }, { queuedMessages: ["accepted"] },
    { claudeSessionId: "resume" }, { resumedFromSessionId: "resume" }, { autoRecovered: true },
    { sessionSource: "automation" }, { automationId: "run" }, { structuredState: { inFlight: true } }]) {
    assert.equal(canSwitchSessionTool({ ...blank, ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(canSwitchSessionTool(null), false);
});

test("tool identity includes the decided engine; legacy Pi remains CLI", () => {
  assert.equal(sessionToolId(blank), "pi");
  assert.equal(sessionToolId({ ...blank, structuredState: { engine: "cli" } }), "pi");
  assert.equal(sessionToolId({ ...blank, structuredState: { engine: "core" } }), "wand-agent");
  assert.equal(sessionToolId({ ...blank, provider: "codex" }), "codex");
});

test("tool switching reuses the configuration queue and leaves drafts under composer ownership", () => {
  const engine = readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8");
  const body = engine.slice(engine.indexOf("export async function onChatToolChange"), engine.indexOf("function getPendingSessionConfig"));
  assert.match(body, /enqueueSessionConfigMutation\(session.id/);
  assert.match(body, /provider: tool.provider, engine: tool.engine/);
  assert.match(body, /sessionToolId\(data\) !== toolId/);
  assert.match(body, /state.sessions.some/);
  assert.match(body, /state.selectedId === session.id/);
  assert.doesNotMatch(body, /showToast|setDraft|clearDraft|composer\.edit|selectSession/);
  assert.match(engine, /if \(sessionToolSwitches.get\(id\)\?\.pending\) return false/);
});
