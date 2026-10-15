import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { partitionTests, runGroups } from "../scripts/run-ci-tests.js";
import { publish, readPublication } from "../scripts/publish-npm.js";

function harness(states: Array<{ exists: boolean; tagged: boolean }>, commandResults = [true]) {
  let time = 0;
  const commands: string[][] = [];
  const delays: number[] = [];
  return {
    commands, delays,
    deps: {
      read: async () => states.length > 1 ? states.shift()! : states[0]!,
      npm: async (args: string[]) => { commands.push(args); return commandResults.length > 1 ? commandResults.shift()! : commandResults[0]!; },
      sleep: async (ms: number) => { delays.push(ms); time += ms; },
      now: () => time,
      log: () => {},
    },
  };
}

test("CI partition covers every test file once, including mixed browser/unit files", () => {
  const groups = partitionTests(join(process.cwd(), "tests"));
  const classified = [...groups.unit, ...groups.browser, ...groups.browserOptIn];
  assert.equal(classified.length, readdirSync("tests").filter(file => file.endsWith(".test.ts")).length);
  assert.equal(new Set(classified).size, classified.length);
  for (const file of ["employee-avatar-sync-browser.test.ts", "employee-profile-browser.test.ts", "plush-avatar-browser.test.ts", "web-tool-timeline-browser.test.ts", "web-ui-pi-settings.test.ts"]) {
    assert.ok(groups.browser.some(candidate => candidate.endsWith(file)), `${file} remains in the pre-existing shared browser lane`);
  }
  assert.ok(groups.browserOptIn.some(file => file.endsWith("antd-foundation-browser.test.ts")), "new browser suite remains opt-in until explicitly promoted");
  assert.ok(groups.browserOptIn.some(file => file.endsWith("antd-chat-browser.test.ts")), "dedicated browser suites retain their original opt-in gate");
  for (const file of ["conversations-browser.test.ts", "sidebar-ux-browser.test.ts", "theme-switch-browser.test.ts", "web-ui-composer-browser.test.ts"]) {
    assert.ok(groups.browserOptIn.some(candidate => candidate.endsWith(file)), `${file} remains opt-in pending individual verification`);
  }
  assert.ok(groups.unit.some(file => file.endsWith("browser-module-splitting.test.ts")), "module graph assertions run in unit while gated Chrome integration stays dormant");
  assert.ok(groups.unit.some(file => file.endsWith("local-model-runtime.test.ts")), "real local-model runtime stays out of the shared browser lane");
  for (const file of ["mobile-composer-stop.test.ts", "web-ui-composer-seed-structure.test.ts"]) {
    assert.ok(groups.browserOptIn.some(candidate => candidate.endsWith(file)), `${file} is a scoped UI implementation check, not a global business gate`);
  }
  const fixture = mkdtempSync(join(tmpdir(), "wand-ci-partition-"));
  try {
    writeFileSync(join(fixture, "unit.test.ts"), "test('unit', () => {});");
    writeFileSync(join(fixture, "mixed.test.ts"), "test('unit', () => {}); // WAND_BROWSER_E2E");
    writeFileSync(join(fixture, "legacy-gate.test.ts"), "if (process.env.WAND_THEME_BROWSER !== '1') skip();");
    writeFileSync(join(fixture, "shared-browser.test.ts"), "if (process.env.WAND_BROWSER_E2E !== '1') skip();");
    writeFileSync(join(fixture, "module-split.test.ts"), "test('pure graph'); // browser-module-splitting.test.ts");
    writeFileSync(join(fixture, "standalone-browser.test.ts"), "test('browser by filename', () => {});");
    writeFileSync(join(fixture, "ignored.txt"), "");
    const partition = partitionTests(fixture);
    assert.deepEqual(partition.unit.map(file => file.split("/").at(-1)), ["module-split.test.ts", "unit.test.ts"]);
    assert.deepEqual(partition.browser.map(file => file.split("/").at(-1)), ["mixed.test.ts", "shared-browser.test.ts"]);
    assert.deepEqual(partition.browserOptIn.map(file => file.split("/").at(-1)), ["legacy-gate.test.ts", "standalone-browser.test.ts"]);
  } finally { rmSync(fixture, { recursive: true }); }
});

