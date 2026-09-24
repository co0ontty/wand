import assert from "node:assert/strict";
import test from "node:test";

import { shouldUpgradeRenderDaemon } from "../src/render-host.js";

/**
 * 升级决策：npm 升级 / start.sh 都不重启正在跑的 daemon（那里可能挂着用户的 shell），
 * 所以「什么时候可以动它」必须是纯决策、可单测的 —— 2026-09-24 的终端全断正是
 * 「daemon 一直跑旧代码、没有端点自愈」造成的。
 */
test("render: only an idle daemon older than the installed binary is replaced", () => {
  // 装好的更新 + 空闲 → 换
  assert.equal(shouldUpgradeRenderDaemon("0.1.2", "0.1.3", 0), true);
  // 装好的更新 + 有会话 → 绝不换（会杀掉用户的 shell），只告警
  assert.equal(shouldUpgradeRenderDaemon("0.1.2", "0.1.3", 3), false);
  // 一样新 → 不动
  assert.equal(shouldUpgradeRenderDaemon("0.1.3", "0.1.3", 0), false);
  // daemon 比包里的还新（本地就位了更新构建）→ 不动，否则会来回重启
  assert.equal(shouldUpgradeRenderDaemon("0.1.4", "0.1.3", 0), false);
  // 版本未知（老 daemon 没报版本 / 二进制读不出）→ 保守不动
  assert.equal(shouldUpgradeRenderDaemon(null, "0.1.3", 0), false);
  assert.equal(shouldUpgradeRenderDaemon("0.1.2", null, 0), false);
  // 带预发布后缀也要按 semver 比较
  assert.equal(shouldUpgradeRenderDaemon("0.1.3-rc.1", "0.1.3", 0), true);
});
