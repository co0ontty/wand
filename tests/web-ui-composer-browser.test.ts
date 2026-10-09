import assert from "node:assert/strict";
import test from "node:test";

test("Playwright composer stops repeatedly, optimizes at its corner and keeps one aligned focus surface", {
  timeout: 180_000, skip: process.env.WAND_COMPOSER_PLAYWRIGHT !== "1",
}, async () => {
  // This opt-in test reads ~/.wand/acceptance-connection.json and uses a dedicated
  // login. Set WAND_PLAYWRIGHT_MODULE when Playwright lives outside node_modules.
  const { runComposerPlaywright } = await import("./helpers/composer-playwright.mjs");
  const result = await runComposerPlaywright();
  assert.equal(result.cases.length, 5);
  assert.equal(result.realPtyStopsWithoutReload, 2);
});