test("core and UI suites have explicit scope and neither hides failures in its scope", async () => {
  const groups = { unit: ["business"], browser: ["ui-flow"], browserOptIn: ["ui-specific"] };
  for (const [suite, expected] of [["unit", ["unit"]], ["ui", ["browser", "browser-opt-in"]], ["all", ["unit", "browser", "browser-opt-in"]]] as const) {
    const calls: string[] = [];
    const run = async (name: string) => { calls.push(name); return 0; };
    assert.equal(await runGroups(groups, { suite, run }), 0);
    assert.deepEqual(calls, expected);
    for (const failed of expected) assert.equal(await runGroups(groups, { suite, run: async (name: string) => name === failed ? 1 : 0 }), 1);
  }
  await assert.rejects(runGroups(groups, { suite: "unknown" }), /Unknown CI suite/);
});

test("successful npm write is not repeated while metadata propagates", async () => {
  const h = harness([{ exists: false, tagged: false }, { exists: false, tagged: false }, { exists: true, tagged: false }, { exists: true, tagged: true }]);
  assert.equal(await publish("4.89.0", "latest", h.deps), true);
  assert.deepEqual(h.commands, [["publish", "--ignore-scripts", "--access", "public", "--tag", "latest"]]);
  assert.deepEqual(h.delays, [10_000, 10_000]);
});

test("verification timeout fails the release without repeating a successful write", async () => {
  const h = harness([{ exists: false, tagged: false }]);
  assert.equal(await publish("4.89.0-beta.gabc1234", "beta", h.deps), false);
  assert.equal(h.commands.length, 1);
  assert.equal(h.delays.reduce((sum, ms) => sum + ms, 0), 360_000);
});

test("already published and ambiguous failed writes repair only the intended channel", async () => {
  for (const states of [
    [{ exists: true, tagged: false }, { exists: true, tagged: true }],
    [{ exists: false, tagged: false }, { exists: true, tagged: false }, { exists: true, tagged: true }],
  ]) {
    const h = harness(states, [false, true]);
    if (states[0].exists) h.deps.npm = async args => { h.commands.push(args); return true; };
    assert.equal(await publish("4.89.0", "latest", h.deps), true);
    assert.deepEqual(h.commands.at(-1), ["dist-tag", "add", "@co0ontty/wand@4.89.0", "latest"]);
    assert.ok(h.commands.filter(args => args[0] === "publish").length <= 1);
  }
});

test("genuine failed writes keep bounded retry and fail on tag-repair errors", async () => {
  const h = harness([{ exists: false, tagged: false }], [false]);
  assert.equal(await publish("4.89.0", "beta", h.deps), false);
  assert.equal(h.commands.length, 5);
  assert.deepEqual(h.delays, [30_000, 60_000, 90_000, 120_000]);
  const badTag = harness([{ exists: true, tagged: false }], [false]);
  assert.equal(await publish("4.89.0", "beta", badTag.deps), false);
  await assert.rejects(publish("4.89.0; touch /tmp/foo", "beta", h.deps));
});

test("registry verification checks the version and tag in one fresh anonymous response", async () => {
  let calls = 0;
  const result = await readPublication("4.89.0", "latest", async (url: URL, options: RequestInit) => {
    calls++;
    assert.equal(url.origin, "https://registry.npmjs.org");
    assert.ok(url.searchParams.get("wand-verification"));
    assert.equal(options.cache, "no-store");
    assert.equal((options.headers as Record<string, string>).Authorization, undefined);
    return new Response(JSON.stringify({ name: "@co0ontty/wand", versions: { "4.89.0": { version: "4.89.0" } }, "dist-tags": { latest: "4.89.0" } }));
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { exists: true, tagged: true });
  await assert.rejects(readPublication("4.89.0", "latest", async () => new Response("{}", { status: 503 })));
  await assert.rejects(readPublication("4.89.0", "latest", async () => new Response(JSON.stringify({ name: "another-package" }))));
});
