import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { taskboardIntegrationScript } from "../src/taskboard-bridge.js";

test("taskboard integration exposes Wand Agent assignment controls", () => {
  const script = taskboardIntegrationScript();
  assert.match(script, /指派 Wand Agent/);
  assert.match(script, /claude.*codex.*opencode.*grok.*qoder.*pi/);
  assert.match(script, /name="model"/);
  assert.match(script, /name="thinkingEffort"/);
  assert.match(script, /\/taskboard\/api\/wand\/assign/);
  assert.match(script, /X-Wand-Session-Id/);
  assert.match(script, /wand-taskboard-ready/);
  assert.match(script, /wand-taskboard-ready-request/);
});

test("vendored taskboard web entry references an available bundle", () => {
  const webRoot = path.resolve("vendor/codex-taskboard/dist/web");
  const html = readFileSync(path.join(webRoot, "index.html"), "utf8");
  const scriptPath = html.match(/<script[^>]+src="\.\/(assets\/[^"]+\.js)"/)?.[1];
  const stylesheetPath = html.match(/<link[^>]+href="\.\/(assets\/[^"]+\.css)"/)?.[1];

  assert.ok(scriptPath, "taskboard index must reference its JavaScript entry");
  assert.ok(stylesheetPath, "taskboard index must reference its stylesheet entry");
  assert.ok(statSync(path.join(webRoot, scriptPath)).isFile());
  assert.ok(statSync(path.join(webRoot, stylesheetPath)).isFile());
});
