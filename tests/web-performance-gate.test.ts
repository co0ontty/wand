import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASELINE_KIND,
  BASELINE_SCHEMA,
  buildBaseline,
  compareFixture,
  compareScenario,
  computeCls,
  allScenarios,
  median,
  sanitizeErrorText,
  sanitizeResourcePath,
  summarizeRounds,
  hashConversationId,
} from "../scripts/web-performance.js";

const metrics = (overrides: Record<string, number> = {}) => ({
  fcpMs: 200, lcpMs: 500, contentMs: 400, cls: 0.02, longTaskOver5Ms: 20, longTaskOver50Ms: 100,
  longTaskCount: 2, longTaskMaxMs: 120, domNodes: 1_000, imageCount: 3, imageBytes: 50_000,
  imageDecodedBytes: 80_000, imageUnreserved: 0, apiRequests: 4, apiBytes: 40_000,
  assetRequests: 5, assetBytes: 300_000, totalBytes: 500_000, cacheHits: 0, cacheHitRatio: 0,
  chatMessages: 0, ...overrides,
});

const summary = (overrides: Record<string, unknown> = {}) => ({
  rounds: 3,
  metrics: metrics(),
  ranges: {},
  spreadPercent: { fcpMs: 5, lcpMs: 8, contentMs: 6 },
  serving: {},
  integrity: { pageErrors: 0, failedRequests: 0, blockedWrites: 0 },
  ...overrides,
});

test("scenario coverage includes every required view and cache mode", () => {
  const ids = allScenarios().map((scenario: { id: string }) => scenario.id);
  for (const required of [
    "workspace-cold", "workspace-warm",
    "taskboard-cold", "taskboard-warm",
    "chat-cold", "chat-warm",
    "login-cold", "login-warm",
    "workspace-throttled-cold",
  ]) {
    assert.ok(ids.includes(required), `missing scenario ${required}`);
  }
  assert.equal(new Set(ids).size, ids.length, "scenario ids stay unique");
});

test("median uses the middle value for odd rounds and the mean of the middle pair for even rounds", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([Number.NaN, 7]), 7);
});

test("CLS keeps the worst session window with a 1s gap and 5s cap", () => {
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  // Two shifts 500ms apart sum into one window; the third 2s later opens a new one.
  close(computeCls([
    { start: 100, value: 0.1 },
    { start: 600, value: 0.05 },
    { start: 2_600, value: 0.08 },
  ]), 0.15);
  // The 5s cap: 900ms-spaced shifts accumulate until the window edge, then restart.
  close(computeCls([0, 900, 1_800, 2_700, 3_600, 4_500, 5_400].map(start => ({ start, value: 0.01 }))), 0.06);
  // Recent-input shifts never count.
  close(computeCls([{ start: 100, value: 0.4, recent: true }, { start: 200, value: 0.02 }]), 0.02);
});

test("summarizeRounds reports medians, spread and integrity without mounting raw rounds", () => {
  const result = summarizeRounds([
    { metrics: metrics({ fcpMs: 100, lcpMs: 400 }), errors: [{ message: "boom" }], failedRequests: [], blockedWrites: [] },
    { metrics: metrics({ fcpMs: 300, lcpMs: 600 }), errors: [], failedRequests: ["a", "b"], blockedWrites: [] },
    { metrics: metrics({ fcpMs: 200, lcpMs: 500 }), errors: [], failedRequests: [], blockedWrites: ["a", "b", "c"] },
  ], { serving: { html: "gzip" } });
  assert.equal(result.rounds, 3);
  assert.equal(result.metrics.fcpMs, 200);
  assert.equal(result.metrics.lcpMs, 500);
  assert.deepEqual(result.ranges.fcpMs, { min: 100, max: 300 });
  assert.equal(result.spreadPercent.fcpMs, 100);
  assert.deepEqual(result.integrity, { pageErrors: 1, failedRequests: 2, blockedWrites: 3 });
  assert.deepEqual(result.serving, { html: "gzip" });
  assert.equal("rawRounds" in result, false);
});

