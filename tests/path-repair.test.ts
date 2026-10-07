import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildChildEnv, getLoginShellEnv, setLoginShellEnv } from "../src/env-utils.js";
import { deepRepairRuntimePath, formatPathRepairSummary, whichSync, type PathRepairResult } from "../src/path-repair.js";

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
