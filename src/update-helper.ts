import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { detectInstalledServiceScopes, readServiceEntrypoint, type ServiceScope } from "./service-manager/index.js";
import { launchdMainPid } from "./service-manager/launchd.js";
import { PACKAGE_NAME, resolveGlobalWandBin, checkGlobalUpdateAccess } from "./npm-update-utils.js";
import { runCommandSync } from "./run-command.js";
import { shellQuote, shellQuoteAll } from "./shell-quote.js";

export interface DetachedUpdateOptions {
  installSpec: string;
  configPath: string;
  parentPid: number;
  cliArgs: string[];
  nodeLoaderArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Test/development seam; production resolves the guard next to this module. */
  coreGuardPath?: string;
  healthCheckPath?: string;
  expectedVersion?: string;
}

export interface DetachedUpdateResult {
  started: boolean;
  scriptPath: string;
  logPath: string;
  pid?: number;
  message: string;
}

export interface DetachedUpdateStatus {
  phase: "queued" | "waiting-core" | "installing" | "restarting" | "verifying" | "completed" | "failed";
  message: string;
}

export function readDetachedUpdateStatus(logPath: string): DetachedUpdateStatus | null {
  try {
    const value = JSON.parse(readFileSync(`${logPath}.status.json`, "utf8"));
    if (!["queued", "waiting-core", "installing", "restarting", "verifying", "completed", "failed"].includes(value.phase)
      || typeof value.message !== "string") return null;
    return { phase: value.phase, message: value.message.slice(0, 1000) };
  } catch { return null; }
}

export function readLatestDetachedUpdate(configPath: string): { logPath: string; version: string; status: DetachedUpdateStatus | null } | null {
  try {
    const value = JSON.parse(readFileSync(path.join(path.dirname(path.resolve(configPath)), "web-update-operation.json"), "utf8"));
    if (value.configPath !== path.resolve(configPath) || typeof value.logPath !== "string"
      || path.basename(value.logPath) !== "update.log" || !/^wand-update-[A-Za-z0-9]+$/.test(path.basename(path.dirname(value.logPath)))
      || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version)) return null;
    return { logPath: value.logPath, version: value.version, status: readDetachedUpdateStatus(value.logPath) };
  } catch { return null; }
}

