import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep every npm test file, including files that mix unit and browser cases.
// One Chrome worker and two unit workers share the existing three-core runner;
// they do not add hosted runners or compete for all CPUs independently.
// Pure graph assertions run in the unit partition; its gated Chrome integration stays opt-in.
const BROWSER_UNIT_TESTS = new Set(["browser-module-splitting.test.ts"]);

export function partitionTests(directory) {
  const groups = { unit: [], browser: [], browserOptIn: [] };
  for (const name of readdirSync(directory).filter(name => name.endsWith(".test.ts")).sort()) {
    const file = resolve(directory, name);
    const source = readFileSync(file, "utf8");
    const isBrowserTest = /browser.*\.test\.ts$/.test(name)
      || /process\.env\.WAND_[A-Z0-9_]*(?:BROWSER|_QA|_TEST)(?![A-Z0-9_])/.test(source)
      || source.includes("WAND_BROWSER_E2E");
    const group = !isBrowserTest || BROWSER_UNIT_TESTS.has(name) ? "unit"
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

export async function runGroups(groups) {
  const started = performance.now();
  const results = await Promise.all([
    runGroup("unit", groups.unit, 2, false),
    runGroup("browser", groups.browser, 1, true),
  ]);
  if (groups.browserOptIn?.length) results.push(await runGroup("browser-opt-in", groups.browserOptIn, 2, false));
  console.log(`[ci-tests] wall: ${(performance.now() - started).toFixed(0)} ms`);
  return results.some(code => code !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGroups(partitionTests(resolve("tests")));
}