test("a metric regression beyond tolerance fails the scenario; a small fluctuation passes", () => {
  const baseline = summary({ metrics: metrics({ fcpMs: 200, lcpMs: 500 }) });
  const within = summary({ metrics: metrics({ fcpMs: 300, lcpMs: 600 }) });
  assert.deepEqual(compareScenario("workspace-cold", within, baseline, { profile: "normal", cache: "cold" }).failures, []);
  const regressed = summary({ metrics: metrics({ fcpMs: 450, lcpMs: 500 }) });
  const result = compareScenario("workspace-cold", regressed, baseline, { profile: "normal", cache: "cold" });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /fcpMs grew from 200 to 450/);
  assert.equal(result.rows.find(row => row.metric === "fcpMs")?.pass, false);
});

test("the floor absorbs small runs and the relative tolerance scales with the baseline", () => {
  const baseline = summary({ metrics: metrics({ domNodes: 200, totalBytes: 2_000_000 }) });
  // domNodes: +250 floor dominates 10%; 450 -> 500 passes, 451 -> 501 fails.
  assert.deepEqual(compareScenario("board", summary({ metrics: metrics({ domNodes: 450, totalBytes: 2_000_000 }) }),
    baseline, { profile: "normal", cache: "cold" }).failures, []);
  assert.equal(compareScenario("board", summary({ metrics: metrics({ domNodes: 451, totalBytes: 2_000_000 }) }),
    baseline, { profile: "normal", cache: "cold" }).failures.length, 1);
  // totalBytes: 15% of 2MB = 300KB; +131072 floor loses, so 2.31MB fails.
  assert.equal(compareScenario("board", summary({ metrics: metrics({ domNodes: 200, totalBytes: 2_310_000 }) }),
    baseline, { profile: "normal", cache: "cold" }).failures.length, 1);
});

test("warm scenarios use the cache override and lower cache-hit ratio is a regression", () => {
  const base = summary({ metrics: metrics({ assetBytes: 500_000, cacheHitRatio: 0.9 }) });
  // 25% asset override: 625KB passes; the 15% default would already fail at 576KB.
  assert.deepEqual(compareScenario("workspace-warm", summary({ metrics: metrics({ assetBytes: 620_000, cacheHitRatio: 0.9 }) }),
    base, { profile: "normal", cache: "warm" }).failures, []);
  const drop = compareScenario("workspace-warm", summary({ metrics: metrics({ cacheHitRatio: 0.6 }) }),
    base, { profile: "normal", cache: "warm" });
  assert.equal(drop.failures.length, 1);
  assert.match(drop.failures[0], /cacheHitRatio dropped from 0\.9 to 0\.6/);
  const coldRun = compareScenario("workspace-cold", summary({ metrics: metrics({ cacheHitRatio: 0 }) }),
    base, { profile: "normal", cache: "cold" });
  assert.deepEqual(coldRun.failures, [], "cache ratio is warm-only");
});

test("page errors, failed requests and blocked writes fail integrity even with fast metrics", () => {
  const result = compareScenario("chat-cold", summary({ integrity: { pageErrors: 1, failedRequests: 0, blockedWrites: 2 } }),
    summary(), { profile: "normal", cache: "cold" });
  assert.equal(result.failures.length, 2);
  assert.match(result.failures.join("\n"), /pageErrors=1/);
  assert.match(result.failures.join("\n"), /blockedWrites=2/);
});

test("a missing metric fails instead of silently passing", () => {
  const current = summary();
  delete (current.metrics as Record<string, number>).lcpMs;
  const result = compareScenario("chat-cold", current, summary(), { profile: "normal", cache: "cold" });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /lcpMs missing/);
});

test("throttled scenarios use the wider time tolerance", () => {
  const base = summary({ metrics: metrics({ lcpMs: 5_000 }) });
  const current = summary({ metrics: metrics({ lcpMs: 6_000 }) });
  assert.deepEqual(compareScenario("workspace-throttled-cold", current, base, { profile: "throttled", cache: "cold" }).failures, []);
  assert.equal(compareScenario("workspace-throttled-cold", summary({ metrics: metrics({ lcpMs: 6_800 }) }),
    base, { profile: "throttled", cache: "cold" }).failures.length, 1);
});

test("wide round dispersion warns without hiding the regression", () => {
  const result = compareScenario("workspace-cold", summary({ spreadPercent: { fcpMs: 90, lcpMs: 10, contentMs: 10 } }),
    summary(), { profile: "normal", cache: "cold" });
  assert.deepEqual(result.failures, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /fcpMs round spread 90%/);
});

