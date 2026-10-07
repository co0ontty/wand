import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { issueAgentProviderLabel } from "../src/web-ui/react/issues/task-board-agent.js";
import {
  configureMissionsRuntime,
  missionsController,
  missionsStore,
} from "../src/web-ui/react/missions/controller.js";

test("mission dispatch blocks overlay switching until the operation finishes", () => {
  let closed = 0;
  const restore = configureMissionsRuntime({
    onOpen() {},
    onClose() { closed += 1; },
    async openSession() {},
    effectiveCwd: () => "/tmp",
  });
  try {
    missionsController.open();
    const revision = missionsStore.getSnapshot().revision;
    missionsController.setDismissable(false);

    assert.equal(missionsController.closeIfOpen(), false);
    assert.equal(missionsController.isOpen(), true);
    assert.equal(closed, 0);
    assert.equal(missionsStore.getSnapshot().revision, revision,
      "locking the form must not restart the host's loading lifecycle");

    missionsController.setDismissable(true);
    assert.equal(missionsController.closeIfOpen(), true);
    assert.equal(missionsController.isOpen(), false);
    assert.equal(closed, 1);
  } finally {
    missionsController.close();
    restore();
  }
});

test("a later mission dialog does not inherit a previous operation's close lock", () => {
  try {
    missionsController.open();
    missionsController.setDismissable(false);
    missionsController.close();
    missionsController.open();

    assert.equal(missionsStore.getSnapshot().dismissable, true);
    assert.equal(missionsController.closeIfOpen(), true);
  } finally {
    missionsController.close();
  }
});

test("任务面板的状态标签与 provider 名都有兜底，加号是图标不是全角字符", () => {
  const host = readFileSync(new URL("../src/web-ui/react/missions/host.tsx", import.meta.url), "utf8");
  assert.match(host, /function missionStateLabel\(state: string \| null \| undefined\): string \{\s*if \(!state\) return "未知状态";\s*return STATE_LABELS\[state\] \?\? "未知状态";\s*\}/);
  // 四个渲染点全走同一个出口，认不出来的状态不再漏英文 id、也不渲染成空芯片。
  assert.doesNotMatch(host, /\{STATE_LABELS\[[^\]]+\]\}/);
  assert.equal((host.match(/missionStateLabel\(/g) ?? []).length, 5, "一处定义 + 四处调用");
  assert.match(host, /<Typography.Text type="secondary">\{missionStateLabel\(item\.state\)\}\{item\.summary/);
  assert.match(host, /个 Agent · \{missionStateLabel\(mission\.status\)\}/);

  // provider 名取自看板同一个标签函数，不再直接印内部 id。
  assert.match(host, /title=\{<Space>[\s\S]*issueAgentProviderLabel\(attempt\.provider\)/);
  assert.match(host, /title=\{`\$\{issueAgentProviderLabel\(diffAttempt\.provider\)\} 的 Diff`\}/);
  assert.doesNotMatch(host, /\{diffAttempt\.provider\} Diff/);
  assert.notEqual(issueAgentProviderLabel("claude"), "claude");
  assert.equal(issueAgentProviderLabel(""), "Agent", "空值也不空白");

  assert.match(host, /<WandIcon name="plus" slot="start" size=\{13\}\/>新任务/);
  assert.doesNotMatch(host, /＋/);
});

test("进行中要把按钮文案换掉，空态就地给出下一步（复用同一条新建流程）", () => {
  const host = readFileSync(new URL("../src/web-ui/react/missions/host.tsx", import.meta.url), "utf8");
  // busy 是读 Diff / 加意见 / 发意见共用的旗标，所以进行中文案不能指定成某一个动作。
  assert.match(host, /\{busy \? "处理中…" : "加入 Review"\}/);
  assert.match(host, /\{busy \? "处理中…" : `发送 \$\{pendingComments\.length\} 条意见`\}/);
  assert.doesNotMatch(host, /disabled=\{busy[^}]*\} onClick=\{\(\) => void sendReview\(\)\}>发送/);
  // 两处空态原来只有一句话，下一步（新建）藏在右上角工具栏里。
  const startCreate = host.match(/const startCreateMission = \(\): void => \{\s*setCreateError\(""\);\s*setCreating\(true\);\s*\};/);
  assert.ok(startCreate, "空态和工具栏走同一个 handler，不各写一份");
  assert.equal((host.match(/onClick=\{startCreateMission\}/g) ?? []).length, 3,
    "工具栏 + 两处空态都指向它");
  assert.match(host, /还没有并行任务。创建一个，让多个 Agent 在独立 worktree 中并行尝试。/);
  assert.match(host, /选择或创建一个任务，看每个 Agent 的尝试与 Diff。/);
});
