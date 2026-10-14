import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shellQuote, shellQuoteAll } from "../src/shell-quote.js";
import {
  assertSafeInstallSpec,
  buildDetachedUpdateHelperScript,
  startDetachedUpdateHelper,
  type DetachedUpdateOptions,
} from "../src/update-helper.js";

// Values that would break or hijack an unquoted/poorly quoted shell script.
const HOSTILE = [
  "it's a 'quote'",
  "$(touch PWNED_SUBSHELL)",
  "`touch PWNED_BACKTICK`",
  "line one\nline two",
  "WAND_INSTALL_NODE",
  "\"double\" ${HOME} \\n \\ ;rm -rf /tmp/none",
  "",
];

function hostileOptions(cwd: string, value: string): DetachedUpdateOptions {
  return {
    installSpec: "@co0ontty/wand@latest",
    configPath: `/tmp/${value}/config.json`,
    parentPid: 4242,
    cliArgs: [value, "plain"],
    nodeLoaderArgs: [],
    cwd,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", npm_config_cache: `/tmp/cache-${value}` },
    timeoutMs: 60_000,
  };
}

test("shellQuote round-trips hostile values through bash as a single literal word", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-quote-"));
  try {
    for (const value of HOSTILE) {
      const out = execFileSync("bash", ["-c", `printf '%s' ${shellQuote(value)}`], { cwd: dir, encoding: "utf8" });
      assert.equal(out, value, `value ${JSON.stringify(value)} did not round-trip`);
      const list = execFileSync("bash", ["-c", `a=(${shellQuoteAll([value, "x y"])}); printf '%s\\0' "\${a[@]}"`], { cwd: dir, encoding: "utf8" });
      assert.deepEqual(list.split("\0").slice(0, 2), [value, "x y"]);
    }
    assert.equal(existsSync(path.join(dir, "PWNED_SUBSHELL")), false);
    assert.equal(existsSync(path.join(dir, "PWNED_BACKTICK")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shellQuote rejects NUL bytes instead of silently truncating", () => {
  assert.throws(() => shellQuote("a\0b"), /NUL/);
});

test("generated update script assigns every hostile value literally and stays syntactically valid", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-update-quote-"));
  try {
    for (const value of HOSTILE) {
      const cwd = path.join(dir, "cwd");
      const opts = hostileOptions(cwd, value);
      const logPath = path.join(dir, `log-${Buffer.from(value).toString("hex").slice(0, 16)}.log`);
      const script = buildDetachedUpdateHelperScript(opts, logPath, null, "/nonexistent/npm-update-utils.js");
      const scriptPath = path.join(dir, "update.sh");
      writeFileSync(scriptPath, script, { mode: 0o700 });
      const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);

      // Header = everything before the function definitions; the exec redirect is removed so
      // the probe never writes into the hostile log path, and the variables are dumped NUL-separated.
      const header = script.slice(0, script.indexOf("run() {")).split("\n")
        .filter((line) => !line.startsWith("exec >>")).join("\n");
      const dumpPath = path.join(dir, "dump.bin");
      const probe = `${header}
printf '%s\\0' "$LOG" "$INSTALL_SPEC" "$PARENT_PID" "$CONFIG_PATH" "$SERVICE_SCOPE" "$NODE_BIN" "$UPDATE_UTILS" "$GLOBAL_CLI_PATH_FILE" "$WORKING_DIRECTORY" "\${CLI_ARGS[@]}" > ${shellQuote(dumpPath)}
`;
      const probePath = path.join(dir, "probe.sh");
      writeFileSync(probePath, probe, { mode: 0o700 });
      const run = spawnSync("bash", ["-u", probePath], { encoding: "utf8", cwd: dir, env: { PATH: "/usr/bin:/bin" } });
      assert.equal(run.status, 0, run.stderr);
      const fields = readFileSync(dumpPath, "utf8").split("\0");
      assert.equal(fields[0], logPath);
      assert.equal(fields[1], "@co0ontty/wand@latest");
      assert.equal(fields[2], "4242");
      assert.equal(fields[3], opts.configPath);
      assert.equal(fields[8], cwd);
      assert.deepEqual(fields.slice(9, 11), [value, "plain"], `cliArgs did not round-trip for ${JSON.stringify(value)}`);
      assert.equal(existsSync(path.join(dir, "PWNED_SUBSHELL")), false);
      assert.equal(existsSync(path.join(dir, "PWNED_BACKTICK")), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install spec is restricted to the Wand package with a dist-tag or semver", () => {
  for (const ok of ["@co0ontty/wand@latest", "@co0ontty/wand@beta", "@co0ontty/wand@1.2.3", "@co0ontty/wand@1.2.3-beta.4"]) {
    assert.equal(assertSafeInstallSpec(ok), ok);
  }
  for (const bad of [
    "@co0ontty/wand@latest; touch PWNED",
    "@co0ontty/wand@$(id)",
    "@co0ontty/wand@`id`",
    "file:/tmp/evil.tgz",
    "git+https://example.com/evil.git",
    "evil-package@latest",
    "@co0ontty/wand@latest\nrm -rf /",
    "@co0ontty/wand@../../x",
    "",
  ]) {
    assert.throws(() => assertSafeInstallSpec(bad), /Unsafe detached update install spec/, bad);
  }
});

test("startDetachedUpdateHelper refuses a hostile install spec without spawning anything", () => {
  const result = startDetachedUpdateHelper({
    ...hostileOptions(os.tmpdir(), "x"),
    installSpec: "@co0ontty/wand@latest; touch PWNED_START",
  });
  assert.equal(result.started, false);
  assert.match(result.message, /Unsafe detached update install spec/);
  assert.equal(existsSync(path.join(process.cwd(), "PWNED_START")), false);
});
