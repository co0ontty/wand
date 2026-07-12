import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { type ServiceScope } from "./tui/commands.js";
import { resolveGlobalWandBin } from "./npm-update-utils.js";

export interface DetachedUpdateOptions {
  installSpec: string;
  configPath: string;
  parentPid: number;
  cliArgs: string[];
  nodeLoaderArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface DetachedUpdateResult {
  started: boolean;
  scriptPath: string;
  logPath: string;
  pid?: number;
  message: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArray(values: string[]): string {
  return values.map((value) => shellQuote(value)).join(" ");
}

function resolveBashPath(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function detectInstalledServiceScopes(): ServiceScope[] {
  if (process.platform === "darwin") {
    return [
      existsSync("/Library/LaunchDaemons/com.wand.web.plist") ? "system" : null,
      existsSync(path.join(os.homedir(), "Library/LaunchAgents/com.wand.web.plist")) ? "user" : null,
    ].filter((scope): scope is ServiceScope => scope !== null);
  }
  if (process.platform === "linux") {
    return [
      existsSync("/etc/systemd/system/wand.service") ? "system" : null,
      existsSync(path.join(os.homedir(), ".config/systemd/user/wand.service")) ? "user" : null,
    ].filter((scope): scope is ServiceScope => scope !== null);
  }
  return [];
}

function readLaunchdJobPid(domain: string): number | null {
  const result = spawnSync("launchctl", ["print", `${domain}/com.wand.web`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const match = (result.stdout || "").match(/(?:^|\n)\s*pid = (\d+)\s*(?:\n|$)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function detectActiveDarwinServiceScope(pid: number): ServiceScope | null {
  if (readLaunchdJobPid("system") === pid) return "system";
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && readLaunchdJobPid(`gui/${uid}`) === pid) return "user";
  return null;
}

/** A manifest alone is not enough: only a process actually launched by its manager may rely on auto-restart. */
export function resolveManagedServiceScope(
  installedScope: ServiceScope | null,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): ServiceScope | null {
  if (platform === "darwin") {
    return env.XPC_SERVICE_NAME === "com.wand.web" ? (installedScope ?? "system") : null;
  }
  if (platform === "linux") {
    const hasSystemdPid = typeof env.SYSTEMD_EXEC_PID === "string" && env.SYSTEMD_EXEC_PID.length > 0;
    const systemdPid = Number(env.SYSTEMD_EXEC_PID || "0");
    const managed = hasSystemdPid
      ? Number.isSafeInteger(systemdPid) && systemdPid === pid
      : typeof env.INVOCATION_ID === "string" && env.INVOCATION_ID.length > 0;
    return managed ? (installedScope ?? "system") : null;
  }
  return null;
}

export function resolveManagedServiceScopeCandidates(
  installedScopes: ServiceScope[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): ServiceScope | null {
  const installedScope = installedScopes.length === 1 ? installedScopes[0] : null;
  const managedScope = resolveManagedServiceScope(installedScope, platform, env, pid);
  if (managedScope && installedScopes.length > 1) {
    throw new Error("同时检测到 system 与 user 两份 wand 服务，无法安全判断当前托管 scope；请先卸载其中一份。");
  }
  return managedScope;
}

function detectManagedServiceScope(): ServiceScope | null {
  const installedScopes = detectInstalledServiceScopes();
  if (process.platform === "darwin" && process.env.XPC_SERVICE_NAME === "com.wand.web") {
    const activeScope = detectActiveDarwinServiceScope(process.pid);
    if (activeScope && installedScopes.includes(activeScope)) return activeScope;
  }
  return resolveManagedServiceScopeCandidates(installedScopes);
}

export function isStableServiceEntrypoint(entrypoint: string | null, stableBin: string | null): boolean {
  if (!entrypoint || !stableBin) return false;
  try {
    return path.resolve(entrypoint) === path.resolve(stableBin);
  } catch {
    return false;
  }
}

function readManagedServiceEntrypoint(scope: ServiceScope): string | null {
  if (process.platform === "darwin") {
    const plist = scope === "system"
      ? "/Library/LaunchDaemons/com.wand.web.plist"
      : path.join(os.homedir(), "Library/LaunchAgents/com.wand.web.plist");
    const result = spawnSync(
      "plutil",
      ["-extract", "ProgramArguments.1", "raw", "-o", "-", plist],
      { encoding: "utf8", timeout: 5_000 },
    );
    return result.status === 0 ? (result.stdout || "").trim() || null : null;
  }
  if (process.platform === "linux") {
    const unit = scope === "system"
      ? "/etc/systemd/system/wand.service"
      : path.join(os.homedir(), ".config/systemd/user/wand.service");
    try {
      const execStart = readFileSync(unit, "utf8").split("\n").find((line) => line.startsWith("ExecStart="));
      if (!execStart) return null;
      const tokens = execStart.slice("ExecStart=".length).trim().split(/\s+/);
      return tokens[1] || null;
    } catch {
      return null;
    }
  }
  return null;
}

function managedServiceUpdatePreflight(scope: ServiceScope): { ok: true } | { ok: false; message: string } {
  const stableBin = resolveGlobalWandBin();
  const entrypoint = readManagedServiceEntrypoint(scope);
  if (isStableServiceEntrypoint(entrypoint, stableBin)) return { ok: true };
  const command = scope === "system"
    ? `sudo ${stableBin || "wand"} service:install -c <config-path>`
    : `${stableBin || "wand"} service:install --user -c <config-path>`;
  return {
    ok: false,
    message:
      `检测到 ${scope} 服务仍指向不稳定入口 (${entrypoint || "无法读取"})，已取消 Web 更新以保持服务在线。` +
      `请先在终端重注册到全局 shim：${command}`,
  };
}

export function checkManagedServiceUpdatePreflight(): { ok: true } | { ok: false; message: string } {
  try {
    const scope = detectManagedServiceScope();
    return scope ? managedServiceUpdatePreflight(scope) : { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function shouldUseSystemdRunForDetachedUpdate(serviceScope: ServiceScope | null): boolean {
  return serviceScope !== null;
}

function resolveDefaultUpdateUtilsPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const compiledPath = path.join(moduleDir, "npm-update-utils.js");
  if (existsSync(compiledPath)) return compiledPath;
  const sourcePath = path.join(moduleDir, "npm-update-utils.ts");
  return existsSync(sourcePath) ? sourcePath : compiledPath;
}

function resolveTypeScriptLoaderArgs(): string[] {
  try {
    return ["--import", import.meta.resolve("tsx")];
  } catch {
    return [];
  }
}

const DEFAULT_UPDATE_UTILS_PATH = resolveDefaultUpdateUtilsPath();

/** Exported so the safety-critical update flow can be exercised without starting a detached process. */
export function buildDetachedUpdateHelperScript(
  opts: DetachedUpdateOptions,
  logPath: string,
  serviceScope: ServiceScope | null,
  updateUtilsPath = DEFAULT_UPDATE_UTILS_PATH,
): string {
  if (!Number.isSafeInteger(opts.parentPid) || opts.parentPid <= 1) {
    throw new Error(`Invalid detached update parent pid: ${opts.parentPid}`);
  }
  const home = opts.env.HOME || os.homedir();
  const npmCache = opts.env.npm_config_cache || path.join(home, ".npm");
  const requestedTimeout = opts.timeoutMs ?? 300_000;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(30_000, Math.trunc(requestedTimeout))
    : 300_000;
  const nodeLoaderArgs = opts.nodeLoaderArgs
    ?? (updateUtilsPath.endsWith(".ts") ? resolveTypeScriptLoaderArgs() : []);

  if (updateUtilsPath.endsWith(".ts") && nodeLoaderArgs.length === 0) {
    throw new Error("本地 TypeScript 更新 helper 无法解析 tsx loader，请先运行 npm install。");
  }
  const nodeLoaderCommand = nodeLoaderArgs.length > 0 ? `${shellArray(nodeLoaderArgs)} ` : "";

  return `#!/usr/bin/env bash
set -euo pipefail
LOG=${shellQuote(logPath)}
INSTALL_SPEC=${shellQuote(opts.installSpec)}
PARENT_PID=${opts.parentPid}
exec >>"$LOG" 2>&1
echo "[wand-update] started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "[wand-update] parent pid: $PARENT_PID"
echo "[wand-update] install spec: $INSTALL_SPEC"

export PATH=${shellQuote(opts.env.PATH || process.env.PATH || "")}
export HOME=${shellQuote(home)}
export npm_config_cache=${shellQuote(npmCache)}
CONFIG_PATH=${shellQuote(opts.configPath)}
SERVICE_SCOPE=${shellQuote(serviceScope ?? "")}
TIMEOUT_MS=${timeoutMs}
NODE_BIN=${shellQuote(process.execPath)}
UPDATE_UTILS=${shellQuote(updateUtilsPath)}
WORKING_DIRECTORY=${shellQuote(opts.cwd)}
CLI_ARGS=(${shellArray(opts.cliArgs)})
GLOBAL_CLI=""
PARENT_EXITED=0

run() {
  echo "+ $*"
  "$@"
}

on_exit() {
  local status="$?"
  if [ "$status" -ne 0 ]; then
    if [ "$PARENT_EXITED" = "0" ]; then
      echo "[wand-update] failed with exit code $status; parent service was left running"
    else
      echo "[wand-update] failed with exit code $status after parent service exited"
    fi
  fi
}
trap on_exit EXIT

wait_for_parent_exit() {
  local pid="$1"
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 120 ]; then
      echo "[wand-update] parent still alive after SIGTERM timeout"
      return 1
    fi
    sleep 0.5
  done
}

resolve_global_cli() {
  local npm_root
  npm_root="$(npm root -g)"
  GLOBAL_CLI="$npm_root/@co0ontty/wand/dist/cli.js"
  if [ ! -f "$GLOBAL_CLI" ]; then
    echo "[wand-update] global CLI not found after install: $GLOBAL_CLI"
    return 1
  fi
}

main() {
  echo "[wand-update] installing while parent service stays online"
  if run "$NODE_BIN" ${nodeLoaderCommand}--input-type=module - "$UPDATE_UTILS" "$INSTALL_SPEC" "$TIMEOUT_MS" <<'WAND_INSTALL_NODE'
import { pathToFileURL } from "node:url";

const [modulePath, installSpec, timeoutValue] = process.argv.slice(2);
const timeoutMs = Number(timeoutValue);
const updateUtils = await import(pathToFileURL(modulePath).href);
const installPackageGloballyAsync = updateUtils.installPackageGloballyAsync
  ?? updateUtils.default?.installPackageGloballyAsync;
if (typeof installPackageGloballyAsync !== "function") {
  throw new Error("installPackageGloballyAsync is unavailable in " + modulePath);
}
await installPackageGloballyAsync(installSpec, timeoutMs, (line) => {
  process.stdout.write(String(line) + "\\n");
});
WAND_INSTALL_NODE
  then
    echo "[wand-update] install completed"
  else
    local install_status="$?"
    echo "[wand-update] install failed; keeping parent service online"
    return "$install_status"
  fi

  resolve_global_cli
  echo "[wand-update] initializing updated installation"
  run "$NODE_BIN" "$GLOBAL_CLI" init -c "$CONFIG_PATH"

  if kill -0 "$PARENT_PID" 2>/dev/null; then
    echo "[wand-update] sending SIGTERM to parent pid $PARENT_PID"
    run kill -TERM "$PARENT_PID"
    wait_for_parent_exit "$PARENT_PID"
  else
    echo "[wand-update] parent pid $PARENT_PID already exited"
  fi
  PARENT_EXITED=1

  if [ -n "$SERVICE_SCOPE" ]; then
    echo "[wand-update] $SERVICE_SCOPE service detected; waiting for Restart/KeepAlive relaunch"
  else
    echo "[wand-update] starting updated standalone process"
    cd "$WORKING_DIRECTORY"
    nohup "$NODE_BIN" "$GLOBAL_CLI" "$\{CLI_ARGS[@]}" >>"$LOG" 2>&1 </dev/null &
    echo "[wand-update] standalone pid: $!"
  fi
  echo "[wand-update] completed at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}

main
`;
}

function spawnDetached(
  scriptPath: string,
  _logPath: string,
  env: NodeJS.ProcessEnv,
  serviceScope: ServiceScope | null,
): { pid?: number; method: string } | null {
  const baseEnv = { ...env };
  const trySpawn = (cmd: string, args: string[], method: string): { pid?: number; method: string } | null => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        env: baseEnv,
      });
      child.once("error", (error) => {
        try {
          writeFileSync(_logPath, `[wand-update] helper spawn failed: ${error.message}\n`, { flag: "a" });
        } catch {
          /* best effort */
        }
      });
      if (!child.pid) return null;
      child.unref();
      return { pid: child.pid, method };
    } catch {
      return null;
    }
  };

  if (process.platform === "linux") {
    const unitName = `wand-update-${process.pid}-${Date.now()}`;
    const bashPath = resolveBashPath();
    const runTransient = (args: string[], method: string): { method: string } | null => {
      const res = spawnSync("systemd-run", args, {
        encoding: "utf8",
        timeout: 5000,
        env: baseEnv,
        stdio: "ignore",
      });
      return res.status === 0 ? { method } : null;
    };
    if (shouldUseSystemdRunForDetachedUpdate(serviceScope)) {
      const userService =
        runTransient(
          ["--user", `--unit=${unitName}`, "--quiet", "--collect", bashPath, scriptPath],
          "systemd-run --user",
        ) ??
        runTransient(
          ["--user", `--unit=${unitName}`, "--quiet", bashPath, scriptPath],
          "systemd-run --user",
        );
      if (userService) return userService;

      const systemService =
        runTransient(
          [`--unit=${unitName}`, "--quiet", "--collect", bashPath, scriptPath],
          "systemd-run",
        ) ??
        runTransient(
          [`--unit=${unitName}`, "--quiet", bashPath, scriptPath],
          "systemd-run",
        );
      if (systemService) return systemService;
      return null;
    }

    const setsid = spawnSync("setsid", ["--version"], { encoding: "utf8", timeout: 2000 });
    if (setsid.status === 0) {
      const result = trySpawn("setsid", [bashPath, scriptPath], "setsid");
      if (result) return result;
    }
  }

  if (process.platform === "darwin") {
    const nohupPath = existsSync("/usr/bin/nohup") ? "/usr/bin/nohup" : "nohup";
    const result = trySpawn(nohupPath, [resolveBashPath(), scriptPath], "nohup");
    if (result) return result;
  }

  return trySpawn(resolveBashPath(), [scriptPath], "bash detached");
}

export function startDetachedUpdateHelper(opts: DetachedUpdateOptions): DetachedUpdateResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-update-"));
  const scriptPath = path.join(dir, "update.sh");
  const logPath = path.join(dir, "update.log");
  let serviceScope: ServiceScope | null;
  try {
    serviceScope = detectManagedServiceScope();
  } catch (err) {
    return {
      started: false,
      scriptPath,
      logPath,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (serviceScope) {
    const preflight = managedServiceUpdatePreflight(serviceScope);
    if (!preflight.ok) {
      return {
        started: false,
        scriptPath,
        logPath,
        message: preflight.message.replace("<config-path>", opts.configPath),
      };
    }
  }
  writeFileSync(scriptPath, buildDetachedUpdateHelperScript(opts, logPath, serviceScope), {
    encoding: "utf8",
    mode: 0o700,
  });
  chmodSync(scriptPath, 0o700);
  writeFileSync(logPath, `[wand-update] helper queued at ${new Date().toISOString()}\n`, "utf8");

  const spawned = spawnDetached(scriptPath, logPath, opts.env, serviceScope);
  if (!spawned) {
    return {
      started: false,
      scriptPath,
      logPath,
      message: "无法启动独立更新 helper。",
    };
  }

  return {
    started: true,
    scriptPath,
    logPath,
    pid: spawned.pid,
    message: `独立更新 helper 已启动 (${spawned.method})。日志: ${logPath}`,
  };
}

export function canUseDetachedUpdateHelper(): boolean {
  if (process.platform === "win32") return false;
  if (existsSync("/bin/bash")) return true;
  const res = spawnSync("bash", ["--version"], { encoding: "utf8", timeout: 2000 });
  return res.status === 0;
}
