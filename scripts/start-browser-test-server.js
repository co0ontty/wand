import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, ".tmp", "playwright-wand");
const workspace = path.join(fixtureRoot, "workspace");
const configPath = path.join(fixtureRoot, "config.json");

rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(workspace, "README.md"), "# Playwright fixture\n\nWand browser migration fixture.\n", "utf8");
writeFileSync(path.join(workspace, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");
writeFileSync(configPath, `${JSON.stringify({
  host: "127.0.0.1",
  port: 18444,
  https: false,
  shell: process.env.SHELL || "/bin/sh",
  defaultCwd: workspace,
  startupCommands: [],
  commandPresets: [],
  android: { enabled: false, apkDir: "android", currentApkFile: "" },
  macos: { enabled: false, dmgDir: "macos", currentDmgFile: "" },
}, null, 2)}\n`, "utf8");

const child = spawn(process.execPath, [path.join(root, "dist", "cli.js"), "web", "-c", configPath], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    WAND_NO_TUI: "1",
    WAND_TEST_MODE: "1",
    WAND_DISABLE_UPDATE_CHECK: "1",
  },
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGHUP"));
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 0 : (code ?? 1);
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
