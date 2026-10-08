import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runSessionLoadPerformance } from "./helpers/session-load-performance-browser.mjs";

// Real production renderer and synthetic turns; installed-service acceptance
// is recorded separately. No real CLI/model execution or timing-only assertions.
test("long sessions defer closed tool timelines and share Ant theme variables", {
  skip: process.env.WAND_BROWSER_E2E !== "1", timeout: 90_000,
}, async () => {
  const result = await runSessionLoadPerformance();
  const dir = resolve("output/session-load-performance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "source-after.json"), JSON.stringify(result, null, 2));
  assert.deepEqual(result.exceptions, [], "real disclosure handlers have no runtime exceptions");
  assert.equal(result.cases.length, 3);
  for (const item of result.cases) {
    assert.equal(item.collapsed.calls, 200, `${item.mode}: history metadata is retained`);
    assert.equal(item.collapsed.mountedCalls, 0, `${item.mode}: closed calls have no eager React roots`);
    assert.equal(item.collapsed.mountedDetails, 0, `${item.mode}: closed details have no eager roots`);
    assert.match(item.collapsed.summary, /200/);
    assert.equal(item.expanded.expanded, "true");
    assert.equal(item.expanded.mountedCalls, 200, `${item.mode}: every call is accessible after expansion`);
    assert.equal(item.expanded.mountedDetails, 0, `${item.mode}: individual details remain lazy`);
    assert.ok(item.detailed.mountedDetails > 0, `${item.mode}: opening a call loads/presents the full result`);
    assert.equal(item.closed.expanded, "false");
    assert.equal(item.closed.calls, 200);
    assert.equal(item.reloaded.mountedCalls, item.closed.mountedCalls, "closed repaint does not create extra row roots");
    assert.equal(item.persistedOpen.expanded, "true", "same-source repaint honors explicit expansion");
    for (const snapshot of [item.expanded, item.detailed, item.closed, item.persistedOpen]) {
      assert.equal(snapshot.nestedButtons, 0, "library projection does not nest interactive controls");
      assert.deepEqual(snapshot.themeNamespaces, [item.mode === "native-reduced" ? "wand-ui-reduced" : "wand-ui"],
        "identical theme roots reuse the library CSS-variable namespace");
    }
  }
});
