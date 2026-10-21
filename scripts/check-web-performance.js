#!/usr/bin/env node
/*
 * Web page performance gate.
 *
 *   npm run check:web-performance
 *   npm run web-performance:accept -- --conversation <conversationId>
 *
 * Static gzip estimates are delegated to check-bundle-budget.js (never
 * re-implemented here). Lab metrics come from measure-web-performance.js
 * against the installed service. INP and field CWV are not measured.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_KIND,
  BASELINE_SCHEMA,
  LAB_GROUPS,
  allScenarios,
  buildBaseline,
  compareFixture,
  compareScenario,
  hashConversationId,
  sanitizeErrorText,
} from "./web-performance.js";
import { measureWebPerformance } from "./measure-web-performance.js";
import { compareNodeVersions, nodeBaseline, nodeMinimum } from "./node-version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASELINE = path.join(root, "scripts", "web-performance-baseline.json");
const DEFAULT_OUTPUT = path.join(root, "output", "web-performance");

function printHelp() {
  console.log(`Usage: node scripts/check-web-performance.js [options]

Options:
  --accept-baseline        Record the current run as the lab baseline.
  --final                  With --accept-baseline, mark the baseline as recorded (not provisional).
  --conversation <id>      Pin the chat fixture conversation. Required for the first baseline.
  --rounds <n>             Rounds per scenario; default 3 (minimum 3).
  --scenario <id>          Run/compare only matching scenarios (repeatable or comma-separated).
  --skip-static            Do not run scripts/check-bundle-budget.js (lab only).
  --baseline <path>        Baseline path; default scripts/web-performance-baseline.json.
  --output <dir>           Report directory; default output/web-performance.
  --help                   Show this help.

The gate reads ~/.wand/acceptance-connection.json and never prints its contents.
It only navigates/reads the installed service; page API writes are aborted.
INP is not measured and is never reported.`);
}

function parseArgs(argv) {
  const options = {
    accept: false, final: false, conversation: null, rounds: 3, scenarios: [],
    skipStatic: false, baseline: DEFAULT_BASELINE, output: DEFAULT_OUTPUT, help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
      return value;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--accept-baseline") options.accept = true;
    else if (arg === "--final") options.final = true;
    else if (arg === "--skip-static") options.skipStatic = true;
    else if (arg === "--conversation") options.conversation = take(arg);
    else if (arg.startsWith("--conversation=")) options.conversation = arg.slice("--conversation=".length);
    else if (arg === "--rounds") options.rounds = Number(take(arg));
    else if (arg.startsWith("--rounds=")) options.rounds = Number(arg.slice("--rounds=".length));
    else if (arg === "--scenario") options.scenarios.push(...take(arg).split(",").filter(Boolean));
    else if (arg.startsWith("--scenario=")) options.scenarios.push(...arg.slice("--scenario=".length).split(",").filter(Boolean));
    else if (arg === "--baseline") options.baseline = path.resolve(root, take(arg));
    else if (arg.startsWith("--baseline=")) options.baseline = path.resolve(root, arg.slice("--baseline=".length));
    else if (arg === "--output") options.output = path.resolve(root, take(arg));
    else if (arg.startsWith("--output=")) options.output = path.resolve(root, arg.slice("--output=".length));
    else throw new Error(`Unknown option: ${arg}. Use --help.`);
  }
  if (!Number.isInteger(options.rounds) || options.rounds < 3) throw new Error("--rounds must be an integer >= 3.");
  if (options.final && !options.accept) throw new Error("--final is only valid with --accept-baseline.");
  const known = new Set(allScenarios().map(scenario => scenario.id));
  for (const id of options.scenarios) if (!known.has(id)) throw new Error(`Unknown scenario: ${id}. Known: ${[...known].join(", ")}`);
  if (options.accept && options.scenarios.length > 0) throw new Error("--accept-baseline always records every scenario; remove --scenario.");
  return options;
}

function warnNodeVersion() {
  const current = process.versions.node;
  if (compareNodeVersions(current, nodeMinimum) < 0) throw new Error(`Node >= ${nodeMinimum} is required, got ${current}.`);
  if (current !== nodeBaseline) console.warn(`[web-perf] Node v${current} differs from .nvmrc v${nodeBaseline}; browser timings are unaffected, static bytes may drift.`);
}

function loadBaseline(pathname) {
  if (!existsSync(pathname)) return null;
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    throw new Error(`Baseline ${pathname} is unreadable: ${error.message}`);
  }
  if (baseline.schema !== BASELINE_SCHEMA || baseline.kind !== BASELINE_KIND) {
    throw new Error(`Baseline ${pathname} is not a schema ${BASELINE_SCHEMA} ${BASELINE_KIND} file.`);
  }
  if (!baseline.scenarios || typeof baseline.scenarios !== "object") throw new Error(`Baseline ${pathname} has no scenarios.`);
  return baseline;
}

function runStaticBudget() {
  console.log("[web-perf] static gzip budget: scripts/check-bundle-budget.js");
  const result = spawnSync(process.execPath, ["scripts/check-bundle-budget.js"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Static gzip gate failed with exit ${result.status}.`);
  }
  for (const line of (result.stdout ?? "").split("\n")) {
    if (/measured with Node|differs from the build baseline/.test(line)) console.warn(line);
  }
  const reportPath = path.join(root, "output", "web-ui-library-migration", "bundle-budget.json");
  if (!existsSync(reportPath)) throw new Error("Static gate succeeded but output/web-ui-library-migration/bundle-budget.json is missing.");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(
    `[web-perf] static: first load gzip ${report.firstLoad ?? "?"} / ${report.firstLoadLimit ?? "?"} B, ` +
    `all modules ${report.allModuleBytes ?? "?"} B, build ${report.buildIdentity?.id ?? "?"}`,
  );
  return {
    available: true,
    source: "scripts/check-bundle-budget.js",
    firstLoadGzip: report.firstLoad ?? null,
    firstLoadLimit: report.firstLoadLimit ?? null,
    allModulesGzip: report.allModuleBytes ?? null,
    buildIdentity: report.buildIdentity?.id ?? null,
    scenarios: report.loadScenarios ?? null,
  };
}

function majorVersion(value) {
  return typeof value === "string" ? value.split(".")[0] : null;
}

function validateEnvironment(measurement, baseline) {
  const failures = [];
  const warnings = [];
  const current = measurement.environment ?? {};
  const base = baseline.environment ?? {};
  const add = (message) => {
    if (baseline.status === "recorded") failures.push(message);
    else warnings.push(message);
  };
  if (base.serviceVersion && current.serviceVersion && current.serviceVersion !== base.serviceVersion) {
    add(`service version changed from ${base.serviceVersion} to ${current.serviceVersion}; re-record the baseline after an intentional install.`);
  }
  if (base.browserVersion && current.browserVersion && majorVersion(current.browserVersion) !== majorVersion(base.browserVersion)) {
    add(`browser major version changed from ${base.browserVersion} to ${current.browserVersion}; timings are not comparable.`);
  }
  if (current.buildIntegrity?.servedRuntimeMatchesSource === false) {
    add("installed runtime does not match src/web-ui/content; rebuild/install before trusting this lab run.");
  }
  return { failures, warnings };
}

function validateMeasurementForBaseline(measurement) {
  const problems = [];
  const required = ["fcpMs", "lcpMs", "contentMs", "cls", "longTaskOver50Ms", "domNodes", "imageCount", "imageBytes", "apiBytes", "assetBytes", "totalBytes"];
  for (const [id, scenario] of Object.entries(measurement.scenarios ?? {})) {
    for (const metric of required) {
      const value = scenario.metrics?.[metric];
      if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${id}: missing ${metric}`);
    }
    if (scenario.cache === "warm" && typeof scenario.metrics?.cacheHitRatio !== "number") problems.push(`${id}: missing cacheHitRatio`);
    if (scenario.view === "chat" && !(scenario.metrics?.chatMessages > 0)) problems.push(`${id}: no mounted chat messages`);
    for (const [kind, count] of Object.entries(scenario.integrity ?? {})) {
      if (Number(count) > 0) problems.push(`${id}: ${kind}=${count}`);
    }
  }
  if (problems.length) throw new Error(`Refusing to record a baseline from an incomplete or unsafe run: ${problems.join("; ")}`);
}

function validateNoInp(...scenarioMaps) {
  const failures = [];
  for (const scenarios of scenarioMaps) {
    for (const [id, scenario] of Object.entries(scenarios ?? {})) {
      for (const metric of Object.keys(scenario.metrics ?? {})) {
        if (/^inp$/i.test(metric)) failures.push(`${id}: INP must not be reported; this gate does not measure it.`);
      }
    }
  }
  return failures;
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return String(Math.round(value * 100) / 100);
}

function renderSummary(measurement, staticSource, gate) {
  const env = measurement.environment;
  const fixture = measurement.fixture;
  const lines = [
    "# Web performance lab run",
    "",
    `- Generated: ${measurement.generatedAt}`,
    `- Service: ${env.serviceVersion ?? "unknown"} (package ${env.packageVersion ?? "unknown"})`,
    `- Browser: ${env.browser} ${env.browserVersion}, headless, viewport ${env.viewport}`,
    `- Node: ${env.node}; platform ${env.platform}/${env.arch}; load average ${(env.loadAverage ?? []).join(", ")}`,
    `- Pinned chat fixture: ${fixture.conversationHash} (${fixture.conversationTurns} turns)`,
    `- Installed runtime matches src/web-ui/content: ${env.buildIntegrity?.servedRuntimeMatchesSource ?? "unknown"}; static build ${staticSource.buildIdentity ?? "unknown"}`,
    `- Data scale: sessions ${fixture.dataScale?.sessionsTotal ?? "?"}, tasks ${fixture.dataScale?.wandTasksTotal ?? "?"}, conversations ${fixture.dataScale?.conversationsTotal ?? "?"}; stable during run ${fixture.stableDuringRun}`,
    `- Sources: static ${staticSource.available ? `${staticSource.firstLoadGzip} B first load` : "skipped"}; lab Chrome; field not collected; INP not measured`,
    "",
    "Static estimates are gzip bytes from the built package, not observed network. Lab values are medians of the configured rounds; they are not field percentiles.",
    "",
    "| Scenario | Rounds | FCP ms | LCP ms | Content ms | CLS | Long sum / n / max | DOM | Total B | API B | Image B | Cache hit | Errors / failed / writes |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const scenarioOrder = new Map(allScenarios().map((scenario, index) => [scenario.id, index]));
  const scenarios = Object.entries(measurement.scenarios ?? {}).sort((left, right) => (scenarioOrder.get(left[0]) ?? 99) - (scenarioOrder.get(right[0]) ?? 99));
  for (const [id, scenario] of scenarios) {
    const metrics = scenario.metrics ?? {};
    const integrity = scenario.integrity ?? {};
    lines.push(
      `| ${id} | ${scenario.rounds} | ${formatNumber(metrics.fcpMs)} | ${formatNumber(metrics.lcpMs)} | ` +
      `${formatNumber(metrics.contentMs)} | ${formatNumber(metrics.cls)} | ` +
      `${formatNumber(metrics.longTaskOver50Ms)} / ${formatNumber(metrics.longTaskCount)} / ${formatNumber(metrics.longTaskMaxMs)} | ` +
      `${formatNumber(metrics.domNodes)} | ${formatNumber(metrics.totalBytes)} | ${formatNumber(metrics.apiBytes)} | ` +
      `${formatNumber(metrics.imageBytes)} | ${formatNumber(metrics.cacheHitRatio)} | ` +
      `${integrity.pageErrors ?? 0} / ${integrity.failedRequests ?? 0} / ${integrity.blockedWrites ?? 0} |`,
    );
  }
  lines.push("", "## Serving observed", "");
  for (const [id, scenario] of scenarios) {
    const serving = scenario.serving?.byCategory ?? {};
    const parts = Object.entries(serving).map(([category, data]) => {
      const encodings = Object.entries(data.encodings ?? {}).map(([encoding, count]) => `${encoding}:${count}`).join(",");
      const cache = Object.entries(data.cacheControls ?? {}).map(([kind, count]) => `${kind}:${count}`).join(",");
      return `${category} enc[${encodings}] cache[${cache}]`;
    });
    if (parts.length) lines.push(`- ${id}: ${parts.join("; ")}`);
  }
  lines.push("", "## Not measured", "");
  for (const item of measurement.notMeasured ?? []) lines.push(`- ${item}`);
  lines.push("", "## Gate", "");
  if (gate?.accepted) {
    lines.push(`- Baseline accepted: ${gate.status}.`);
  } else if (gate) {
    lines.push(`- Result: ${gate.passed ? "PASS" : "FAIL"}`);
    for (const failure of gate.failures ?? []) lines.push(`- FAIL: ${failure}`);
    for (const warning of gate.warnings ?? []) lines.push(`- WARN: ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderBaselineDiff(previous, next) {
  const lines = [];
  if (!previous) return ["  (first baseline)"];
  for (const [id, scenario] of Object.entries(next.scenarios ?? {})) {
    const before = previous.scenarios?.[id];
    if (!before) { lines.push(`  ${id}: new scenario`); continue; }
    const metrics = ["fcpMs", "lcpMs", "contentMs", "cls", "longTaskOver50Ms", "domNodes", "totalBytes", "imageBytes"];
    const parts = metrics
      .filter(metric => typeof scenario.metrics?.[metric] === "number" && typeof before.metrics?.[metric] === "number")
      .map(metric => `${metric} ${formatNumber(before.metrics[metric])} -> ${formatNumber(scenario.metrics[metric])}`);
    if (parts.length) lines.push(`  ${id}: ${parts.join(", ")}`);
  }
  return lines;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  warnNodeVersion();
  const previous = loadBaseline(options.baseline);
  if (!options.accept && !previous) {
    throw new Error(`No baseline at ${options.baseline}. Record one with --accept-baseline --conversation <id> --rounds 3.`);
  }
  if (!options.accept && !previous.fixture?.conversationHash) {
    throw new Error("The baseline has no pinned chat fixture; re-record it with --accept-baseline --conversation <id>.");
  }
  if (options.accept && !options.conversation && !previous?.fixture?.conversationHash) {
    throw new Error("The first baseline needs --conversation <id> for the pinned chat fixture.");
  }
  let conversationId = options.conversation;
  let conversationHash = null;
  if (conversationId) {
    const explicitHash = hashConversationId(conversationId);
    if (!options.accept && previous?.fixture?.conversationHash && explicitHash !== previous.fixture.conversationHash) {
      throw new Error(`--conversation ${explicitHash} does not match the baseline pin ${previous.fixture.conversationHash}.`);
    }
    conversationHash = options.accept ? previous?.fixture?.conversationHash ?? null : previous?.fixture?.conversationHash ?? null;
    if (options.accept && previous?.fixture?.conversationHash && explicitHash !== previous.fixture.conversationHash) {
      console.warn(`[web-perf] re-pinning chat fixture: ${previous.fixture.conversationHash} -> ${explicitHash}`);
      conversationHash = null;
    }
    // The explicit id is passed to the collector, which hashes it; never print it.
  } else {
    conversationHash = previous?.fixture?.conversationHash ?? null;
  }
  if (options.accept && options.scenarios.length) throw new Error("--accept-baseline requires all scenarios.");
  const staticSource = options.skipStatic
    ? { available: false, reason: "--skip-static" }
    : runStaticBudget();
  if (options.final && !staticSource.available) throw new Error("--final requires the static gzip budget; remove --skip-static.");
  const measurement = await measureWebPerformance({
    rounds: options.rounds,
    conversationId,
    conversationHash,
    scenarioIds: options.scenarios.length ? options.scenarios : null,
    onProgress: message => console.log(message),
  });
  measurement.environment.staticChecked = staticSource.available;
  if (measurement.environment.buildIntegrity) measurement.environment.buildIntegrity.staticBuildIdentity = staticSource.buildIdentity ?? null;
  mkdirSync(options.output, { recursive: true });
  const measurementPath = path.join(options.output, "measurements.json");
  writeFileSync(measurementPath, `${JSON.stringify(measurement, null, 2)}\n`);
  console.log(`[web-perf] fixture ${measurement.fixture.conversationHash}, turns ${measurement.fixture.conversationTurns}, sessions ${measurement.fixture.dataScale?.sessionsTotal}, tasks ${measurement.fixture.dataScale?.wandTasksTotal}`);
  if (measurement.fixture.stableDuringRun === false) console.warn("[web-perf] data scale changed during the run; the report marks it unstable.");
  if (options.accept) {
    validateMeasurementForBaseline(measurement);
    if (options.final && measurement.fixture.stableDuringRun !== true) {
      throw new Error("Refusing a final baseline while the data scale changed during the run. Re-run when the fixture is stable.");
    }
    if (options.final && measurement.environment.buildIntegrity?.servedRuntimeMatchesSource !== true) {
      throw new Error("Refusing a final baseline when the installed runtime does not match src/web-ui/content.");
    }
    const next = buildBaseline({
      environment: measurement.environment,
      fixture: measurement.fixture,
      scenarios: measurement.scenarios,
      staticSource,
      status: options.final ? "recorded" : "provisional",
    });
    writeFileSync(options.baseline, `${JSON.stringify(next, null, 2)}\n`);
    if (next.status === "provisional") {
      console.warn("[web-perf] baseline remains PROVISIONAL; re-record with --accept-baseline --final after P1/P2 settle.");
    }
    console.log(`[web-perf] baseline written: ${path.relative(root, options.baseline)} (${next.status})`);
    console.log("[web-perf] diff vs previous:");
    for (const line of renderBaselineDiff(previous, next)) console.log(line);
    const gate = { accepted: true, status: next.status, passed: true, failures: [], warnings: [] };
    writeFileSync(path.join(options.output, "summary.md"), renderSummary(measurement, staticSource, gate));
    return;
  }
  const failures = [];
  const warnings = [];
  const environmentCheck = validateEnvironment(measurement, previous);
  failures.push(...environmentCheck.failures);
  warnings.push(...environmentCheck.warnings);
  const fixtureCheck = compareFixture(measurement.fixture, previous.fixture);
  failures.push(...fixtureCheck.failures);
  warnings.push(...fixtureCheck.warnings);
  const compareIds = options.scenarios.length ? options.scenarios : Object.keys(previous.scenarios);
  if (options.scenarios.length) warnings.push("partial gate run: only the requested scenarios were compared.");
  const rows = [];
  for (const id of compareIds) {
    const baseScenario = previous.scenarios[id];
    const currentScenario = measurement.scenarios[id];
    if (!baseScenario) { failures.push(`${id}: not present in the baseline; re-record it intentionally.`); continue; }
    if (!currentScenario) { failures.push(`${id}: missing from this run.`); continue; }
    const result = compareScenario(id, currentScenario, baseScenario, {
      profile: baseScenario.network ?? "normal",
      cache: baseScenario.cache ?? "cold",
    });
    failures.push(...result.failures);
    warnings.push(...result.warnings);
    rows.push(...result.rows);
  }
  // The pinned conversation's mounted message scale is part of the fixture,
  // not a performance tolerance: a change invalidates chat comparisons.
  for (const [id, scenario] of Object.entries(previous.scenarios)) {
    if (scenario.view !== "chat") continue;
    if (options.scenarios.length && !options.scenarios.includes(id)) continue;
    const before = previous.scenarios[id]?.metrics?.chatMessages;
    const after = measurement.scenarios[id]?.metrics?.chatMessages;
    if (typeof before === "number" && typeof after === "number" && before !== after) {
      failures.push(`${id}: mounted chat messages changed from ${before} to ${after}; the pinned fixture rendering scale changed.`);
    }
  }
  failures.push(...validateNoInp(previous.scenarios, measurement.scenarios));
  if (!staticSource.available) {
    warnings.push("static gzip budget was skipped; lab metrics only.");
    if (previous.status === "recorded") failures.push("static gzip budget was skipped for a recorded baseline.");
  }
  if (previous.status === "provisional") warnings.push("baseline is provisional; re-record after P1/P2 settle before treating it as final.");
  const passed = failures.length === 0;
  const gate = { passed, failures: [...new Set(failures)], warnings: [...new Set(warnings)], rows };
  writeFileSync(path.join(options.output, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
  writeFileSync(path.join(options.output, "summary.md"), renderSummary(measurement, staticSource, gate));
  console.log("[web-perf] scenario metrics:");
  for (const [id, scenario] of Object.entries(measurement.scenarios)) {
    const m = scenario.metrics;
    console.log(
      `  ${id.padEnd(24)} FCP ${formatNumber(m.fcpMs).padStart(7)}  LCP ${formatNumber(m.lcpMs).padStart(7)}  ` +
      `content ${formatNumber(m.contentMs).padStart(7)}  CLS ${formatNumber(m.cls).padStart(6)}  ` +
      `long>50 ${formatNumber(m.longTaskOver50Ms).padStart(7)}  DOM ${formatNumber(m.domNodes).padStart(7)}  ` +
      `total ${formatNumber(m.totalBytes).padStart(9)}  cache ${formatNumber(m.cacheHitRatio)}`,
    );
  }
  if (warnings.length) {
    console.log("[web-perf] warnings:");
    for (const warning of gate.warnings) console.log(`  WARN ${warning}`);
  }
  if (!passed) {
    console.error("[web-perf] FAILED:");
    for (const failure of gate.failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[web-perf] PASS (${compareIds.length} scenarios, ${options.rounds} rounds); report: ${path.relative(root, path.join(options.output, "summary.md"))}`);
}

main().catch(error => {
  const message = sanitizeErrorText(error?.message ?? String(error));
  console.error(`[web-perf] FAILED: ${message}`);
  if (/Cannot find package 'playwright'|ERR_MODULE_NOT_FOUND/.test(String(error?.message ?? ""))) {
    console.error("[web-perf] Set WAND_PLAYWRIGHT_MODULE to your Playwright entry, e.g. /path/to/playwright/index.mjs.");
  }
  process.exitCode = 1;
});
