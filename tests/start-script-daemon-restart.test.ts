import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../start.sh", import.meta.url), "utf8");
function extract(name: string): string {
  return source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

// Execute production lifecycle functions, but every external operation is a
// shell stub. No service, daemon, sudo, npm install or real model is invoked.
function runLifecycle({ restart = false, stopped = false, installed = true, guard = 0, scope = "system", route = "ensure", failStart = false, failReady = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wand-start-daemons-"));
  const cli = join(dir, "wand");
  writeFileSync(cli, "fixture\n");
  try {
    const restartBranch = source.match(/  restart-only\)\n([\s\S]*?)    ;;/)?.[1] ?? "";
    const result = spawnSync(process.platform === "darwin" ? "/bin/bash" : "bash", ["-c", `set -euo pipefail
EVENT_LOG="$1/events"
event() { printf '%s\\n' "$1" >> "$EVENT_LOG"; }
START_ATTEMPTS=0
RESTART_DAEMONS=${restart ? 1 : 0}
SERVICE_STOPPED_FOR_INSTALL=${stopped ? 1 : 0}
SERVER_STOPPED=${stopped ? 1 : 0}
SERVICE_EXISTS=${installed ? 1 : 0}
BACKEND=launchd
SCOPE=${scope}
SCOPE_FLAG=--${scope}
CONFIG_PATH="$1/config.json"
REPO_ROOT="$1"
NODE_BIN=/fixture/node
NODE_FOR_WAND=/fixture/node
WAND_BIN="$1/wand"
WAND_CORE_WAIT_TIMEOUT=30
msg() { :; }
ok() { :; }
warn() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
sudo_prefix() { :; }
service_installed() { [[ "$SERVICE_EXISTS" = 1 ]]; }
service_confirmed_stopped() { [[ "$SERVER_STOPPED" = 1 ]]; }
cleanup_stale_wand() { event cleanup; }
restart_daemons_now() { event daemons; }
wait_for_service_ready() { ${failReady ? 'die "service readiness failed"' : ":"}; }
print_panel() { :; }
run_privileged() {
  if [[ "$2" = *core-status-cli.ts ]]; then
    event core-guard
    [[ "$*" = *"--timeout 30 -- /fixture/node"* ]] || return 2
    [[ "$*" = *"service:stop --${scope}"* ]] || return 2
    ${guard === 0 ? "SERVER_STOPPED=1; return 0" : `return ${guard}`}
  else
    [[ "$*" = *"service:install --${scope}"* ]] || return 2
    event start
    START_ATTEMPTS=$((START_ATTEMPTS + 1))
    ${failStart ? '[[ "$START_ATTEMPTS" != 1 ]] || return 1' : ":"}
    SERVER_STOPPED=0
  fi
}
${extract("stop_service_for_install")}
${extract("restart_requested_daemons")}
${extract("restore_stopped_service")}
${extract("ensure_service_installed_and_running")}
${route === "restart" ? restartBranch : "ensure_service_installed_and_running"}
`, "daemon-restart-test", dir], { encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } });
    return { status: result.status, stderr: result.stderr, events: readFileSync(join(dir, "events"), "utf8").trim().split("\n") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("ordinary Server restart drains Core but never restarts daemon owners", () => {
  const result = runLifecycle();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ["core-guard", "cleanup", "start"]);
});

test("explicit daemon restart stops Server under Core guard before daemon replacement", () => {
  for (const scope of ["user", "system"]) {
    const result = runLifecycle({ restart: true, scope });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events, ["core-guard", "cleanup", "daemons", "start"]);
  }
});

test("already-stopped install path restarts daemon once before service startup", () => {
  const result = runLifecycle({ restart: true, stopped: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ["daemons", "start"]);
});

test("explicit daemon restart also guards a first-registration path", () => {
  const result = runLifecycle({ restart: true, installed: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ["core-guard", "cleanup", "daemons", "start"]);
});

test("busy/unknown Core cancels daemon stop and service start", () => {
  for (const guard of [1, 2, 3]) {
    const result = runLifecycle({ restart: true, guard });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.events, ["core-guard"]);
    assert.match(result.stderr, /已取消|服务仍处于加载状态/);
  }
});

test("real restart-only dispatch honors the daemon flag without a package build/install", () => {
  for (const restart of [false, true]) {
    const result = runLifecycle({ restart, route: "restart" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events, ["core-guard", "cleanup", ...(restart ? ["daemons"] : []), "start"]);
  }
});

test("restart-only failure attempts service recovery but never repeats daemon shutdown", () => {
  for (const scenario of [{ failStart: true }, { failReady: true }]) {
    const result = runLifecycle({ restart: true, route: "restart", ...scenario });
    assert.equal(result.status, 1);
    assert.deepEqual(result.events, ["core-guard", "cleanup", "daemons", "start", "start"]);
  }
});

test("guard failure in restart-only never activates the recovery or daemon action", () => {
  const result = runLifecycle({ restart: true, route: "restart", guard: 2 });
  assert.equal(result.status, 1);
  assert.deepEqual(result.events, ["core-guard"]);
});

test("all restart modes use the same guarded daemon preparation, diagnostics stay readonly", () => {
  const ensure = extract("ensure_service_installed_and_running");
  assert.match(ensure, /restart_requested_daemons/);
  const dispatch = source.slice(source.indexOf('case "$ACTION" in'));
  assert.match(dispatch, /restart-only\)\s+trap restore_stopped_service EXIT\s+ensure_service_installed_and_running/);
  for (const action of ["status", "logs", "attach"]) {
    const body = dispatch.match(new RegExp(`  ${action}\\)[\\s\\S]*?    ;;`))?.[0];
    assert.ok(body);
    assert.doesNotMatch(body, /restart_requested_daemons|restart_daemons_now/);
  }
  const installBody = source.slice(source.lastIndexOf('if [[ "$DO_INSTALL" == "1" ]]'));
  assert.doesNotMatch(installBody, /\n\s+restart_daemons_now\s*\n/, "daemon replacement has one guarded execution site, including skip-install");
});
