import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { configureMilestonesRepository, milestoneNameOf, milestonesStore, visibleMilestones } from "../src/web-ui/react/milestones/controller.js";
import { MilestonePicker } from "../src/web-ui/react/milestones/picker.js";
import type { MilestoneOption } from "../src/web-ui/react/milestones/repository.js";

function option(id: string, name: string, taskCount = 0, workspaceId: string | null = null): MilestoneOption {
  return { id, name, dueDate: null, workspaceId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", taskCount };
}

test("milestone store loads once and prepends newly created milestones", async () => {
  let listCalls = 0;
  const restore = configureMilestonesRepository({
    async list() {
      listCalls += 1;
      return [option("m1", "旧里程碑", 2)];
    },
    async create(input) {
      return option("m2", input.name, 0, input.workspaceId ?? null);
    },
    async update(id, patch) {
      return option(id, "新里程碑", 0, patch.workspaceId);
    },
  });
  try {
    await Promise.all([milestonesStore.load(), milestonesStore.load()]);
    assert.equal(listCalls, 1, "两个面板同时打开时只应该打一次接口");
    assert.deepEqual(milestonesStore.getSnapshot().items.map((item) => item.id), ["m1"]);
    assert.equal(milestonesStore.getSnapshot().loaded, true);

    // 已经加载过：再次 load 不再请求。
    await milestonesStore.load();
    assert.equal(listCalls, 1);

    const created = await milestonesStore.create("  新里程碑  ", "ws-1");
    assert.equal(created.name, "新里程碑");
    assert.equal(created.workspaceId, "ws-1");
    assert.deepEqual(milestonesStore.getSnapshot().items.map((item) => item.id), ["m2", "m1"]);

    // 回填工作区：缓存里的那条同步改成归属该工作区。
    await milestonesStore.rebind("m2", "ws-2");
    assert.equal(milestonesStore.getSnapshot().items.find((item) => item.id === "m2")?.workspaceId, "ws-2");
    assert.equal(milestonesStore.getSnapshot().items.find((item) => item.id === "m1")?.workspaceId, null);

    await assert.rejects(() => milestonesStore.create("   "), /里程碑名称/);
  } finally {
    restore();
  }
});

test("milestone store surfaces load failures instead of pretending the list is empty", async () => {
  const restore = configureMilestonesRepository({
    async list() {
      throw new Error("服务端不可用");
    },
    async create(input) {
      return option("m1", input.name);
    },
    async update(id, patch) {
      return option(id, "里程碑", 0, patch.workspaceId);
    },
  });
  try {
    await milestonesStore.load();
    const snapshot = milestonesStore.getSnapshot();
    assert.equal(snapshot.loaded, false);
    assert.equal(snapshot.items.length, 0);
    assert.equal(snapshot.error, "服务端不可用");
  } finally {
    restore();
  }
});

test("visibleMilestones keeps only the selected workspace's milestones plus global ones", () => {
  const items = [
    option("g1", "长线维护"),
    option("a1", "A 的迭代", 0, "a"),
    option("b1", "B 的迭代", 0, "b"),
  ];
  // 没选工作区：沿用全量列表。
  assert.deepEqual(visibleMilestones(items, "").map((item) => item.id), ["g1", "a1", "b1"]);
  assert.deepEqual(visibleMilestones(items, null).map((item) => item.id), ["g1", "a1", "b1"]);
  // 选了工作区：自己的 + 全局，别的项目的不出现。
  assert.deepEqual(visibleMilestones(items, "a").map((item) => item.id), ["g1", "a1"]);
  assert.deepEqual(visibleMilestones(items, " b ").map((item) => item.id), ["g1", "b1"]);
});

test("MilestonePicker treats a global milestone as selected but not another workspace's", () => {
  const items = [option("g1", "长线维护"), option("b1", "B 的迭代", 0, "b")];
  const global = renderToStaticMarkup(createElement(MilestonePicker, {
    value: "g1",
    workspaceId: "a",
    items,
    onChange: () => undefined,
  }));
  assert.match(global, /is-set/);
  assert.match(global, /长线维护/);

  const foreign = renderToStaticMarkup(createElement(MilestonePicker, {
    value: "b1",
    workspaceId: "a",
    items,
    onChange: () => undefined,
  }));
  assert.doesNotMatch(foreign, /is-set/);
});

test("milestoneNameOf resolves ids for board chips", () => {
  const items = [option("m1", "v5.0"), option("m2", "v6.0")];
  assert.equal(milestoneNameOf(items, "m2"), "v6.0");
  assert.equal(milestoneNameOf(items, null), "");
  assert.equal(milestoneNameOf(items, "missing"), "");
});

test("MilestonePicker renders a 里程碑 trigger and shows the selected name", () => {
  const trigger = renderToStaticMarkup(createElement(MilestonePicker, {
    value: null,
    onChange: () => undefined,
  }));
  assert.match(trigger, /里程碑</);
  assert.match(trigger, /data-icon="milestone"/);
  assert.doesNotMatch(trigger, /is-set/);

  const selected = renderToStaticMarkup(createElement(MilestonePicker, {
    value: "m1",
    items: [option("m1", "v5.0 发布")],
    onChange: () => undefined,
  }));
  assert.match(selected, /is-set/);
  assert.match(selected, /v5\.0 发布/);
});
