/*
 * Real-page performance lab gate.
 *
 * This module owns scenario definitions, round statistics, tolerances and the
 * baseline comparison. Static gzip estimates stay in check-bundle-budget.js;
 * this file never re-measures asset bytes. The browser collector in
 * measure-web-performance.js produces raw rounds; check-web-performance.js
 * wires the static gate, the lab run and this comparison together.
 *
 * Source separation is intentional:
 * - static: gzip estimates from the built package (not observed network)
 * - lab: Chrome observations from the installed service (not field CWV)
 * - field: not collected; there is no RUM pipeline in this repository
 * INP is not measured by this gate and must not be reported as a number.
 */
import { createHash } from "node:crypto";

export const BASELINE_SCHEMA = 1;
export const BASELINE_KIND = "web-performance-lab-baseline";
export const MEASUREMENT_KIND = "web-performance-lab-measurement";

export const VIEWPORT = { width: 1440, height: 900 };

export const NETWORK_PROFILES = {
  normal: {
    id: "normal",
    latencyMs: 0,
    downloadBytesPerSecond: null,
    uploadBytesPerSecond: null,
    cpuSlowdown: 1,
    emulated: false,
    note: "No CDP network or CPU emulation",
  },
  throttled: {
    id: "throttled",
    latencyMs: 150,
    downloadBytesPerSecond: 200_000,
    uploadBytesPerSecond: 93_750,
    cpuSlowdown: 4,
    emulated: true,
    note: "CDP 1.6 Mbps down / 0.75 Mbps up / +150ms latency / 4x CPU; lab condition, not a real device or carrier",
  },
};

export const CONTENT_SELECTORS = {
  workspace: ".workspace-item",
  taskboard: ".task-board-list-row, .task-board-card",
  chat: ".conversation-root:not([hidden]) .chat-message",
  login: "#login-button",
};

// Each group runs in one browser context per round so warm reloads reuse the
// same HTTP cache. Workspace/board/chat/login cover the four first-load views;
// the throttled group reuses the workspace scenario under the fixed weak
// network profile. Chat is pinned to an explicit conversation by hash.
export const LAB_GROUPS = [
  {
    id: "workspace",
    view: "workspace",
    auth: true,
    modes: ["cold", "warm"],
    network: "normal",
    settleMs: { cold: 5_000, warm: 3_000 },
    contentSelector: CONTENT_SELECTORS.workspace,
  },
  {
    id: "taskboard",
    view: "taskboard",
    auth: true,
    modes: ["cold", "warm"],
    network: "normal",
    settleMs: { cold: 5_000, warm: 3_000 },
    contentSelector: CONTENT_SELECTORS.taskboard,
  },
  {
    id: "chat",
    view: "chat",
    auth: true,
    conversation: true,
    modes: ["cold", "warm"],
    network: "normal",
    settleMs: { cold: 7_000, warm: 4_000 },
    contentSelector: CONTENT_SELECTORS.chat,
  },
  {
    id: "login",
    view: "login",
    auth: false,
    modes: ["cold", "warm"],
    network: "normal",
    settleMs: { cold: 3_000, warm: 2_000 },
    contentSelector: CONTENT_SELECTORS.login,
  },
  {
    id: "workspace-throttled",
    view: "workspace",
    auth: true,
    modes: ["cold"],
    network: "throttled",
    settleMs: { cold: 12_000 },
    contentSelector: CONTENT_SELECTORS.workspace,
  },
];

