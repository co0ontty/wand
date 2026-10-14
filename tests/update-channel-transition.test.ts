import assert from "node:assert/strict";
import test from "node:test";
import { selectPackageUpdateInfo } from "../src/npm-update-utils.js";
import { createRestartOverlayController } from "../src/web-ui/react/restart-overlay/controller.js";
import { restartOverlayPresentation } from "../src/web-ui/react/restart-overlay/model.js";
import { HttpRestartOverlayRepository } from "../src/web-ui/react/restart-overlay/repository.js";
import type { RestartOverlayClock } from "../src/web-ui/react/restart-overlay/types.js";

test("Beta subscribers receive stable releases while retaining their subscription", () => {
  const cases = [
    ["4.91.0-beta.10", "4.91.0", "4.91.0-beta.10", "4.91.0", true, "latest"],
    ["4.90.0", "4.91.0", "4.90.1-beta.10", "4.91.0", true, "latest"],
    ["4.91.0", "4.91.0", "4.91.1-beta.11", "4.91.1-beta.11", true, "beta"],
    ["4.91.1-beta.11", "4.91.0", "4.91.1-beta.11", "4.91.1-beta.11", false, "beta"],
    ["4.91.1-beta.11", "4.91.0", null, "4.91.0", false, "latest"],
    ["4.90.0", "4.91.0", "invalid", "4.91.0", true, "latest"],
    ["4.90.0", null, "4.91.1-beta.11", "4.91.1-beta.11", true, "beta"],
  ] as const;
  for (const [current, stable, beta, target, available, tag] of cases) {
    const info = selectPackageUpdateInfo(current, "beta", stable, beta);
    assert.equal(info.channel, "beta");
    assert.equal(info.latest, target);
    assert.equal(info.updateAvailable, available);
    assert.equal(info.distTag, tag);
    assert.equal(info.installSpec, "@co0ontty/wand@" + target);
  }
  assert.equal(selectPackageUpdateInfo("4.91.0", "stable", "4.91.0", "4.92.0-beta.1").latest, "4.91.0");
});

test("confirmed update failure stops polling and exposes the error without a success reload", async () => {
  let tick: (() => void | Promise<void>) | undefined;
  let stopped = false;
  const clock: RestartOverlayClock = {
    setInterval(callback) { tick = callback; return 1; }, clearInterval() { stopped = true; },
    setTimeout() { return 2; }, clearTimeout() {},
  };
  const controller = createRestartOverlayController({
    repository: { async loadConfig() { return {
      serverInstanceId: "old", currentVersion: "1.0.0", packageVersion: "1.0.0",
      updateFailure: "更新失败，旧服务仍在运行。",
    }; } }, clock, reloadPage() { assert.fail("failed update must not reload as success"); },
  });
  controller.showRestart("old", "2.0.0");
  await tick!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getSnapshot().phase, "timed-out");
  assert.equal(stopped, true);
  assert.equal(restartOverlayPresentation(controller.getSnapshot()).liveStatus, "更新失败，旧服务仍在运行。");
  controller.dispose();
});

test("HTTP readiness reads only failure status belonging to its target version", async () => {
  const seen: string[] = [];
  const repository = new HttpRestartOverlayRepository(async (input) => {
    seen.push(String(input));
    return Response.json(String(input) === "/api/config"
      ? { serverInstanceId: "old", packageVersion: "1.0.0" }
      : { version: "2.0.0", status: { phase: "failed", message: "npm 安装失败" } });
  });
  assert.equal((await repository.loadConfig({ expectedVersion: "2.0.0" })).updateFailure, "npm 安装失败");
  assert.equal((await repository.loadConfig({ expectedVersion: "3.0.0" })).updateFailure, undefined);
  assert.deepEqual(seen, ["/api/config", "/api/update-status", "/api/config", "/api/update-status"]);
});
