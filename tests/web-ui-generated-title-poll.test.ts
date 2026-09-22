import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createGeneratedTitlePoller,
  GENERATED_TITLE_POLL_DELAYS_MS,
} from "../src/web-ui/react/issues/generated-title-poll.js";

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** 假时钟：sleep 不真等待，由测试显式释放，才能断言「没有下一次等待」。 */
function fakeClock() {
  const slept: number[] = [];
  let waiting: Array<() => void> = [];
  return {
    slept,
    sleep(ms: number): Promise<void> {
      slept.push(ms);
      return new Promise((resolve) => { waiting.push(resolve); });
    },
    get pending(): number {
      return waiting.length;
    },
    /** 释放当前挂起的等待，让循环推进一轮。 */
    async tick(): Promise<void> {
      const batch = waiting;
      waiting = [];
      batch.forEach((resolve) => resolve());
      await flush();
      await flush();
    },
  };
}

function harness(options: { readonly delays?: readonly number[]; readonly title?: (round: number) => string | null } = {}) {
  const clock = fakeClock();
  let reloads = 0;
  let gets = 0;
  const poller = createGeneratedTitlePoller({
    sleep: clock.sleep,
    delays: options.delays ?? [10, 20, 30],
    async reload(): Promise<void> { reloads += 1; },
    async getTask(): Promise<{ title: string } | null> {
      gets += 1;
      const title = options.title ? options.title(gets) : "占位标题";
      return title === null ? null : { title };
    },
  });
  return {
    clock,
    poller,
    get reloads(): number { return reloads; },
    get gets(): number { return gets; },
  };
}

test("默认延迟序列保持 5 轮短轮询：最长约 19 秒后停", () => {
  assert.deepEqual([...GENERATED_TITLE_POLL_DELAYS_MS], [1_200, 2_000, 3_000, 5_000, 8_000]);
});

test("标题不再是占位值就停止，只 reload 一次", async () => {
  const h = harness({ title: () => "模型总结出的标题" });
  const done = h.poller.start("t1", "占位标题");
  await flush();
  assert.equal(h.clock.pending, 1, "进入第一次等待");

  await h.clock.tick();
  await done;

  assert.equal(h.reloads, 1);
  assert.equal(h.gets, 1);
  assert.deepEqual(h.clock.slept, [10], "拿到标题后不再安排下一次轮询");
  assert.equal(h.clock.pending, 0);
});

test("cancel 之后不再等待、不再请求，promise 正常 resolve", async () => {
  const h = harness();
  const done = h.poller.start("t1", "占位标题");
  await flush();
  assert.equal(h.clock.pending, 1);

  h.poller.cancel();
  await h.clock.tick();
  await done;

  assert.equal(h.reloads, 0);
  assert.equal(h.gets, 0);
  assert.deepEqual(h.clock.slept, [10], "cancel 后不再新增等待");
  assert.equal(h.clock.pending, 0);
});

test("cancel 发生在 reload 期间时，后续不再 getTask", async () => {
  const clock = fakeClock();
  let gets = 0;
  let releaseReload: (() => void) | null = null;
  const poller = createGeneratedTitlePoller({
    sleep: clock.sleep,
    delays: [10, 20],
    reload: () => new Promise<void>((resolve) => { releaseReload = resolve; }),
    async getTask(): Promise<{ title: string } | null> {
      gets += 1;
      return { title: "占位标题" };
    },
  });
  const done = poller.start("t1", "占位标题");
  await flush();
  await clock.tick();
  assert.equal(typeof releaseReload, "function", "reload 已经开始");

  poller.cancel();
  releaseReload!();
  await done;

  assert.equal(gets, 0);
  assert.deepEqual(clock.slept, [10]);
});

test("全部延迟耗尽后停止，不会无限重试", async () => {
  const h = harness({ delays: [10, 20, 30], title: () => "占位标题" });
  const done = h.poller.start("t1", "占位标题");
  for (let round = 0; round < 3; round += 1) {
    await flush();
    await h.clock.tick();
  }
  await done;

  assert.equal(h.reloads, 3);
  assert.equal(h.gets, 3);
  assert.deepEqual(h.clock.slept, [10, 20, 30]);
  assert.equal(h.clock.pending, 0, "跑完延迟序列就停，不再排队");
});

test("不注入 delays 时使用生产默认延迟序列（防止默认值退化成空）", async () => {
  // 之前所有行为用例都注入 delays，生产默认值只被字面量断言覆盖：把默认值改成 []
  // 会让轮询彻底失效而测试仍绿。这里直接用假 sleep 跑真实默认值。
  const clock = fakeClock();
  let reloads = 0;
  const poller = createGeneratedTitlePoller({
    sleep: clock.sleep,
    async reload(): Promise<void> { reloads += 1; },
    async getTask(): Promise<{ title: string } | null> { return { title: "占位标题" }; },
  });

  const done = poller.start("t1", "占位标题");
  for (let round = 0; round < GENERATED_TITLE_POLL_DELAYS_MS.length; round += 1) {
    await flush();
    await clock.tick();
  }
  await done;

  assert.deepEqual(clock.slept, [...GENERATED_TITLE_POLL_DELAYS_MS]);
  assert.equal(reloads, GENERATED_TITLE_POLL_DELAYS_MS.length);
});

test("同一任务重复 start 不会叠加两个循环", async () => {
  const h = harness({ title: () => "模型总结出的标题" });
  const first = h.poller.start("t1", "占位标题");
  await flush();
  assert.equal(h.clock.pending, 1);

  const second = h.poller.start("t1", "占位标题");
  await flush();
  // 旧一轮只是被世代号作废，不会开启第二条轮询：等待数不增加（允许旧等待立刻被结算）。
  assert.ok(h.clock.pending <= 2, "第二次 start 不得多起一条轮询");

  await h.clock.tick();
  await first;
  await second;

  assert.equal(h.reloads, 1, "旧循环静默退出，只有新循环轮询");
  assert.equal(h.gets, 1);
  assert.deepEqual(h.clock.slept, [10, 10]);
  assert.equal(h.clock.pending, 0);
});

test("任务看板使用可取消轮询器，并在看板关闭 / 卸载时 cancel", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  assert.match(host, /titlePollerRef\.current \?\?= createGeneratedTitlePoller\(/);
  assert.match(host, /void titlePollerRef\.current\.start\(created\.id, created\.title\);/);
  assert.doesNotMatch(host, /AUTO_TITLE_POLL_DELAYS_MS|refreshGeneratedTitle/, "内联轮询实现已移除");
  assert.equal(
    host.match(/titlePollerRef\.current\?\.cancel\(\)/g)?.length,
    2,
    "看板关闭与组件卸载各 cancel 一次",
  );
  assert.match(host, /\}, \[controller\.open\]\);/);
});
