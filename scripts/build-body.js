#!/usr/bin/env node
// Body of `npm run build` (wrapped by the deployment lock). Step order is the contract:
// check-node -> clean dist -> bundle assets -> generate web assets -> tsc -> copy content
// -> budget -> render binaries (warn-only) -> stamp build info -> fix permissions.
// Run through npm so node_modules/.bin (tsc) is on PATH.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args = [], { warnOnly = null } = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status === 0) return;
  if (warnOnly !== null) {
    console.error(warnOnly);
    return;
  }
  process.exit(result.status ?? 1);
}

const npmRun = (script) => run("npm", ["run", script]);
const node = (script) => run(process.execPath, [path.join(root, script)]);

/** Each entry is one step, executed strictly in order. */
const STEPS = [
  () => node("scripts/check-node-version.js"),
  () => rmSync(path.join(root, "dist"), { recursive: true, force: true }),
  () => node("scripts/bundle-tailwind.js"),
  () => node("scripts/bundle-xterm.js"),
  () => node("scripts/bundle-qrcode.js"),
  () => node("scripts/bundle-browser.js"),
  () => npmRun("generate:web-assets"),
  () => run("tsc", ["-p", "tsconfig.json"]),
  () => npmRun("build:copy-content"),
  () => node("scripts/check-bundle-budget.js"),
  () => npmRunOptional("build:render-bin",
    "[wand] WARNING: build:render-bin failed; dist/native/ has no wand-render (run: npm run build:render-bin)"),
  () => node("scripts/stamp-build-info.js"),
  () => node("scripts/fix-dist-permissions.js"),
];

function npmRunOptional(script, warning) {
  run("npm", ["run", script], { warnOnly: warning });
}

for (const step of STEPS) step();
