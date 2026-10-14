#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "com.wand.build-cache-cleanup";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MARKER = "<!-- Managed by Wand build-cache cleanup installer -->";

function xml(value) {
  return String(value).replace(/[<>&"']/g, character => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

export function makePlist({ repoRoot, nodePath, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${MARKER}
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodePath)}</string>
    <string>${xml(path.join(repoRoot, "scripts/auto-clean-build-cache.js"))}</string>
    <string>--apply</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repoRoot)}</string>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
}

function assertPlainPath(target) {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === path.dirname(current)) break;
  }
}

export function main(argv = process.argv.slice(2), options = {}) {
  if (argv.length > 1 || (argv.length && !["--install", "--uninstall", "--help"].includes(argv[0]))) {
    throw new Error("Usage: node scripts/install-build-cache-cleanup.js [--install | --uninstall | --help]");
  }
  const write = options.write ?? console.log;
  if (argv[0] === "--help") {
    write("Preview by default. --install enables user-level cleanup daily at 04:30; --uninstall disables it. No sudo, hooks, service restart or simulator deletion.");
    return { installed: false };
  }
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("LaunchAgent installation requires macOS.");
  const home = options.home ?? homedir();
  const repoRoot = path.resolve(options.repoRoot ?? ROOT);
  const uid = options.uid ?? process.getuid();
  if (uid === 0) throw new Error("Run as the login user, never with sudo.");
  const target = path.join(home, "Library/LaunchAgents", `${LABEL}.plist`);
  const logPath = path.join(home, "Library/Logs/Wand", "build-cache-cleanup.log");
  const version = readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a pinned semantic Node version in .nvmrc.");
  const nodePath = options.nodePath ?? path.join(home, ".nvm/versions/node", `v${version}`, "bin/node");
  const plist = makePlist({ repoRoot, nodePath, logPath });
  const domain = `gui/${uid}`;
  const service = `${domain}/${LABEL}`;
  const run = options.run ?? ((command, args) => execFileSync(command, args, {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  }));
  for (const p of [repoRoot, target, logPath]) assertPlainPath(p);
  if (existsSync(target)) {
    const previous = readFileSync(target, "utf8");
    if (!previous.includes(MARKER) || !previous.includes(`<key>WorkingDirectory</key><string>${xml(repoRoot)}</string>`)) {
      throw new Error("Existing LaunchAgent is not managed for this repository; refused to overwrite/remove it.");
    }
  }
  if (argv[0] === "--uninstall") {
    // bootout's not-loaded case is idempotent, but permission/other failures must surface.
    try { run("/bin/launchctl", ["print", service]); }
    catch (error) {
      if (error.status !== 113) throw error;
      if (existsSync(target)) rmSync(target);
      write(`Disabled ${LABEL}; cleanup log retained.`);
      return { installed: false, target, logPath };
    }
    if (!existsSync(target)) throw new Error("Loaded agent has no managed plist; refused to stop it.");
    run("/bin/launchctl", ["bootout", service]);
    if (existsSync(target)) rmSync(target);
    write(`Disabled ${LABEL}; cleanup log retained.`);
    return { installed: false, target, logPath };
  }
  if (argv[0] !== "--install") {
    write(plist);
    write(`Preview only. Install with --install. Target: ${target}`);
    return { installed: false, target, logPath, plist };
  }
  const actualVersion = run(nodePath, ["--version"]).trim();
  if (actualVersion !== `v${version}`) throw new Error("Pinned Node executable version does not match .nvmrc.");
  const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(path.dirname(logPath), { recursive: true });
  // Remove only our own previous registration; never touch other LaunchAgents.
  let loaded = false;
  try { run("/bin/launchctl", ["print", service]); loaded = true; }
  catch (error) { if (error.status !== 113) throw error; }
  if (loaded && previous === null) throw new Error("Loaded agent has no managed plist; refused to replace it.");
  if (loaded) run("/bin/launchctl", ["bootout", service]);
  let newLoaded = false;
  try {
    writeFileSync(target, plist, { mode: 0o600 });
    run("/usr/bin/plutil", ["-lint", target]);
    run("/bin/launchctl", ["bootstrap", domain, target]);
    newLoaded = true;
    run("/bin/launchctl", ["enable", service]);
    run("/bin/launchctl", ["print", service]);
  } catch (error) {
    if (newLoaded) run("/bin/launchctl", ["bootout", service]);
    if (previous !== null) writeFileSync(target, previous, { mode: 0o600 });
    else if (existsSync(target)) rmSync(target);
    if (loaded && previous !== null) run("/bin/launchctl", ["bootstrap", domain, target]);
    throw error;
  }
  write(`Enabled ${LABEL}: daily 04:30, seven-day inactive archive caches only.`);
  write(`LaunchAgent: ${target}\nLog: ${logPath}`);
  return { installed: true, target, logPath, plist };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "LaunchAgent installation failed.");
    process.exitCode = 1;
  }
}
