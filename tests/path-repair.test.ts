import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildChildEnv, getLoginShellEnv, setLoginShellEnv } from "../src/env-utils.js";
import { deepRepairRuntimePath, formatPathRepairSummary, repairRuntimePath, whichSync, type PathRepairResult } from "../src/path-repair.js";
import { shellQuote } from "../src/shell-quote.js";

const exec = promisify(execFile);

test("runtime PATH includes the native OpenCode install even without shell initialization", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-native-opencode-path-"));
  const bin = path.join(root, ".opencode", "bin"); mkdirSync(bin, { recursive: true });
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, WAND_PATH_REPAIR_DISABLE: process.env.WAND_PATH_REPAIR_DISABLE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root; process.env.PATH = "/usr/bin:/bin"; delete process.env.WAND_PATH_REPAIR_DISABLE;
  assert.ok(repairRuntimePath().finalPath.split(path.delimiter).includes(bin));
});

test("deepRepairRuntimePath follows provider PTY interactive login shell PATH", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-path-repair-"));
  const oldBin = path.join(root, "homebrew-bin");
  const preferredBin = path.join(root, "nvm-bin");
  const serviceOnlyBin = path.join(root, "service-only-bin");
  mkdirSync(oldBin);
  mkdirSync(preferredBin);
  mkdirSync(serviceOnlyBin);

  const makeExecutable = (file: string, body: string): void => {
    writeFileSync(file, body, "utf8");
    chmodSync(file, 0o755);
  };
  makeExecutable(path.join(oldBin, "codex"), "#!/bin/sh\necho old\n");
  makeExecutable(path.join(preferredBin, "codex"), "#!/bin/sh\necho preferred\n");

  const probeShell = path.join(root, "probe-shell");
  makeExecutable(probeShell, [
    "#!/bin/sh",
    "# The provider PTY launches with -lic; -lc would miss interactive shell init (e.g. nvm).",
    "[ \"$1\" = '-lic' ] || exit 2",
    "printf 'PATH\\037%s\\n' \"$WAND_TEST_LOGIN_PATH\"",
    "printf 'CODEX\\037%s\\n' \"$WAND_TEST_CODEX\"",
  ].join("\n") + "\n");

  const originalPath = process.env.PATH;
  const originalLoginPath = process.env.WAND_TEST_LOGIN_PATH;
  const originalCodex = process.env.WAND_TEST_CODEX;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLoginPath === undefined) delete process.env.WAND_TEST_LOGIN_PATH;
    else process.env.WAND_TEST_LOGIN_PATH = originalLoginPath;
    if (originalCodex === undefined) delete process.env.WAND_TEST_CODEX;
    else process.env.WAND_TEST_CODEX = originalCodex;
    rmSync(root, { recursive: true, force: true });
  });

  process.env.PATH = [oldBin, preferredBin, serviceOnlyBin, "/usr/bin", "/bin"].join(path.delimiter);
  process.env.WAND_TEST_LOGIN_PATH = [preferredBin, oldBin, "/usr/bin", "/bin"].join(path.delimiter);
  process.env.WAND_TEST_CODEX = path.join(preferredBin, "codex");

  const initial: PathRepairResult = {
    added: [],
    resolved: { claude: null, codex: path.join(oldBin, "codex") },
    finalPath: process.env.PATH,
    deepProbe: "skipped",
    warnings: [],
  };
  // The full suite runs test files in parallel; leave enough headroom for process startup
  // on a busy machine so this integration-style shell probe does not become flaky.
  const result = await deepRepairRuntimePath(initial, { shell: probeShell, timeoutMs: 5_000 });
  const segments = result.finalPath.split(path.delimiter);

  assert.equal(segments[0], preferredBin);
  assert.equal(segments[1], oldBin);
  assert.ok(segments.indexOf(serviceOnlyBin) > segments.indexOf(oldBin));
  assert.equal(result.resolved.codex, path.join(preferredBin, "codex"));
  // The structured Codex runner uses whichSync against buildChildEnv; it must
  // resolve the same CLI as the interactive provider shell, not the service's stale PATH.
  assert.equal(whichSync("codex", { env: buildChildEnv(true) }), path.join(preferredBin, "codex"));
  assert.deepEqual(result.added, []);
  assert.equal(result.deepProbe, "success");
  assert.equal(result.shell, probeShell);
  assert.match(formatPathRepairSummary(result), new RegExp(`deep-probe: ok \\(${probeShell.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
});

test("login shell probe reuses the default shell environment for every CLI child", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-shell-env-"));
  const loginPath = path.join(root, "nvm-bin");
  mkdirSync(loginPath);

  const makeExecutable = (file: string, body: string): void => {
    writeFileSync(file, body, "utf8");
    chmodSync(file, 0o755);
  };
  const probeShell = path.join(root, "probe-shell");
  makeExecutable(probeShell, [
    "#!/bin/sh",
    "[ \"$1\" = '-lic' ] || exit 2",
    "printf 'PATH\\037%s\\n' \"$WAND_TEST_LOGIN_PATH\"",
    "printf '\\nWAND_ENV_BEGIN_7c1f\\n'",
    "printf 'WAND_TEST_SHELL_ONLY=from-shell\\n'",
    "printf 'WAND_TEST_SHELL_CONFLICT=from-shell\\n'",
    "printf 'PS1=leaked\\n'",
    "printf 'PATH=%s\\n' \"$WAND_TEST_LOGIN_PATH\"",
    "printf 'WAND_ENV_END_7c1f\\n'",
  ].join("\n") + "\n");

  const originalPath = process.env.PATH;
  const originalLoginPath = process.env.WAND_TEST_LOGIN_PATH;
  const originalConflict = process.env.WAND_TEST_SHELL_CONFLICT;
  const originalOnly = process.env.WAND_TEST_SHELL_ONLY;
  t.after(() => {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("PATH", originalPath);
    restore("WAND_TEST_LOGIN_PATH", originalLoginPath);
    restore("WAND_TEST_SHELL_CONFLICT", originalConflict);
    restore("WAND_TEST_SHELL_ONLY", originalOnly);
    setLoginShellEnv(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  // 服务进程环境里没有的变量只存在于用户 shell rc：探测必须把它回收给所有 CLI 子进程，
  // 而进程里已显式设置的同名变量仍以进程值为准。
  delete process.env.WAND_TEST_SHELL_ONLY;
  process.env.WAND_TEST_SHELL_CONFLICT = "from-process";
  process.env.PATH = [path.join(root, "service-bin"), "/usr/bin", "/bin"].join(path.delimiter);
  process.env.WAND_TEST_LOGIN_PATH = [loginPath, "/usr/bin", "/bin"].join(path.delimiter);

  const initial: PathRepairResult = {
    added: [],
    resolved: {},
    finalPath: process.env.PATH,
    deepProbe: "skipped",
    warnings: [],
  };
  const result = await deepRepairRuntimePath(initial, { shell: probeShell, timeoutMs: 5_000 });

  assert.equal(result.deepProbe, "success");
  assert.equal(getLoginShellEnv()?.WAND_TEST_SHELL_ONLY, "from-shell");
  assert.equal(getLoginShellEnv()?.PS1, undefined, "probe-only prompt state must not leak");

  const childEnv = buildChildEnv(true);
  assert.equal(childEnv.WAND_TEST_SHELL_ONLY, "from-shell");
  assert.equal(childEnv.WAND_TEST_SHELL_CONFLICT, "from-process");
  assert.equal(childEnv.PS1, undefined);
  // PATH 仍按登录 shell 优先重排，两条链路命中同一个 CLI。
  assert.equal(childEnv.PATH?.split(path.delimiter)[0], loginPath);
  assert.equal(buildChildEnv(false).WAND_TEST_SHELL_ONLY, undefined, "关闭继承时仍只注入白名单");
});

for (const shellExits of [false, true]) {
  test(`timed-out login probe closes inherited pipes when the shell ${shellExits ? "exits before its child" : "and its child ignore TERM"}`,
    { skip: process.platform === "win32" }, async t => {
      const root = mkdtempSync(path.join(os.tmpdir(), "wand-probe-timeout-"));
      const parentPid = path.join(root, "parent.pid"), childPid = path.join(root, "child.pid"), sleeperPid = path.join(root, "sleeper.pid");
      const childScript = path.join(root, "child.sh"), shell = path.join(root, "probe-shell"), runner = path.join(root, "run.mjs");
      t.after(() => {
        const pids = [parentPid, childPid, sleeperPid].flatMap(file => {
          try { const pid = Number(readFileSync(file, "utf8")); return Number.isSafeInteger(pid) && pid > 1 ? [pid] : []; }
          catch { return []; }
        });
        // These are PID files written only by this fixture. Clean up even if a
        // regression makes execFile reach its outer deadline.
        if (pids[0]) try { process.kill(-pids[0], "SIGKILL"); } catch { /* already reaped */ }
        for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
        rmSync(root, { recursive: true, force: true });
      });
      writeFileSync(childScript, ["#!/bin/sh", "trap '' TERM", "/bin/sleep 30 &",
        `printf '%s\\n' "$!" > ${shellQuote(sleeperPid)}`, "wait"].join("\n") + "\n");
      writeFileSync(shell, ["#!/bin/sh", "trap '' TERM", `printf '%s\\n' "$$" > ${shellQuote(parentPid)}`,
        `/bin/sh ${shellQuote(childScript)} &`, `printf '%s\\n' "$!" > ${shellQuote(childPid)}`,
        shellExits ? "exit 0" : "wait"].join("\n") + "\n");
      chmodSync(shell, 0o755);
      writeFileSync(runner, `import { deepRepairRuntimePath } from ${JSON.stringify(new URL("../src/path-repair.ts", import.meta.url).href)};\n`
        + `const result = await deepRepairRuntimePath({ added: [], resolved: {}, finalPath: process.env.PATH ?? "", deepProbe: "skipped", warnings: [] }, { shell: ${JSON.stringify(shell)}, timeoutMs: 500 });\n`
        + `process.stdout.write(JSON.stringify({ status: result.deepProbe, timedOut: result.warnings.some(warning => warning.includes("timed out")) }));\n`);
      const { stdout } = await exec(process.execPath, ["--import", "tsx", runner], {
        timeout: 10_000, killSignal: "SIGKILL", env: { ...process.env, WAND_PATH_REPAIR_DISABLE: "0", WAND_PATH_REPAIR_DEEP_DISABLE: "0" },
      });
      assert.deepEqual(JSON.parse(stdout), { status: "failed", timedOut: true });
      assert.ok(readFileSync(childPid, "utf8").trim(), "a descendant really held the inherited pipe");
      // Natural worker completion proves that neither the ignoring shell nor
      // its descendants retained a live pipe/child handle after the deadline.
    });
}
