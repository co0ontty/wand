import assert from "node:assert/strict";
import test from "node:test";
import { MountStore } from "../src/web-ui/react/composer-portal/mount-store.ts";
import {
  ComposerBadgesController,
  type ComposerBadgeMount,
} from "../src/web-ui/react/composer-badges/controller.ts";
import { ComposerConfigController } from "../src/web-ui/react/composer-config/controller.ts";
import { ComposerPopoverController } from "../src/web-ui/react/composer-popover/controller.ts";

interface Mount {
  readonly key: string;
  readonly target: object;
  readonly value: number;
  readonly onSomething: () => void;
}

const TARGET = {};

function mountFor(value: number, overrides: Partial<Mount> = {}): Mount {
  return { key: "k", target: TARGET, value, onSomething() {}, ...overrides };
}

function storeOf(): MountStore<Mount> {
  // 与真实子类同样的约定：key/target 与业务字段参与比较，回调不参与。
  return new MountStore<Mount>(
    (a, b) => a.key === b.key && a.target === b.target && a.value === b.value,
  );
}

test("mount store 广播不可变快照并在无变化时跳过", () => {
  const store = storeOf();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });

  store.sync([mountFor(1)]);
  assert.equal(notifications, 1);
  const first = store.getSnapshot();
  assert.equal(first.revision, 1);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.mounts));

  // render() 每轮都会重新发布一遍：值相同不能广播。
  store.sync([mountFor(1, { onSomething() {} })]);
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot(), first);

  store.sync([mountFor(1), mountFor(2, { key: "k2" })]);
  assert.equal(notifications, 2);
  assert.equal(store.getSnapshot().revision, 2);
  assert.equal(store.getSnapshot().mounts.length, 2);

  store.clear();
  assert.equal(notifications, 3);
  assert.equal(store.getSnapshot().mounts.length, 0);

  // 已经空了再清一次是 no-op（否则适配器每帧都会广播）。
  store.clear();
  assert.equal(notifications, 3);

  unsubscribe();
  store.sync([mountFor(9)]);
  assert.equal(notifications, 3);
});

test("target 变化即使业务字段相同也算变更", () => {
  const store = storeOf();
  store.sync([mountFor(1)]);
  const first = store.getSnapshot();
  store.sync([mountFor(1, { target: {} })]);
  assert.notEqual(store.getSnapshot(), first);
  assert.equal(store.getSnapshot().revision, 2);
});

test("三个 composer portal 叶子共用同一个注册表实现", () => {
  // 防止某个叶子又被复制出一份几乎相同的 subscribe/sync/clear。
  for (const controller of [
    new ComposerBadgesController(),
    new ComposerConfigController(),
    new ComposerPopoverController(),
  ]) {
    assert.ok(controller instanceof MountStore);
  }
});

test("徽章注册表按 kind 区分同 key 的两种徽章", () => {
  const controller = new ComposerBadgesController();
  const target = {} as HTMLElement;
  const autoApprove: ComposerBadgeMount = {
    key: "auto-approve",
    kind: "auto-approve",
    target,
    enabled: false,
    onToggle() {},
  };
  controller.sync([autoApprove]);
  const first = controller.getSnapshot();
  assert.equal(first.mounts.length, 1);

  controller.sync([{ ...autoApprove, enabled: true }]);
  assert.equal(controller.getSnapshot().revision, 2);

  // 统计徽章的 stats 走深比较：同样的四元组不应广播。
  controller.sync([{
    key: "approval-stats",
    kind: "approval-stats",
    target,
    stats: { total: 3, command: 1, file: 1, tool: 1 },
  }]);
  const third = controller.getSnapshot();
  assert.equal(third.revision, 3);
  controller.sync([{
    key: "approval-stats",
    kind: "approval-stats",
    target,
    stats: { total: 3, command: 1, file: 1, tool: 1 },
  }]);
  assert.equal(controller.getSnapshot(), third);
});
