import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveApprovalStatsBadge,
  resolveAutoApproveBadge,
} from "../src/web-ui/browser/composer-badges-adapter.ts";
import { ComposerBadgesController } from "../src/web-ui/react/composer-badges/controller.ts";
import type { ComposerApprovalStats } from "../src/web-ui/react/composer-badges/controller.ts";
import {
  ComposerApprovalStatsBadge,
  ComposerAutoApproveChip,
} from "../src/web-ui/react/composer-badges/host.tsx";

test("composer badges controller publishes immutable portal mount snapshots", () => {
  const controller = new ComposerBadgesController();
  const target = {} as HTMLElement;
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });

  controller.sync([
    { key: "auto-approve", kind: "auto-approve", target, enabled: true, onToggle() {} },
    { key: "approval-stats", kind: "approval-stats", target, stats: null },
  ]);
  const first = controller.getSnapshot();
  assert.equal(first.revision, 1);
  assert.equal(first.mounts.length, 2);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.mounts));
  assert.equal(notifications, 1);

  controller.clear();
  assert.equal(controller.getSnapshot().mounts.length, 0);
  assert.equal(notifications, 2);
  // 已经是空快照时不再广播。
  controller.clear();
  assert.equal(notifications, 2);
  unsubscribe();
});

test("重复同步相同徽章不广播，统计数字变化才触发重渲染", () => {
  const controller = new ComposerBadgesController();
  const target = {} as HTMLElement;
  let notifications = 0;
  controller.subscribe(() => { notifications += 1; });
  const statsMount = (total: number, extra: Partial<ComposerApprovalStats> = {}) => ({
    key: "approval-stats",
    target,
    kind: "approval-stats" as const,
    stats: { total, command: 1, file: 0, tool: 0, ...extra },
  });

  controller.sync([statsMount(1)]);
  assert.equal(notifications, 1);
  // 同一份数字重复同步（每次 render 都会走一遍）不应该让脉冲动画重放。
  controller.sync([statsMount(1)]);
  assert.equal(notifications, 1);
  assert.equal(controller.getSnapshot().revision, 1);

  controller.sync([statsMount(2, { file: 1 })]);
  assert.equal(notifications, 2);
  assert.equal(controller.getSnapshot().revision, 2);

  controller.sync([{ key: "auto-approve", kind: "auto-approve", target, enabled: false, onToggle() {} }]);
  assert.equal(notifications, 3);
  controller.sync([{ key: "auto-approve", kind: "auto-approve", target, enabled: false, onToggle() {} }]);
  assert.equal(notifications, 3);
  controller.sync([{ key: "auto-approve", kind: "auto-approve", target, enabled: true, onToggle() {} }]);
  assert.equal(notifications, 4);
});

test("自动批准 chip 的可见性由模式隐含状态与选中会话共同决定", () => {
  assert.deepEqual(resolveAutoApproveBadge(null), { visible: false, enabled: false });
  assert.deepEqual(
    resolveAutoApproveBadge({ autoApproveHidden: true, autoApproveEnabled: true, approvalStats: null }),
    { visible: false, enabled: false },
  );
  assert.deepEqual(
    resolveAutoApproveBadge({ autoApproveHidden: false, autoApproveEnabled: true, approvalStats: null }),
    { visible: true, enabled: true },
  );
  assert.deepEqual(
    resolveAutoApproveBadge({ autoApproveHidden: false, autoApproveEnabled: false, approvalStats: null }),
    { visible: true, enabled: false },
  );
});

test("统计徽章在 total 为 0 时按旧语义继续隐藏", () => {
  assert.equal(resolveApprovalStatsBadge(null), null);
  assert.equal(resolveApprovalStatsBadge(undefined), null);
  assert.equal(resolveApprovalStatsBadge({ total: 0, command: 0, file: 0, tool: 0 }), null);
  const stats = { total: 3, command: 1, file: 2, tool: 0 };
  assert.deepEqual(resolveApprovalStatsBadge(stats), stats);
});

test("自动批准 chip 渲染手动/自动两种文案与 aria 状态", () => {
  const off = renderToStaticMarkup(React.createElement(ComposerAutoApproveChip, {
    enabled: false,
    onToggle() {},
  }));
  assert.match(off, /id="auto-approve-toggle"/);
  assert.match(off, /aria-pressed="false"/);
  assert.match(off, />手动</);
  assert.match(off, /data-wand-icon="shield"/);

  const on = renderToStaticMarkup(React.createElement(ComposerAutoApproveChip, {
    enabled: true,
    onToggle() {},
  }));
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, />自动</);
  assert.match(on, /auto-approve-indicator active/);
  assert.match(on, /data-wand-icon="shieldCheck"/);
});

test("统计徽章渲染总数、分类行与合计行，无统计时不渲染", () => {
  assert.equal(
    renderToStaticMarkup(React.createElement(ComposerApprovalStatsBadge, { stats: null, revision: 1 })),
    "",
  );

  const html = renderToStaticMarkup(React.createElement(ComposerApprovalStatsBadge, {
    stats: { total: 4, command: 2, file: 0, tool: 2 },
    revision: 2,
  }));
  assert.match(html, /id="approval-stats"/);
  assert.match(html, /class="approval-stats-total">4</);
  // 计数为 0 的分类行不渲染。
  assert.doesNotMatch(html, /文件写入/);
  assert.match(html, /命令执行/);
  assert.match(html, /其他工具/);
  assert.match(html, /approval-stats-row-total/);
  assert.match(html, /data-wand-icon="sigma"/);
});

test("宿主 span 用 display:contents 让徽章直接成为状态行的 flex item", () => {
  const css = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.composer-badge-host\s*\{\s*display:\s*contents;/);
});

test("输入栏种子 markup 只保留徽章宿主，不再内联渲染徽章", () => {
  const renderSource = readFileSync(new URL("../src/web-ui/browser/render.ts", import.meta.url), "utf8");
  assert.match(renderSource, /data-composer-badge-host="auto-approve"/);
  assert.match(renderSource, /data-composer-badge-host="approval-stats"/);
  assert.doesNotMatch(renderSource, /renderApprovalStatsBadge/);
  const engineSource = readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8");
  assert.doesNotMatch(engineSource, /renderAutoApproveChip/);
  const websocketSource = readFileSync(new URL("../src/web-ui/browser/websocket.ts", import.meta.url), "utf8");
  assert.doesNotMatch(websocketSource, /updateApprovalStats/);
  assert.match(websocketSource, /export function syncComposerBadges/);
});
