import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { detectInstalledScope, type ServiceScope } from "./tui/commands.js";

export interface DetachedUpdateOptions {
  installSpec: string;
  configPath: string;
  parentPid: number;
  cliArgs: string[];
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

function boolShell(value: boolean): string {
  return value ? "1" : "0";
}

function resolveBashPath(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function detectServiceScope(): ServiceScope | null {
  try {
    return detectInstalledScope();
  } catch {
    return null;
  }
}

function buildHelperScript(opts: DetachedUpdateOptions, logPath: string, serviceScope: ServiceScope | null): string {
  const isSystemdManaged = !!process.env.INVOCATION_ID;
  const isLaunchdManaged = !!process.env.LAUNCHD_SOCKET || !!process.env.XPC_SERVICE_NAME;
  const shouldStartService = serviceScope !== null;
  const shouldRestartStandalone = !shouldStartService;
  const npmCache = opts.env.npm_config_cache || path.join(os.homedir(), ".npm");
  const timeoutSec = Math.max(30, Math.ceil((opts.timeoutMs ?? 300_000) / 1000));
  const cliArgArray = opts.cliArgs;

  return `#!/usr/bin/env bash
set -u
LOG=${shellQuote(logPath)}
exec >>"$LOG" 2>&1
echo "[wand-update] started at $(date -Is)"
echo "[wand-update] parent pid: ${opts.parentPid}"
echo "[wand-update] install spec: ${opts.installSpec}"

export PATH=${shellQuote(opts.env.PATH || process.env.PATH || "")}
export HOME=${shellQuote(opts.env.HOME || os.homedir())}
export npm_config_cache=${shellQuote(npmCache)}
CONFIG_PATH=${shellQuote(opts.configPath)}
INSTALL_SPEC=${shellQuote(opts.installSpec)}
PARENT_PID=${opts.parentPid}
SERVICE_SCOPE=${shellQuote(serviceScope ?? "")}
SHOULD_START_SERVICE=${boolShell(shouldStartService)}
SHOULD_RESTART_STANDALONE=${boolShell(shouldRestartStandalone)}
TIMEOUT_SEC=${timeoutSec}
CLI_ARGS=(${shellArray(cliArgArray)})

run() {
  echo "+ $*"
  "$@"
}

run_best_effort() {
  echo "+ $*"
  "$@" || true
}

wait_for_parent_exit() {
  local pid="$1"
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 120 ]; then
      echo "[wand-update] parent still alive after 60s; continuing"
      return 0
    fi
    sleep 0.5
  done
}

clean_leftovers() {
  local npm_root
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [ -n "$npm_root" ] && [ -d "$npm_root/@co0ontty" ]; then
    find "$npm_root/@co0ontty" -maxdepth 1 -name ".wand-*" -type d -print -exec rm -rf {} + 2>/dev/null || true
  fi
}

npm_install_wand() {
  if command -v timeout >/dev/null 2>&1; then
    run timeout "$TIMEOUT_SEC" npm install -g "$INSTALL_SPEC"
  else
    run npm install -g "$INSTALL_SPEC"
  fi
}

npm_install_wand_force() {
  if command -v timeout >/dev/null 2>&1; then
    run timeout "$TIMEOUT_SEC" npm install -g --force "$INSTALL_SPEC"
  else
    run npm install -g --force "$INSTALL_SPEC"
  fi
}

restart_or_start_service() {
  if [ "$SHOULD_START_SERVICE" = "1" ]; then
    if [ "$SERVICE_SCOPE" = "user" ]; then
      run_best_effort wand service:install --user -c "$CONFIG_PATH"
      run_best_effort systemctl --user restart wand.service
    else
      run_best_effort wand service:install -c "$CONFIG_PATH"
      run_best_effort systemctl restart wand.service
    fi
    return
  fi

  if [ "$SHOULD_RESTART_STANDALONE" = "1" ]; then
    echo "[wand-update] starting standalone process"
    cd ${shellQuote(opts.cwd)}
    local global_cli
    global_cli="$(npm root -g 2>/dev/null)/@co0ontty/wand/dist/cli.js"
    if [ -f "$global_cli" ]; then
      nohup ${shellQuote(process.execPath)} "$global_cli" "$\{CLI_ARGS[@]}" >>"$LOG" 2>&1 &
    else
      nohup wand "$\{CLI_ARGS[@]}" >>"$LOG" 2>&1 &
    fi
  fi
}

main() {
  if [ "$SERVICE_SCOPE" = "user" ]; then
    run_best_effort systemctl --user stop wand.service
  elif [ "$SERVICE_SCOPE" = "system" ]; then
    run_best_effort systemctl stop wand.service
  fi

  wait_for_parent_exit "$PARENT_PID"
  clean_leftovers

  echo "[wand-update] installing"
  if ! npm_install_wand; then
    echo "[wand-update] first install failed; retrying with uninstall + force install"
    clean_leftovers
    run_best_effort npm uninstall -g @co0ontty/wand
    clean_leftovers
    npm_install_wand_force
  fi

  run wand init -c "$CONFIG_PATH"
  restart_or_start_service
  echo "[wand-update] completed at $(date -Is)"
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

    if (serviceScope) {
      return null;
    }

    const setsid = spawnSync("setsid", ["--version"], { encoding: "utf8", timeout: 2000 });
    if (setsid.status === 0) {
      const result = trySpawn("setsid", [bashPath, scriptPath], "setsid");
      if (result) return result;
    }
  }

  if (process.platform === "darwin") {
    const result = trySpawn("nohup", [resolveBashPath(), scriptPath], "nohup");
    if (result) return result;
  }

  return trySpawn(resolveBashPath(), [scriptPath], "bash detached");
}

export function startDetachedUpdateHelper(opts: DetachedUpdateOptions): DetachedUpdateResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-update-"));
  const scriptPath = path.join(dir, "update.sh");
  const logPath = path.join(dir, "update.log");
  const serviceScope = detectServiceScope();
  writeFileSync(scriptPath, buildHelperScript(opts, logPath, serviceScope), { encoding: "utf8", mode: 0o700 });
  chmodSync(scriptPath, 0o700);

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
