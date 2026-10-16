import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Classify execution environments, not product requirements. Every file remains
// reachable through --suite=all; ordinary CI uses unit, UI matrices are explicit.
// Mixed files stay intact until their behavior tests can be split deliberately.
const BROWSER_UNIT_TESTS = new Set(["browser-module-splitting.test.ts"]);
// Manually reviewed implementation checks, not a keyword-based exclusion rule.
const UI_IMPLEMENTATION_TESTS = new Set(["mobile-composer-stop.test.ts", "web-ui-composer-seed-structure.test.ts"]);

export function partitionTests(directory) {
  const groups = { unit: [], browser: [], browserOptIn: [] };
  for (const name of readdirSync(directory).filter(name => name.endsWith(".test.ts")).sort()) {
    const file = resolve(directory, name);
    const source = readFileSync(file, "utf8");
    const isBrowserTest = /browser.*\.test\.ts$/.test(name)
      || /process\.env\.WAND_[A-Z0-9_]*(?:BROWSER|_QA|_TEST)(?![A-Z0-9_])/.test(source)
      || source.includes("WAND_BROWSER_E2E");
    const group = UI_IMPLEMENTATION_TESTS.has(name) ? "browserOptIn"
      : !isBrowserTest || BROWSER_UNIT_TESTS.has(name) ? "unit"
        : source.includes("WAND_BROWSER_E2E") ? "browser"
          : "browserOptIn";
    groups[group].push(file);
  }
  if (!groups.unit.length || (!groups.browser.length && !groups.browserOptIn.length)) throw new Error("CI unit and browser groups must be nonempty");
  return groups;
}

function runGroup(name, files, concurrency, enableBrowserGate) {
  return new Promise(resolveRun => {
    const groupStarted = performance.now();
    console.log(`[ci-tests] ${name}: ${files.length} files`);
    const env = { ...process.env };
    if (enableBrowserGate) env.WAND_BROWSER_E2E = "1";
    else delete env.WAND_BROWSER_E2E;
    const child = spawn(process.execPath, ["--test", "--test-concurrency", String(concurrency), "--import", "tsx", ...files], {
      stdio: "inherit", env,
    });
    child.once("error", () => resolveRun(1));
    child.once("exit", (code, signal) => {
      console.log(`[ci-tests] ${name}: ${signal ?? code}; ${(performance.now() - groupStarted).toFixed(0)} ms`);
      resolveRun(code === 0 ? 0 : 1);
    });
  });
}

export async function runGroups(groups, { suite = "all", run = runGroup } = {}) {
  if (!["unit", "ui", "all"].includes(suite)) throw new Error(`Unknown CI suite: ${suite}`);
  const started = performance.now();
  const work = [];
  if (suite !== "ui") work.push(run("unit", groups.unit, 2, false));
  if (suite !== "unit") work.push(run("browser", groups.browser, 1, true));
  const results = await Promise.all(work);
  if (suite !== "unit" && groups.browserOptIn?.length) results.push(await run("browser-opt-in", groups.browserOptIn, 2, false));
  console.log(`[ci-tests] wall: ${(performance.now() - started).toFixed(0)} ms`);
  return results.some(code => code !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !/^--suite=(unit|ui|all)$/.test(args[0]))) {
    throw new Error("Usage: node scripts/run-ci-tests.js [--suite=unit|ui|all]");
  }
  process.exitCode = await runGroups(partitionTests(resolve("tests")), { suite: args[0]?.slice("--suite=".length) ?? "all" });
}
