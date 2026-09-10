import test from "node:test";
import assert from "node:assert/strict";
import { taskboardIntegrationScript } from "../src/taskboard-bridge.js";

test("taskboard integration exposes Wand Agent assignment controls", () => {
  const script = taskboardIntegrationScript();
  assert.match(script, /指派 Wand Agent/);
  assert.match(script, /claude.*codex.*opencode.*grok.*qoder.*pi/);
  assert.match(script, /name="model"/);
  assert.match(script, /name="thinkingEffort"/);
  assert.match(script, /\/taskboard\/api\/wand\/assign/);
  assert.match(script, /X-Wand-Session-Id/);
});