function resolveBashPath(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "bash";
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

export function resolveVerifiedManagedScope(
  installedScopes: ServiceScope[],
  active: Partial<Record<ServiceScope, number | null>>,
  pid: number,
): ServiceScope | null {
  const owned = installedScopes.filter(scope => active[scope] === pid);
  if (owned.length === 1) return owned[0];
  if (owned.length > 1) throw new Error("同一进程被两份服务注册领用，无法安全更新。");
  if (Object.values(active).some(value => Number.isSafeInteger(value) && Number(value) > 1)) return null;
  throw new Error("无法核实运行中的服务进程身份，已取消更新；请使用安装恢复入口。");
}

function detectManagedServiceScope(): ServiceScope | null {
  const installedScopes = detectInstalledServiceScopes();
  if (process.platform === "darwin" && process.env.XPC_SERVICE_NAME === "com.wand.web") {
    const uid = process.getuid?.();
    return resolveVerifiedManagedScope(installedScopes, {
      system: launchdMainPid("system"), user: uid === undefined ? null : launchdMainPid(`gui/${uid}`),
    }, process.pid);
  }
  if (process.platform === "linux" && (process.env.SYSTEMD_EXEC_PID || process.env.INVOCATION_ID)) {
    const active: Partial<Record<ServiceScope, number | null>> = {};
    for (const scope of installedScopes) {
      const value = runCommandSync("systemctl", [...(scope === "user" ? ["--user"] : []), "show", "wand.service", "--property=MainPID", "--value"], { timeout: 5000 });
      const pid = Number(value.stdout.trim());
      active[scope] = value.status === 0 && Number.isSafeInteger(pid) && pid > 1 ? pid : null;
    }
    return resolveVerifiedManagedScope(installedScopes, active, process.pid);
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

export function buildUpdateRecoveryCommand(configPath: string): string {
  return `WAND_CONFIG_PATH=${shellQuote(configPath)} bash <(curl -fLsS https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)`;
}

function managedServiceUpdatePreflight(scope: ServiceScope, configPath = path.join(os.homedir(), ".wand/config.json")): { ok: true } | { ok: false; message: string } {
  const stableBin = resolveGlobalWandBin();
  const entrypoint = readServiceEntrypoint(scope);
  if (isStableServiceEntrypoint(entrypoint, stableBin)) return { ok: true };
  const command = buildUpdateRecoveryCommand(configPath);
  return {
    ok: false,
    message:
      `检测到 ${scope} 服务仍指向不稳定入口 (${entrypoint || "无法读取"})，已取消 Web 更新以保持服务在线。` +
      `请在终端执行一次保留数据的恢复更新：${command}`,
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

const INSTALL_SPEC_PATTERN = new RegExp(
  `^${PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}@(latest|beta|\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`,
);

/**
 * The install spec is executed by npm, so only the Wand package with a dist-tag or a
 * concrete semver is accepted. Anything else (paths, URLs, git specs, shell syntax) is rejected.
 */
export function assertSafeInstallSpec(spec: string): string {
  if (typeof spec !== "string" || !INSTALL_SPEC_PATTERN.test(spec)) {
    throw new Error(`Unsafe detached update install spec: ${JSON.stringify(String(spec))}`);
  }
  return spec;
}

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
  assertSafeInstallSpec(opts.installSpec);
  if (serviceScope !== null && serviceScope !== "system" && serviceScope !== "user") {
    throw new Error(`Invalid service scope: ${String(serviceScope)}`);
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
  const nodeLoaderCommand = nodeLoaderArgs.length > 0 ? `${shellQuoteAll(nodeLoaderArgs)} ` : "";

  const coreGuardPath = opts.coreGuardPath ?? path.join(path.dirname(updateUtilsPath),
    updateUtilsPath.endsWith(".ts") ? "core-status-cli.ts" : "core-status-cli.js");
  const healthPath = opts.healthCheckPath ?? path.join(path.dirname(updateUtilsPath),
    updateUtilsPath.endsWith(".ts") ? "update-health.ts" : "update-health.js");
  const guardLoaderArgs = coreGuardPath.endsWith(".ts") ? resolveTypeScriptLoaderArgs() : [];
  const guardLoaderCommand = guardLoaderArgs.length > 0 ? `${shellQuoteAll(guardLoaderArgs)} ` : "";

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
CORE_GUARD=${shellQuote(coreGuardPath)}
HEALTH_CHECK=${shellQuote(healthPath)}
EXPECTED_VERSION=${shellQuote(opts.expectedVersion ?? "")}
BACKUP_RECEIPT=${shellQuote(`${logPath}.backup.json`)}
TARGET_VERSION_FILE=${shellQuote(`${logPath}.version`)}
SCRIPT_PATH=${shellQuote(`${path.dirname(logPath)}/update.sh`)}
STATUS_PATH=${shellQuote(`${logPath}.status.json`)}
GLOBAL_CLI_PATH_FILE=${shellQuote(`${logPath}.cli-path`)}
WORKING_DIRECTORY=${shellQuote(opts.cwd)}
CLI_ARGS=(${shellQuoteAll(opts.cliArgs)})
GLOBAL_CLI=""
PARENT_EXITED=0
HELPER_MODE="\${1:-}"

run() {
  echo "+ $*"
  "$@"
}

set_status() {
  "$NODE_BIN" --input-type=module - "$STATUS_PATH" "$1" "$2" <<'WAND_STATUS_NODE'
import { writeFileSync, renameSync } from "node:fs";
const [file, phase, message] = process.argv.slice(2);
writeFileSync(file + ".tmp", JSON.stringify({ phase, message }), { mode: 0o600 });
renameSync(file + ".tmp", file);
WAND_STATUS_NODE
}

on_exit() {
  local status="$?"
  if [ -z "$HELPER_MODE" ]; then rm -f "$GLOBAL_CLI_PATH_FILE" "$TARGET_VERSION_FILE" 2>/dev/null || true; fi
  if [ "$status" -ne 0 ]; then
    if [ "$("$NODE_BIN" --input-type=module -e 'import {readFileSync} from "node:fs"; try { console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).phase); } catch {}' "$STATUS_PATH")" != "failed" ]; then
      set_status failed "更新未完成，服务未确认切换到新版。请查看更新日志并重试。" || true
    fi
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

main() {
  if [ "\${1:-}" = "--stop-replacement" ]; then
    run "$NODE_BIN" --input-type=module - "$CONFIG_PATH" "$2" <<'WAND_STOP_NODE'
import { readFileSync } from "node:fs";
import path from "node:path";
const [configPath, pidValue] = process.argv.slice(2);
const pid = Number(pidValue);
const info = JSON.parse(readFileSync(path.join(path.dirname(configPath), "wand.pid"), "utf8"));
if (!Number.isSafeInteger(pid) || pid <= 1 || info.pid !== pid || path.resolve(info.configPath) !== path.resolve(configPath)) {
  throw new Error("替换进程身份已变化，取消回滚停止。");
}
process.kill(pid, "SIGTERM");
WAND_STOP_NODE
    wait_for_parent_exit "$2"
    return
  fi
  if [ "\${1:-}" = "--relaunch-old" ]; then
    if [ -z "$SERVICE_SCOPE" ] && [ -f "$GLOBAL_CLI_PATH_FILE" ]; then
      GLOBAL_CLI="$(<"$GLOBAL_CLI_PATH_FILE")"
      cd "$WORKING_DIRECTORY"
      "$NODE_BIN" "$GLOBAL_CLI" "$\{CLI_ARGS[@]}" >>"$LOG" 2>&1 </dev/null &
    fi
    return
  fi
  if [ "\${1:-}" != "--apply" ]; then
    set_status waiting-core "正在等待执行中的 Core 回合结束；新输入将排队。"
    # Keep the admission barrier open across installation and parent shutdown.
    # Import the dependency-free guard before npm can replace the running package.
    run "$NODE_BIN" ${guardLoaderCommand}--input-type=module - "$CORE_GUARD" "$CONFIG_PATH" "$TIMEOUT_MS" "$SCRIPT_PATH" "$UPDATE_UTILS" "$HEALTH_CHECK" "$BACKUP_RECEIPT" "$STATUS_PATH" "$EXPECTED_VERSION" "$TARGET_VERSION_FILE" "$PARENT_PID" <<'WAND_DRAIN_NODE'
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [guardPath, configPath, timeoutMs, scriptPath, modulePath, healthPath, receipt, statusPath, expectedVersion, targetFile, parentValue] = process.argv.slice(2);
const parentPid = Number(parentValue);
const guard = await import(pathToFileURL(guardPath).href);
const updateUtils = await import(pathToFileURL(modulePath).href);
const health = await import(pathToFileURL(healthPath).href);
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
const mark = (phase, message) => {
  writeFileSync(statusPath + ".tmp", JSON.stringify({ phase, message }), { mode: 0o600 });
  renameSync(statusPath + ".tmp", statusPath);
};
await updateUtils.withGlobalUpdateLock(async () => {
  try {
    const code = await guard.waitForCoreTurnsComplete(configPath, Number(timeoutMs) / 1000, ["/bin/bash", scriptPath, "--apply"]);
    if (code !== 0) throw new Error("安装或初始化未完成。");
    const version = expectedVersion || readFileSync(targetFile, "utf8").trim();
    mark("verifying", "正在核对目标版本的新服务实例。");
    await health.waitForUpdatedService(configPath, version, parentPid);
    if (existsSync(receipt)) updateUtils.finalizeDeferredGlobalUpdate(receipt);
    mark("completed", "目标版本的新服务已启动并响应。");
  } catch (error) {
    let restored = false;
    if (existsSync(receipt)) {
      try {
        if (!alive(parentPid)) {
          let replacement;
          try { replacement = JSON.parse(readFileSync(path.join(path.dirname(configPath), "wand.pid"), "utf8")); } catch {}
          if (!replacement || !Number.isSafeInteger(replacement.pid) || replacement.pid <= 1) {
            throw new Error("替换服务进程状态未知，保留备份以便恢复。");
          }
          if (alive(replacement.pid)) {
            const stopped = await guard.waitForCoreTurnsComplete(configPath, Number(timeoutMs) / 1000,
              ["/bin/bash", scriptPath, "--stop-replacement", String(replacement.pid)]);
            if (stopped !== 0) throw new Error("新版执行尚未安全停止，保留备份。");
          }
        }
        restored = updateUtils.finalizeDeferredGlobalUpdate(receipt, true, line => process.stdout.write(String(line) + "\\n"));
        if (restored && !alive(parentPid)) spawnSync("/bin/bash", [scriptPath, "--relaunch-old"], { stdio: "inherit" });
      } catch (rollbackError) {
        process.stderr.write("[wand-update] rollback deferred: " + rollbackError.message + "\\n");
      }
    }
    const prior = JSON.parse(readFileSync(statusPath, "utf8"));
    mark("failed", restored ? "更新未完成，已恢复原安装。请刷新后重试。"
      : prior.phase === "failed" ? prior.message : "更新未完成，备份保留；请通过安装恢复入口重试。");
    process.stderr.write("[wand-update] " + error.message + "\\n");
    process.exitCode = 1;
  }
});
WAND_DRAIN_NODE
    return
  fi
  set_status installing "正在下载、校验并安装新版本。"
  echo "[wand-update] installing while parent service stays online"
  if run "$NODE_BIN" ${nodeLoaderCommand}--input-type=module - "$UPDATE_UTILS" "$INSTALL_SPEC" "$TIMEOUT_MS" "$GLOBAL_CLI_PATH_FILE" "$STATUS_PATH" "$BACKUP_RECEIPT" "$TARGET_VERSION_FILE" <<'WAND_INSTALL_NODE'
import { realpathSync, statSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, installSpec, timeoutValue, cliPathFile, statusPath, receiptPath, targetFile] = process.argv.slice(2);
const timeoutMs = Number(timeoutValue);
const updateUtils = await import(pathToFileURL(modulePath).href);
const installPackageGloballyAsync = updateUtils.installPackageGloballyAsync
  ?? updateUtils.default?.installPackageGloballyAsync;
if (typeof installPackageGloballyAsync !== "function") {
  throw new Error("installPackageGloballyAsync is unavailable in " + modulePath);
}
let installedCli;
try {
  installedCli = await installPackageGloballyAsync(installSpec, timeoutMs, (line) => {
    process.stdout.write(String(line) + "\\n");
  }, { backupReceiptPath: receiptPath });
} catch (error) {
  const message = error instanceof Error && error.message.startsWith("新版本要求 Node.js")
    ? error.message : "安装失败，旧服务保持运行；请查看更新日志并重试。";
  writeFileSync(statusPath + ".tmp", JSON.stringify({ phase: "failed", message }), { mode: 0o600 });
  renameSync(statusPath + ".tmp", statusPath);
  throw error;
}
if (typeof installedCli !== "string" || installedCli.trim().length === 0) {
  throw new Error("installer did not return the installed Wand CLI path");
}
const resolvedCli = realpathSync(installedCli.trim());
if (!statSync(resolvedCli).isFile()) {
  throw new Error("installed Wand CLI is not a file: " + resolvedCli);
}
const manifest = JSON.parse(readFileSync(path.join(path.dirname(resolvedCli), "..", "package.json"), "utf8"));
writeFileSync(targetFile, String(manifest.version), { encoding: "utf8", mode: 0o600 });
writeFileSync(cliPathFile, resolvedCli, { encoding: "utf8", mode: 0o600 });
WAND_INSTALL_NODE
  then
    echo "[wand-update] install completed"
  else
    local install_status="$?"
    echo "[wand-update] install or CLI resolution failed; keeping parent service online"
    return "$install_status"
  fi

  if [ ! -f "$GLOBAL_CLI_PATH_FILE" ]; then
    echo "[wand-update] installer did not persist the global CLI path"
    return 1
  fi
  GLOBAL_CLI="$(<"$GLOBAL_CLI_PATH_FILE")"
  if [ ! -f "$GLOBAL_CLI" ]; then
    echo "[wand-update] global CLI not found after install: $GLOBAL_CLI"
    return 1
  fi
  echo "[wand-update] resolved global CLI: $GLOBAL_CLI"
  echo "[wand-update] initializing updated installation"
  run "$NODE_BIN" "$GLOBAL_CLI" init -c "$CONFIG_PATH"

  set_status restarting "安装完成，正在切换服务到新版。"
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
    # The helper itself already runs in a detached session/process group.  BSD
    # nohup can fail here with "can't detach from console" after the original
    # parent exits, so launch the replacement directly inside that detached
    # context and keep all stdio disconnected from the old service.
    "$NODE_BIN" "$GLOBAL_CLI" "$\{CLI_ARGS[@]}" >>"$LOG" 2>&1 </dev/null &
    echo "[wand-update] standalone pid: $!"
  fi
  set_status verifying "新版已交接，正在确认新进程与目标版本响应。"
  echo "[wand-update] completed at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}

main "$@"
`;
}

export function buildSystemdUpdateEnvironmentArgs(env: NodeJS.ProcessEnv, systemScope: boolean, uid: number, gid: number): string[] {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error("无效的更新进程身份。");
  const names = Object.keys(env).filter(name => /^(?:npm_config_|NPM_CONFIG_)/.test(name)
    || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
      "NODE_EXTRA_CA_CERTS", "NODE_AUTH_TOKEN", "NPM_TOKEN", "WAND_NPM_BIN"].includes(name));
  // NAME-only setenv inherits from the invoking environment without exposing
  // credential values in argv or copying them into generated scripts.
  return [...names.filter(name => env[name] !== undefined).sort().map(name => `--setenv=${name}`),
    ...(systemScope ? [`--property=User=${uid}`, `--property=Group=${gid}`] : [])];
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
      const res = runCommandSync("systemd-run", args, {
        env: baseEnv,
        timeout: 5000,
        stdio: "ignore",
      });
      return res.status === 0 ? { method } : null;
    };
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const userEnvArgs = buildSystemdUpdateEnvironmentArgs(baseEnv, false, uid, gid);
    const systemEnvArgs = buildSystemdUpdateEnvironmentArgs(baseEnv, true, uid, gid);
    if (shouldUseSystemdRunForDetachedUpdate(serviceScope)) {
      const userService =
        runTransient(
          ["--user", ...userEnvArgs, `--unit=${unitName}`, "--quiet", "--collect", bashPath, scriptPath],
          "systemd-run --user",
        ) ??
        runTransient(
          ["--user", ...userEnvArgs, `--unit=${unitName}`, "--quiet", bashPath, scriptPath],
          "systemd-run --user",
        );
      if (userService) return userService;

      const systemService =
        runTransient(
          [...systemEnvArgs, `--unit=${unitName}`, "--quiet", "--collect", bashPath, scriptPath],
          "systemd-run",
        ) ??
        runTransient(
          [...systemEnvArgs, `--unit=${unitName}`, "--quiet", bashPath, scriptPath],
          "systemd-run",
        );
      if (systemService) return systemService;
      return null;
    }

    const setsid = runCommandSync("setsid", ["--version"], { timeout: 2000 });
    if (setsid.status === 0) {
      const result = trySpawn("setsid", [bashPath, scriptPath], "setsid");
      if (result) return result;
    }
  }

  if (process.platform === "darwin") {
    // `detached: true` already creates an independent process group. Wrapping the
    // helper in /usr/bin/nohup breaks when Wand itself is a launchd daemon:
    // nohup exits immediately because it cannot adopt a Background session, while
    // spawn() has already returned a PID and the API falsely reports success.
    const result = trySpawn(resolveBashPath(), [scriptPath], "bash detached");
    if (result) return result;
  }

  return trySpawn(resolveBashPath(), [scriptPath], "bash detached");
}

export function startDetachedUpdateHelper(opts: DetachedUpdateOptions): DetachedUpdateResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-update-"));
  const scriptPath = path.join(dir, "update.sh");
  const logPath = path.join(dir, "update.log");
  try {
    assertSafeInstallSpec(opts.installSpec);
  } catch (err) {
    return { started: false, scriptPath, logPath, message: err instanceof Error ? err.message : String(err) };
  }
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
  if (!checkGlobalUpdateAccess()) {
    return { started: false, scriptPath, logPath,
      message: `当前安装目录不允许服务写入，请执行一次恢复更新，迁移到可持续自更新的安装：${buildUpdateRecoveryCommand(opts.configPath)}` };
  }
  if (serviceScope) {
    const preflight = managedServiceUpdatePreflight(serviceScope, opts.configPath);
    if (!preflight.ok) {
      return {
        started: false,
        scriptPath,
        logPath,
        message: preflight.message,
      };
    }
  }
  writeFileSync(scriptPath, buildDetachedUpdateHelperScript(opts, logPath, serviceScope), {
    encoding: "utf8",
    mode: 0o700,
  });
  chmodSync(scriptPath, 0o700);
  writeFileSync(logPath, `[wand-update] helper queued at ${new Date().toISOString()}\n`, { mode: 0o600 });
  writeFileSync(`${logPath}.status.json`, JSON.stringify({ phase: "queued", message: "更新已排队。" }), { mode: 0o600 });

  const operationFile = path.join(path.dirname(path.resolve(opts.configPath)), "web-update-operation.json");
  writeFileSync(`${operationFile}.tmp`, JSON.stringify({
    configPath: path.resolve(opts.configPath), logPath,
    version: opts.expectedVersion ?? opts.installSpec.slice(opts.installSpec.lastIndexOf("@") + 1),
  }), { mode: 0o600 });
  renameSync(`${operationFile}.tmp`, operationFile);
  const spawned = spawnDetached(scriptPath, logPath, opts.env, serviceScope);
  if (!spawned) {
    writeFileSync(`${logPath}.status.json`, JSON.stringify({ phase: "failed", message: "独立更新程序没有启动，当前服务未停止。" }), { mode: 0o600 });
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
  const res = runCommandSync("bash", ["--version"], { timeout: 2000 });
  return res.status === 0;
}
