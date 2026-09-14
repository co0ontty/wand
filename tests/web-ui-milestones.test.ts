import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { configureMilestonesRepository, milestoneNameOf, milestonesStore } from "../src/web-ui/react/milestones/controller.js";
import { MilestonePicker } from "../src/web-ui/react/milestones/picker.js";
import type { MilestoneOption } from "../src/web-ui/react/milestones/repository.js";

function option(id: string, name: string, taskCount = 0): MilestoneOption {
  return { id, name, dueDate: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", taskCount };
}

test("milestone store loads once and prepends newly created milestones", async () => {
  let listCalls = 0;
  const restore = configureMilestonesRepository({
    async list() {
      listCalls += 1;
      return [option("m1", "旧里程碑", 2)];
    },
    async create(input) {
      return option("m2", input.name, 0);
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

    const created = await milestonesStore.create("  新里程碑  ");
    assert.equal(created.name, "新里程碑");
    assert.deepEqual(milestonesStore.getSnapshot().items.map((item) => item.id), ["m2", "m1"]);

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
