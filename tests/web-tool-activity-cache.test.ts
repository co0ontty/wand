import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeRenderHarness } from "./helpers/realtime-refresh-harness.js";

test("an older pending command row repaints when the session becomes idle after later thinking", () => {
  const h = createRealtimeRenderHarness();
  h.setMessages([
    { role: "user", content: [{ type: "text", text: "run it" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "cmd", activity: {
      kind: "run_command", occurredAt: "2026-09-30T12:00:00Z",
    } }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "checking" }] },
  ]);
  h.state.sessions[0].status = "running";
  h.state.sessions[0].structuredState.inFlight = true;
  h.chat.renderChat();
  h.flush();

  h.rendered.length = 0;
  h.state.sessions[0].status = "idle";
  h.state.sessions[0].structuredState.inFlight = false;
  h.chat.renderChat();
  h.flush();
  assert.ok(h.rendered.includes(1), "older command row must lose its running state");
  assert.deepEqual(h.errors, []);
});
