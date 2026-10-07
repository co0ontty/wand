import assert from "node:assert/strict";
import test from "node:test";
import { MountStore } from "../src/web-ui/react/composer-portal/mount-store.ts";
import {
  ComposerBadgesController,
  type ComposerBadgeMount,
} from "../src/web-ui/react/composer-badges/controller.ts";
import { ComposerConfigController, type ComposerConfigMount } from "../src/web-ui/react/composer-config/controller.ts";
import { ComposerPopoverController, type ComposerPopoverMount } from "../src/web-ui/react/composer-popover/controller.ts";
import { ComposerVoiceController, type ComposerVoiceMount } from "../src/web-ui/react/composer-voice/controller.ts";
import {
  ComposerAttachmentsController,
  type ComposerAttachmentItem,
  type ComposerAttachmentsMount,
} from "../src/web-ui/react/composer-attachments/controller.ts";

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

// ---- 叶子 equals 契约 ----
// 四个叶子都继承 MountStore：基类语义（首播、冻结、clear、取消订阅后静默）已由上面的
// mount store 用例覆盖，这里只盯各自 equals 的字段集，不再逐文件重复验证基类。
const LEAF_TARGET = {} as HTMLElement;

const CONFIG_STATE = {
  groupTitle: "模式 默认 · 模型 Sonnet · 思考 中",
  modeLabel: "默认",
  modelFullLabel: "claude-sonnet-4-5",
  modelRefreshing: false,
  thinkingValue: "standard",
  thinkingLabel: "中",
};

const ATTACHMENT_ITEMS: readonly ComposerAttachmentItem[] = [
  { index: 0, name: "shot.png", sizeLabel: "12.4 KB", previewUrl: "blob:wand/1" },
  { index: 1, name: "notes.txt", sizeLabel: "3 B", previewUrl: null },
];

interface LeafCase {
  readonly name: string;
  readonly controller: {
    subscribe: (listener: () => void) => () => void;
    sync: (mounts: ReadonlyArray<any>) => void;
    getSnapshot: () => { revision: number; mounts: ReadonlyArray<unknown> };
    clear: () => void;
  };
  /** 业务值相同的等价重放（回调始终是新闭包）。 */
  readonly baseline: () => any;
  readonly replay: () => any;
  /** 只改业务字段，必须算一次更新。 */
  readonly changed: () => any;
}

const LEAF_CASES: readonly LeafCase[] = [
  {
    name: "composer config",
    controller: new ComposerConfigController(),
    baseline: (): ComposerConfigMount => ({
      key: "composer-config-all", target: LEAF_TARGET, scope: "all", ...CONFIG_STATE, onRefreshModels() {},
    }),
    replay: (): ComposerConfigMount => ({
      key: "composer-config-all", target: LEAF_TARGET, scope: "all", ...CONFIG_STATE, onRefreshModels() {},
    }),
    changed: (): ComposerConfigMount => ({
      key: "composer-config-all", target: LEAF_TARGET, scope: "all", ...CONFIG_STATE, modeLabel: "托管", onRefreshModels() {},
    }),
  },
  {
    name: "composer popover",
    controller: new ComposerPopoverController(),
    baseline: (): ComposerPopoverMount => ({
      key: "composer-popover-items", target: LEAF_TARGET, interactiveVisible: true, interactiveOn: false,
      onAttach() {}, onToggleInteractive() {},
    }),
    replay: (): ComposerPopoverMount => ({
      key: "composer-popover-items", target: LEAF_TARGET, interactiveVisible: true, interactiveOn: false,
      onAttach() {}, onToggleInteractive() {},
    }),
    changed: (): ComposerPopoverMount => ({
      key: "composer-popover-items", target: LEAF_TARGET, interactiveVisible: true, interactiveOn: true,
      onAttach() {}, onToggleInteractive() {},
    }),
  },
  {
    name: "composer voice",
    controller: new ComposerVoiceController(),
    baseline: (): ComposerVoiceMount => ({
      key: "composer-voice", target: LEAF_TARGET, canceling: false, transcript: "", status: "正在聆听…上滑取消",
    }),
    replay: (): ComposerVoiceMount => ({
      key: "composer-voice", target: LEAF_TARGET, canceling: false, transcript: "", status: "正在聆听…上滑取消",
    }),
    changed: (): ComposerVoiceMount => ({
      key: "composer-voice", target: LEAF_TARGET, canceling: false, transcript: "你好", status: "正在聆听…上滑取消",
    }),
  },
  {
    name: "composer attachments",
    controller: new ComposerAttachmentsController(),
    baseline: (): ComposerAttachmentsMount => ({
      key: "composer-attachments", target: LEAF_TARGET, items: ATTACHMENT_ITEMS, onRemove() {},
    }),
    replay: (): ComposerAttachmentsMount => ({
      key: "composer-attachments", target: LEAF_TARGET, items: ATTACHMENT_ITEMS, onRemove() {},
    }),
    changed: (): ComposerAttachmentsMount => ({
      key: "composer-attachments", target: LEAF_TARGET,
      items: [{ ...ATTACHMENT_ITEMS[0]!, sizeLabel: "12.5 KB" }, ATTACHMENT_ITEMS[1]!], onRemove() {},
    }),
  },
];

test("composer portal 叶子只比较业务字段：等价重放不广播，业务字段变化广播", () => {
  for (const leaf of LEAF_CASES) {
    leaf.controller.clear();
    let notifications = 0;
    const unsubscribe = leaf.controller.subscribe(() => { notifications += 1; });

    leaf.controller.sync([leaf.baseline()]);
    assert.equal(notifications, 1, `${leaf.name} 首播一次`);
    const first = leaf.controller.getSnapshot();
    assert.ok(Object.isFrozen(first.mounts), `${leaf.name} 快照必须冻结`);

    // render() 每轮都会重新发布一遍：回调是新闭包，但业务值没变就不能广播。
    leaf.controller.sync([leaf.replay()]);
    assert.equal(notifications, 1, `${leaf.name} 等价重放不得广播`);
    assert.equal(leaf.controller.getSnapshot(), first, `${leaf.name} 等价重放不得换快照`);

    leaf.controller.sync([leaf.changed()]);
    assert.equal(notifications, 2, `${leaf.name} 业务字段变化必须广播`);
    assert.equal(leaf.controller.getSnapshot().revision, 2, `${leaf.name} revision 递增`);

    unsubscribe();
  }
});

test("徽章注册表按 kind 区分同 key 的两种徽章", () => {
  const controller = new ComposerBadgesController();
  const target = {} as HTMLElement;
  const autoApprove: ComposerBadgeMount = {
    key: "auto-approve",
    kind: "auto-approve",
    sessionId: "session-1",
    pending: false,
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
