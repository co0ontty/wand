import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { partitionTests } from "../scripts/run-ci-tests.js";
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
  const all = [...groups.unit, ...groups.browser];
  assert.equal(all.length, readdirSync("tests").filter(file => file.endsWith(".test.ts")).length);
  assert.equal(new Set(all).size, all.length);
  assert.ok(groups.browser.some(file => file.endsWith("web-ui-pi-settings.test.ts")));
  const fixture = mkdtempSync(join(tmpdir(), "wand-ci-partition-"));
  try {
    writeFileSync(join(fixture, "unit.test.ts"), "test('unit', () => {});");
    writeFileSync(join(fixture, "mixed.test.ts"), "test('unit', () => {}); // WAND_BROWSER_E2E");
    writeFileSync(join(fixture, "ignored.txt"), "");
    const partition = partitionTests(fixture);
    assert.equal(partition.unit.length, 1);
    assert.equal(partition.browser.length, 1);
  } finally { rmSync(fixture, { recursive: true }); }
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
