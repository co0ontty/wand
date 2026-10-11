import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep every npm test file, including files that mix unit and browser cases.
// One Chrome worker and two unit workers share the existing three-core runner;
// they do not add hosted runners or compete for all CPUs independently.
export function partitionTests(directory) {
  const groups = { unit: [], browser: [] };
  for (const name of readdirSync(directory).filter(name => name.endsWith(".test.ts")).sort()) {
    const file = resolve(directory, name);
    const group = readFileSync(file, "utf8").includes("WAND_BROWSER_E2E") ? "browser" : "unit";
    groups[group].push(file);
  }
  if (!groups.unit.length || !groups.browser.length) throw new Error("CI test groups must both be nonempty");
  return groups;
}

export async function runGroups(groups) {
  const started = performance.now();
  const results = await Promise.all(Object.entries(groups).map(([name, files]) => new Promise(resolveRun => {
    const groupStarted = performance.now();
    console.log(`[ci-tests] ${name}: ${files.length} files`);
    const child = spawn(process.execPath, ["--test", "--test-concurrency", name === "browser" ? "1" : "2", "--import", "tsx", ...files], {
      stdio: "inherit", env: { ...process.env, WAND_BROWSER_E2E: "1" },
    });
    child.once("error", () => resolveRun(1));
    child.once("exit", (code, signal) => {
      console.log(`[ci-tests] ${name}: ${signal ?? code}; ${(performance.now() - groupStarted).toFixed(0)} ms`);
      resolveRun(code === 0 ? 0 : 1);
    });
  })));
  console.log(`[ci-tests] wall: ${(performance.now() - started).toFixed(0)} ms`);
  return results.some(code => code !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGroups(partitionTests(resolve("tests")));
}
