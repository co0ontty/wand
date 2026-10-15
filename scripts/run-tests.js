#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createManagedTemporary, registerTemporaryChild, testTemporaryRoot } from "../src/managed-temp.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const files = args.length ? args : readdirSync(path.join(root, "tests")).filter(name => name.endsWith(".test.ts"))
  .sort().map(name => path.join("tests", name));
const temporary = createManagedTemporary("test-run", testTemporaryRoot());
const grouped = process.platform !== "win32";
try {
  const env = { ...process.env, TMPDIR: temporary.directory, TMP: temporary.directory, TEMP: temporary.directory };
  // Nested contract checks must create a new test coordinator, not impersonate its parent worker.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", "--import", "tsx", ...files], { cwd: root, detached: grouped,
    stdio: "inherit", env });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  try { registerTemporaryChild(temporary.directory, child.pid, grouped); }
  catch (error) {
    try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
    await completed.catch(() => {}); throw error;
  }
  const forward = signal => {
    try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
  };
  const interrupt = () => forward("SIGINT"), terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    process.exitCode = await completed;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
} finally {
  // A lingering detached child/process group keeps its lease and files until it exits.
  if (!temporary.close()) console.error("[wand] Test temporary files retained while in use; abandoned files are eligible after seven days.");
}