export const METRIC_DEFINITIONS = {
  fcpMs: "First Contentful Paint from Paint Timing, navigation-relative ms",
  lcpMs: "Largest Contentful Paint at the end of the fixed observation window, ms; lab observation, not field CWV",
  contentMs: "First visible view-specific content measured by requestAnimationFrame; chat requires a rendered .chat-message, not a mounted composer",
  cls: "Maximum layout-shift session window (1s gap / 5s cap), excluding shifts with recent input",
  longTaskOver50Ms: "Sum of max(0, long-task duration - 50ms) in the observation window; reported but not gated alone because one scheduler outlier can dominate it",
  longTaskCount: "Number of long tasks (>50ms); gated with longTaskMaxMs so a single outlier does not fail a run",
  longTaskMaxMs: "Longest long task in ms; gated with longTaskCount",
  domNodes: "document.getElementsByTagName('*').length at the end of the observation window",
  imageCount: "Same-origin img Resource Timing entries",
  imageBytes: "Transfer bytes for img Resource Timing entries; cached responses count as zero transfer",
  imageDecodedBytes: "Decoded body bytes for img Resource Timing entries",
  imageUnreserved: "img elements without both width and height attributes",
  apiRequests: "Same-origin /api Resource Timing entries",
  apiBytes: "Transfer bytes for same-origin /api Resource Timing entries",
  assetRequests: "Same-origin /assets and /vendor Resource Timing entries",
  assetBytes: "Transfer bytes for /assets and /vendor Resource Timing entries",
  totalBytes: "Navigation transfer plus same-origin resource transfer; later WebSocket frames are not included",
  cacheHits: "Resource entries with transferSize 0 and a non-zero body size",
  cacheHitRatio: "cacheHits divided by same-origin resource entries; a warm-cache health signal, not a browser-wide hit rate",
  chatMessages: "Mounted .chat-message elements at the end of the observation window; a data-scale/rendering check, not an INP metric",
};

// Lower is better unless marked higherIsBetter. Percent is measured against
// the committed baseline median; floor absorbs small-run noise. Medians of at
// least three rounds are compared, and every round remains in the lab report.
export const TOLERANCES = {
  normal: {
    fcpMs: { percent: 20, floor: 100 },
    lcpMs: { percent: 30, floor: 150 },
    contentMs: { percent: 20, floor: 150 },
    cls: { percent: 15, floor: 0.03 },
    longTaskCount: { percent: 100, floor: 5 },
    longTaskMaxMs: { percent: 100, floor: 100 },
    domNodes: { percent: 10, floor: 250 },
    imageBytes: { percent: 20, floor: 65_536 },
    apiBytes: { percent: 20, floor: 32_768 },
    assetBytes: { percent: 15, floor: 32_768 },
    totalBytes: { percent: 15, floor: 131_072 },
    cacheHitRatio: { absolute: 0.15, higherIsBetter: true, warmOnly: true },
  },
  throttled: {
    fcpMs: { percent: 30, floor: 300 },
    lcpMs: { percent: 30, floor: 300 },
    contentMs: { percent: 30, floor: 300 },
    cls: { percent: 20, floor: 0.05 },
    longTaskCount: { percent: 100, floor: 5 },
    longTaskMaxMs: { percent: 150, floor: 150 },
    domNodes: { percent: 10, floor: 250 },
    imageBytes: { percent: 20, floor: 65_536 },
    apiBytes: { percent: 20, floor: 32_768 },
    assetBytes: { percent: 15, floor: 32_768 },
    totalBytes: { percent: 15, floor: 131_072 },
    cacheHitRatio: { absolute: 0.15, higherIsBetter: true, warmOnly: true },
  },
};

// A warm reload should transfer only HTML/dynamic data. These overrides keep
// the absolute floors small enough to catch a broken immutable asset cache.
export const CACHE_TOLERANCE_OVERRIDES = {
  warm: {
    totalBytes: { percent: 25, floor: 65_536 },
    assetBytes: { percent: 25, floor: 16_384 },
    apiBytes: { percent: 25, floor: 32_768 },
  },
};

export const FIXTURE_TOLERANCE = {
  dataScale: { percent: 10, floor: 5 },
  pinnedConversation: { turns: "exact", chatMessages: "exact" },
};

export const NOT_MEASURED = [
  "INP (not truly measured; no interaction probe in this gate)",
  "Field/CrUX metrics (no RUM pipeline; lab values are not field percentiles)",
  "Real mobile device and carrier network (throttled profile is CDP emulation)",
  "Mac WKWebView (Web Chrome only; Mac needs separate acceptance)",
];

export function scenarioId(group, mode) {
  return `${group.id}-${mode}`;
}

export function allScenarios() {
  return LAB_GROUPS.flatMap(group => group.modes.map(mode => ({
    id: scenarioId(group, mode),
    group: group.id,
    view: group.view,
    cache: mode,
    network: group.network,
  })));
}

