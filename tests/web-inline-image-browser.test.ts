import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
test("real Chrome inline tool images expose a loading state, ready state and hidden failures", {
  timeout: 240_000,
}, async (t) => {
  // 浏览器回归默认关闭：本地 npm test 只跑单测；CI（和需要时手动）用 WAND_BROWSER_E2E=1 打开。
  if (process.env.WAND_BROWSER_E2E !== "1") {
    t.skip("set WAND_BROWSER_E2E=1 to run the Chrome CDP inline image regression");
    return;
  }
  const { stdout } = await exec(process.execPath, [
    new URL("./helpers/run-inline-image-browser-harness.mjs", import.meta.url).pathname,
  ], { maxBuffer: 2 * 1024 * 1024, timeout: 230_000 });
  const report = JSON.parse(stdout.trim());
  assert.equal(report.ok, true);
  assert.ok(report.requests.filter((path: string) => path.endsWith("wand-shot.png")).length >= 3,
    "every mode loads the real image instead of asserting against a stub");
  assert.equal(report.requests.filter((path: string) => path.endsWith("missing.png")).length, 3,
    "the failure path really hits the server once per mode");
  const phases = (mode: string, phase: string) => report.states.filter((entry: any) => entry.mode === mode && entry.phase === phase);
  for (const mode of ["desktop", "reduce-motion", "native-shell"]) {
    assert.equal(phases(mode, "loading").length, 1, `${mode}: the loading frame is observable`);
    assert.equal(phases(mode, "ready").length, 1, `${mode}: the image settles`);
    assert.equal(phases(mode, "error").length, 1, `${mode}: the failure frame is observable`);
    assert.equal(phases(mode, "base64").length, 1, `${mode}: inline base64 images follow the same path`);
  }
  const desktopLoading = phases("desktop", "loading")[0];
  assert.equal(desktopLoading.spinnerAnimation, "wand-tool-icon-spin");
  assert.equal(phases("reduce-motion", "loading")[0].spinnerAnimation, "none", "reduced motion never spins");
  assert.equal(phases("native-shell", "loading")[0].placeholderHeight > 0, true, "the native shell also reserves the placeholder row");
  assert.equal(report.errors.length, 0);
});
