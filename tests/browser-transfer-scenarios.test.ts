import assert from "node:assert/strict";
import test from "node:test";
const { measureBrowserLoadScenarios } = await import("../scripts/browser-transfer-scenarios.js");

test("cold-shell, visible avatar, chat, terminal and all-assets scenarios count distinct actual assets", () => {
  const files = ["HTML (repeat)", "app.js (cached)", "app.css (cached)", "theme.js (cached)",
    "modules/runtime.js (eager)", "modules/chat.js (lazy)", "modules/parser.js (lazy)",
    "plush-avatar.js (lazy)", "ai-teams.js (lazy)", "/vendor/xterm/xterm.bundle.js", "/vendor/xterm/xterm.css", "/vendor/qrcode/qrcode.bundle.js"];
  const measurements = files.map((name, index) => ({ name, gzip: index + 1, raw: (index + 1) * 10 }));
  const manifest = { eager: ["modules/runtime.js"], features: { "src/web-ui/browser/chat-render.ts": "modules/chat.js" },
    dependencies: { "modules/chat.js": ["modules/runtime.js", "modules/parser.js"], "modules/parser.js": ["modules/runtime.js"] } };
  const result = measureBrowserLoadScenarios(manifest, measurements);
  assert.equal(result.kind, "static-scenarios-not-observed-network");
  assert.equal(result.staticDependenciesComplete, true);
  assert.equal(result.scenarios.shell.gzip, 15);
  assert.equal(result.scenarios.visibleAvatar.gzip, 23);
  assert.equal(result.scenarios.conversation.gzip, 28);
  assert.equal(result.scenarios.conversationWithAvatar.gzip, 36);
  assert.equal(result.scenarios.terminal.gzip, 36);
  assert.equal(result.scenarios.qrCode.gzip, 27);
  assert.equal(result.scenarios.allWebAssets.gzip, 78);
  assert.equal(result.scenarios.allWebAssets.raw, 780);
  for (const scenario of Object.values(result.scenarios) as { files: string[] }[]) assert.equal(new Set(scenario.files).size, scenario.files.length);
});