export function median(values) {
  const numbers = values.filter(value => typeof value === "number" && Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function normalizeMetric(key, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (key === "cls" || key === "cacheHitRatio") return Math.round(value * 10_000) / 10_000;
  if (key.endsWith("Ms")) return Math.round(value * 10) / 10;
  return Math.round(value);
}

export function computeCls(shifts) {
  const entries = (shifts ?? [])
    .filter(entry => !entry.recent && typeof entry.value === "number" && Number.isFinite(entry.value))
    .sort((left, right) => left.start - right.start);
  let maximum = 0;
  let window = null;
  for (const entry of entries) {
    if (!window || entry.start - window.last > 1_000 || entry.start - window.first > 5_000) {
      window = { first: entry.start, last: entry.start, value: 0 };
    }
    window.value += entry.value;
    window.last = entry.start;
    maximum = Math.max(maximum, window.value);
  }
  return maximum;
}

export function summarizeRounds(rounds, { serving = null } = {}) {
  const keys = new Set();
  for (const round of rounds) for (const key of Object.keys(round.metrics ?? {})) keys.add(key);
  const metrics = {};
  const ranges = {};
  const spreadPercent = {};
  for (const key of keys) {
    const values = rounds.map(round => round.metrics?.[key]).filter(value => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) continue;
    const med = median(values);
    metrics[key] = normalizeMetric(key, med);
    ranges[key] = { min: normalizeMetric(key, Math.min(...values)), max: normalizeMetric(key, Math.max(...values)) };
    spreadPercent[key] = med > 0 ? Math.round(((Math.max(...values) - Math.min(...values)) / med) * 1_000) / 10 : 0;
  }
  return {
    rounds: rounds.length,
    metrics,
    ranges,
    spreadPercent,
    serving,
    integrity: {
      pageErrors: rounds.reduce((total, round) => total + (round.errors?.length ?? 0), 0),
      failedRequests: rounds.reduce((total, round) => total + (round.failedRequests?.length ?? 0), 0),
      blockedWrites: rounds.reduce((total, round) => total + (round.blockedWrites?.length ?? 0), 0),
    },
  };
}

function toleranceFor(metric, profile, cache) {
  const base = TOLERANCES[profile]?.[metric];
  const override = CACHE_TOLERANCE_OVERRIDES[cache]?.[metric];
  if (!base) return null;
  return override ? { ...base, ...override } : base;
}

export function compareScenario(scenario, current, baseline, { profile, cache, enforceTolerances = true } = {}) {
  const failures = [];
  const warnings = [];
  const rows = [];
  const label = scenario ?? "scenario";
  if (!current || !baseline) return { failures: [`${label}: missing current or baseline summary`], warnings, rows };
  for (const [kind, count] of Object.entries(current.integrity ?? {})) {
    if (Number(count) > 0) failures.push(`${label}: ${kind}=${count} (expected 0)`);
  }
  const metrics = new Set([
    ...Object.keys(TOLERANCES[profile] ?? {}),
    ...Object.keys(CACHE_TOLERANCE_OVERRIDES[cache] ?? {}),
  ]);
  for (const metric of metrics) {
    const rule = toleranceFor(metric, profile, cache);
    if (!rule) continue;
    const base = baseline.metrics?.[metric];
    if (typeof base !== "number" || !Number.isFinite(base)) continue;
    const value = current.metrics?.[metric];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      failures.push(`${label}: ${metric} missing (baseline ${base})`);
      continue;
    }
    if (rule.warmOnly && cache !== "warm") continue;
    let allowed;
    let regression;
    let allowedLabel;
    if (typeof rule.absolute === "number") {
      allowed = rule.absolute;
      regression = rule.higherIsBetter ? base - value : value - base;
      allowedLabel = `+${allowed}`;
    } else {
      allowed = Math.max(rule.floor, base * rule.percent / 100);
      regression = rule.higherIsBetter ? base - value : value - base;
      allowedLabel = `+${rule.percent}% or +${rule.floor}`;
    }
    const pass = regression <= allowed;
    rows.push({
      scenario: label,
      metric,
      baseline: base,
      current: value,
      delta: normalizeMetric(metric, value - base),
      allowed: typeof rule.absolute === "number" ? rule.absolute : normalizeMetric(metric, allowed),
      allowedLabel,
      direction: rule.higherIsBetter ? "higher-is-better" : "lower-is-better",
      pass,
    });
    if (!pass && enforceTolerances) {
      const direction = rule.higherIsBetter ? "dropped" : "grew";
      failures.push(
        `${label}: ${metric} ${direction} from ${base} to ${value} (${normalizeMetric(metric, value - base)}); ` +
        `allowed ${allowedLabel}`,
      );
    }
  }
  for (const metric of ["fcpMs", "lcpMs", "contentMs"]) {
    const spread = current.spreadPercent?.[metric];
    if (typeof spread === "number" && spread > 75) warnings.push(`${label}: ${metric} round spread ${spread}% (>75%); treat the median cautiously`);
  }
  return { failures, warnings, rows };
}

/**
 * A lab number is only evidence when the run measured bytes this repository can
 * account for, on an engine and dataset the baseline describes. Two different
 * causes must not be conflated:
 *
 * - a new service version is exactly what the gate is for: the previous build is
 *   the reference, so the version string is a note, never a reason to skip the
 *   comparison (that would make cross-build regressions undetectable);
 * - a different browser engine, a runtime the tree does not produce, or a dataset
 *   that moved mid-run means the delta has no single cause. Those runs fail on
 *   comparability instead of reporting per-metric "regressions" that belong to
 *   something else.
 */
export function assessComparability(measurement, baseline, { fixtureFailures = [] } = {}) {
  const current = measurement?.environment ?? {};
  const base = baseline?.environment ?? {};
  const reasons = [];
  const warnings = [];
  const major = value => (typeof value === "string" ? value.split(".")[0] : null);

  if (base.serviceVersion && current.serviceVersion && current.serviceVersion !== base.serviceVersion) {
    warnings.push(`service version changed from ${base.serviceVersion} to ${current.serviceVersion}; re-record the baseline once the new numbers are reviewed.`);
  }
  if (base.browserVersion && current.browserVersion && major(current.browserVersion) !== major(base.browserVersion)) {
    reasons.push(`run is not comparable: the browser engine changed from ${base.browserVersion} to ${current.browserVersion}; timings moved as a whole and need a re-record.`);
  }
  if (base.viewport && current.viewport && current.viewport !== base.viewport) {
    reasons.push(`run is not comparable: the viewport changed from ${base.viewport} to ${current.viewport}.`);
  }
  if (current.buildIntegrity?.servedRuntimeMatchesSource === false) {
    reasons.push(
      `run is not comparable: the installed runtime (${current.buildIntegrity.servedEntry ?? "unknown entry"}) ` +
      "does not match src/web-ui/content. Build and install this tree, then re-measure; " +
      "individual metric deltas from this run are not attributable to the change under test.",
    );
  }
  if (measurement?.fixture?.stableDuringRun === false) {
    reasons.push("run is not comparable: the data scale changed while the rounds were running, so transfer metrics describe different datasets; re-run while no other session is creating or archiving data.");
  }
  reasons.push(...fixtureFailures.map(failure => `run is not comparable: ${failure}`));
  return { comparable: reasons.length === 0, reasons, warnings };
}

export function compareFixture(current, baseline) {
  const failures = [];
  const warnings = [];
  if (!current || !baseline) return { failures: ["fixture: missing current or baseline descriptor"], warnings };
  if (current.conversationHash !== baseline.conversationHash) {
    failures.push(`fixture: pinned conversation hash changed (${current.conversationHash} != ${baseline.conversationHash})`);
  }
  if (current.conversationTurns !== baseline.conversationTurns) {
    failures.push(`fixture: pinned conversation turns changed from ${baseline.conversationTurns} to ${current.conversationTurns}`);
  }
  for (const [key, baseValue] of Object.entries(baseline.dataScale ?? {})) {
    const value = current.dataScale?.[key];
    if (typeof baseValue !== "number" || typeof value !== "number") continue;
    const allowed = Math.max(FIXTURE_TOLERANCE.dataScale.floor, baseValue * FIXTURE_TOLERANCE.dataScale.percent / 100);
    if (Math.abs(value - baseValue) > allowed) {
      failures.push(`fixture: ${key} changed from ${baseValue} to ${value} (allowed ±${Math.round(allowed)})`);
    }
  }
  if (current.stableDuringRun === false) {
    warnings.push("fixture: data scale moved between the pre-run and post-run reads");
  }
  return { failures, warnings };
}

export function hashConversationId(id) {
  return "sha256:" + createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
}

export function sanitizeResourcePath(pathname) {
  return String(pathname)
    .replace(/\/[a-zA-Z0-9_-]{20,}/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

export function sanitizeErrorText(text, origin = "") {
  let value = String(text ?? "");
  if (origin) value = value.split(origin).join("<service>");
  return value
    .replace(/file:\/\/[^\s"')]+/g, "<local-file>")
    .replace(/\/Users\/[^\s"')]+/g, "<local-path>")
    .replace(/([?&](?:conversation|session|path|token|code|password|appToken)=)[^&\s"']+/gi, "$1<redacted>")
    .slice(0, 300);
}

function whitelistEnvironment(environment = {}) {
  return {
    node: environment.node ?? null,
    platform: environment.platform ?? null,
    arch: environment.arch ?? null,
    browser: environment.browser ?? null,
    browserVersion: environment.browserVersion ?? null,
    viewport: environment.viewport ?? null,
    headless: environment.headless ?? null,
    serviceVersion: environment.serviceVersion ?? null,
    packageVersion: environment.packageVersion ?? null,
    loadAverage: environment.loadAverage ?? null,
    networkProfiles: environment.networkProfiles ?? null,
    assetChecks: (environment.assetChecks ?? []).map(asset => ({
      file: asset.file,
      bytes: asset.bytes,
      sha256: asset.sha256,
      sourceMatches: asset.sourceMatches,
    })),
    buildIntegrity: environment.buildIntegrity ?? null,
  };
}

function whitelistFixture(fixture = {}) {
  return {
    conversationHash: fixture.conversationHash ?? null,
    conversationTurns: fixture.conversationTurns ?? null,
    dataScale: fixture.dataScale ?? null,
    stableDuringRun: fixture.stableDuringRun ?? null,
  };
}

function whitelistStatic(source = {}) {
  return {
    available: source.available ?? false,
    reason: source.reason ?? null,
    source: source.source ?? "scripts/check-bundle-budget.js",
    kind: "static-gzip-estimate-not-observed-network",
    firstLoadGzip: source.firstLoadGzip ?? null,
    firstLoadLimit: source.firstLoadLimit ?? null,
    allModulesGzip: source.allModulesGzip ?? null,
    buildIdentity: source.buildIdentity ?? null,
    scenarios: source.scenarios ?? null,
  };
}

export function buildBaseline({
  environment,
  fixture,
  scenarios,
  staticSource,
  status = "provisional",
}) {
  const scenarioEntries = {};
  for (const [id, summary] of Object.entries(scenarios)) {
    scenarioEntries[id] = {
      view: summary.view,
      cache: summary.cache,
      network: summary.network,
      rounds: summary.rounds,
      metrics: summary.metrics,
      ranges: summary.ranges,
      spreadPercent: summary.spreadPercent,
      integrity: summary.integrity,
      serving: summary.serving,
    };
  }
  return {
    schema: BASELINE_SCHEMA,
    kind: BASELINE_KIND,
    status,
    recordedAt: new Date().toISOString(),
    note: status === "provisional"
      ? "Provisional: re-record with --accept-baseline --final after the P1/P2 performance work and the installed build settle. Do not treat these values as a final baseline."
      : "Recorded lab baseline; re-record after an intentional build or fixture change.",
    // Numbers collected from an install that does not match the tree cannot be tied
    // to a commit; the CLI refuses to record them, and any caller without proven
    // integrity carries the caveat forward.
    provenanceCaveat: environment?.buildIntegrity?.servedRuntimeMatchesSource === true
      ? null
      : "The installed runtime did not match src/web-ui/content when these numbers were collected: they describe whatever bundle was installed at that moment, not this tree. Re-record after a build+install of the same commit before using them as a reference.",
    sources: {
      static: whitelistStatic(staticSource),
      lab: {
        available: true,
        note: "Chrome lab observation from the installed service; not field CWV. INP is not measured.",
      },
      field: {
        available: false,
        reason: "No RUM/CrUX collection in this repository; lab medians are not field percentiles.",
      },
    },
    environment: whitelistEnvironment(environment),
    fixture: whitelistFixture(fixture),
    metricDefinitions: METRIC_DEFINITIONS,
    tolerances: TOLERANCES,
    cacheToleranceOverrides: CACHE_TOLERANCE_OVERRIDES,
    fixtureTolerance: FIXTURE_TOLERANCE,
    notMeasured: NOT_MEASURED,
    scenarios: scenarioEntries,
  };
}