test("fixture comparison fails on a changed hash, turn count or data scale", () => {
  const baseline = { conversationHash: "sha256:aaaa", conversationTurns: 35, dataScale: { sessions: 100, tasks: 20 } };
  assert.deepEqual(compareFixture(baseline, baseline).failures, []);
  assert.match(compareFixture({ ...baseline, conversationHash: "sha256:bbbb" }, baseline).failures[0], /hash changed/);
  assert.match(compareFixture({ ...baseline, conversationTurns: 36 }, baseline).failures[0], /turns changed/);
  assert.match(compareFixture({ ...baseline, dataScale: { sessions: 130, tasks: 20 } }, baseline).failures[0], /sessions changed/);
  const unstable = compareFixture({ ...baseline, stableDuringRun: false }, baseline);
  assert.deepEqual(unstable.failures, []);
  assert.equal(unstable.warnings.length, 1);
});

test("hashes never expose the raw conversation id and paths lose identifiers", () => {
  const id = "dm_e_bfd513ebca1241988610c1efa338dd69";
  const hashed = hashConversationId(id);
  assert.match(hashed, /^sha256:[a-f0-9]{16}$/);
  assert.equal(hashed.includes(id), false);
  assert.equal(sanitizeResourcePath("/api/conversations/dm_e_bfd513ebca1241988610c1efa338dd69/messages"),
    "/api/conversations/:id/messages");
  assert.equal(sanitizeResourcePath("/assets/app.0123456789abcdef0123456789abcdef.js"),
    "/assets/app.0123456789abcdef0123456789abcdef.js", "asset hashes are stable build identifiers");
});

test("error sanitization removes origins, local paths and query secrets", () => {
  const text = sanitizeErrorText(
    "Failed https://127.0.0.1:1234/?conversation=dm_e_secret&token=abc at file:///Users/co0ontty/x.js /Users/co0ontty/project/a.ts",
    "https://127.0.0.1:1234",
  );
  assert.equal(text.includes("127.0.0.1"), false);
  assert.equal(text.includes("co0ontty"), false);
  assert.equal(text.includes("dm_e_secret"), false);
  assert.equal(text.includes("token=abc"), false);
});

test("baseline keeps only whitelisted fields and never records INP or private data", () => {
  const baseline = buildBaseline({
    environment: {
      node: "v24.21.0", browser: "chromium", browserVersion: "155",
      privateToken: "must-not-leak",
      assetChecks: [{ file: "a", bytes: 1, sha256: "x", sourceMatches: true, rawPath: "/Users/co0ontty/private" }],
    },
    fixture: { conversationHash: "sha256:aaaa", conversationTurns: 35, dataScale: { sessions: 10 }, conversationId: "dm_e_secret", rawPath: "/Users/co0ontty" },
    scenarios: {
      "workspace-cold": {
        view: "workspace", cache: "cold", network: "normal", rounds: 3,
        metrics: metrics(), ranges: {}, spreadPercent: {}, integrity: { pageErrors: 0 }, serving: {},
        resources: [{ path: "/api/sessions/dm_e_secret", query: "?token=secret" }],
        errors: ["boom /Users/co0ontty/private"],
      },
    },
    staticSource: { available: true, firstLoadGzip: 800_000, rawOutput: "/Users/co0ontty/out.json" },
  });
  const serialized = JSON.stringify(baseline);
  assert.equal(baseline.schema, BASELINE_SCHEMA);
  assert.equal(baseline.kind, BASELINE_KIND);
  assert.equal(baseline.status, "provisional");
  for (const secret of ["must-not-leak", "dm_e_secret", "co0ontty", "token=secret", "rawOutput", "conversationId"]) {
    assert.equal(serialized.includes(secret), false, `baseline leaked ${secret}`);
  }
  assert.equal(serialized.includes('"inp"'), false, "INP is never recorded as a metric");
  assert.ok(baseline.notMeasured.some(entry => entry.startsWith("INP")));
  assert.equal(baseline.sources.field.available, false);
  assert.equal(baseline.sources.static.kind, "static-gzip-estimate-not-observed-network");
  assert.equal(baseline.scenarios["workspace-cold"].resources, undefined);
  assert.equal(baseline.scenarios["workspace-cold"].errors, undefined);
});

test("final baselines state they are recorded; provisional ones warn on re-record", () => {
  const args = {
    environment: {}, fixture: {}, scenarios: {},
    staticSource: { available: true },
  };
  assert.match(buildBaseline(args).note, /Provisional/);
  assert.match(buildBaseline({ ...args, status: "recorded" }).note, /Recorded lab baseline/);
});
