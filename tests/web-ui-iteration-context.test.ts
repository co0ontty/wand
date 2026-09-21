import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  visibleMilestones,
} from "../src/web-ui/react/milestones/controller.ts";
import {
  defaultMilestone,
  useDefaultMilestone,
  usePreselectMilestone,
} from "../src/web-ui/react/milestones/default-iteration.ts";
import type { MilestoneOption } from "../src/web-ui/react/milestones/repository.ts";
import { IterationContextPanel } from "../src/web-ui/react/quick-commit/iteration-panel.tsx";
import { normalizeQuickCommitContext } from "../src/web-ui/react/quick-commit/repository.ts";
import type { QuickCommitIterationContext } from "../src/web-ui/react/quick-commit/types.ts";

function milestone(overrides: Partial<MilestoneOption> & { id: string }): MilestoneOption {
  return {
    name: overrides.id,
    dueDate: null,
    workspaceId: null,
    isDefault: false,
    createdAt: "2026-02-14T09:00:00.000Z",
    updatedAt: "2026-02-14T09:00:00.000Z",
    taskCount: 0,
    ...overrides,
  };
}

function context(overrides: Partial<QuickCommitIterationContext> = {}): QuickCommitIterationContext {
  return {
    iteration: { id: "iteration-default", name: "默认迭代", isDefault: true },
    entries: [
      {
        id: "p2",
        title: "修终端乱码",
        detail: "修终端乱码：按列宽重新 fit，别动 CSS",
        createdAt: "2026-02-14T09:05:00.000Z",
        consumed: false,
        consumedCommit: "",
        source: "session",
      },
      {
        id: "p1",
        title: "补快捷提交",
        detail: "补快捷提交",
        createdAt: "2026-02-13T10:00:00.000Z",
        consumed: true,
        consumedCommit: "abcdef1",
        source: "session",
      },
    ],
    defaultEntryIds: ["p2"],
    selectableIds: ["p1", "p2"],
    truncated: false,
    effectiveMode: "iteration",
    mode: "iteration",
    ...overrides,
  };
}

function render(overrides: Partial<Parameters<typeof IterationContextPanel>[0]> = {}): string {
  const props = {
    context: context(),
    mode: "iteration" as const,
    selectedIds: new Set(["p2"]),
    includeDiff: false,
    onModeChange: () => undefined,
    onToggleEntry: () => undefined,
    onSelectAll: () => undefined,
    onIncludeDiffChange: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(IterationContextPanel, props));
}

test("默认迭代从可见界面里取，且不越过工作区过滤", () => {
  const items = [
    milestone({ id: "iteration-default", name: "默认迭代", isDefault: true }),
    milestone({ id: "m-project", name: "本项目迭代", workspaceId: "project-1" }),
    milestone({ id: "m-other", name: "别项目迭代", workspaceId: "project-2" }),
  ];
  // 没选工作区：全量可见，默认迭代照样取得到。
  assert.equal(defaultMilestone(items)?.id, "iteration-default");
  assert.equal(defaultMilestone(items, "project-1")?.id, "iteration-default");
  // 默认迭代是全局的（workspaceId = null），任何工作区都能预选。
  assert.equal(visibleMilestones(items, "project-1").some((item) => item.isDefault), true);
  assert.equal(defaultMilestone([milestone({ id: "m-project" })], "project-1"), null);
});

test("默认迭代预选钩子只在打开时填一次", () => {
  // 纯函数式断言钩子的实现约束：必须依赖 ref 而不是每次渲染都覆盖用户的选择。
  const source = readFileSync(
    new URL("../src/web-ui/react/milestones/default-iteration.ts", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("const done = React.useRef(false);"));
  assert.ok(source.includes("if (done.current || !milestone) return;"));
  assert.ok(source.includes("done.current = false;"), "关闭后要允许下次打开重新预选");
  // 三个新建入口都要接上预选，否则「所有任务都有默认迭代」在前端不成立。
  for (const file of [
    "../src/web-ui/react/issues/task-board-host.tsx",
    "../src/web-ui/react/workspaces/host.tsx",
    "../src/web-ui/react/missions/host.tsx",
  ]) {
    const host = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(host.includes("usePreselectMilestone("), `${file} 应该预选默认迭代`);
    assert.ok(host.includes("useDefaultMilestone("), `${file} 应该拿到默认迭代`);
  }
  assert.equal(typeof useDefaultMilestone, "function");
  assert.equal(typeof usePreselectMilestone, "function");
});

test("默认迭代只在面板打开时拉列表（登录前挂载的宿主不能提前 401）", () => {
  // 宿主（例如「新建任务」对话框）在登录前就挂载了：一次性 load() 会拿到 401，
  // 而 store 只在成功时置 loaded，于是预选永远不生效。必须由打开状态驱动。
  const source = readFileSync(
    new URL("../src/web-ui/react/milestones/default-iteration.ts", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("active = true"), "钩子要接受面板打开状态");
  assert.ok(
    source.includes("if (!active || snapshot.loaded || snapshot.loading) return;"),
    "没打开（或已加载/加载中）时不该打接口",
  );
  assert.ok(source.includes("[active, snapshot.loaded, snapshot.loading]"), "打开或加载状态变化后要能重试");
  for (const file of [
    "../src/web-ui/react/issues/task-board-host.tsx",
    "../src/web-ui/react/workspaces/host.tsx",
    "../src/web-ui/react/missions/host.tsx",
  ]) {
    const host = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(host, /useDefaultMilestone\([^)]*,\s*[\w.]+/, `${file} 要把打开状态传进去`);
  }
});

test("本轮变更面板默认用迭代提示词，勾选状态一眼可见", () => {
  const html = render();
  assert.ok(html.includes("本次变更输入"));
  assert.ok(html.includes("迭代提示词"));
  assert.ok(html.includes("完整 diff"));
  assert.ok(html.includes('aria-checked="true"'), "默认选中「迭代提示词」");
  assert.ok(html.includes("默认迭代"), "标出迭代归属");
  assert.ok(html.includes("修终端乱码"));
  assert.ok(html.includes("已提交"), "已提交过的条目要标出来");
  assert.ok(html.includes("已选 1 条"));
  assert.ok(html.includes("本轮未提交 1 条"));
  // 面板只给提示词标题，不给 diff：省 token 这件事在 UI 上也要看得见。
  assert.ok(!html.includes("diff --git"));
});

test("勾选清空时面板说清楚会退回读 diff", () => {
  const html = render({ selectedIds: new Set() });
  assert.ok(html.includes("没有勾选任何条目，这次会改读完整 diff"));
  assert.ok(html.includes("disabled"), "「清空」在没勾选时禁用");
});

test("切到完整 diff 模式时不列条目，但保留已提交口径", () => {
  const html = render({ mode: "diff" });
  assert.ok(html.includes("将把完整 diff 交给模型"));
  assert.ok(!html.includes("修终端乱码"), "diff 模式不需要提示词清单");
  assert.ok(html.includes("记为已提交"));
  // 一条待提交的都没有时不要写「0 条」这种别扭话。
  const empty = render({
    mode: "diff",
    context: context({ defaultEntryIds: [], selectableIds: [], entries: [] }),
  });
  assert.ok(empty.includes("将把完整 diff 交给模型。"));
  assert.ok(!empty.includes("0 条"));
});

test("本轮没有提示词时明确提示会改读完整 diff", () => {
  const html = render({
    context: context({ entries: [], defaultEntryIds: [], selectableIds: [], effectiveMode: "diff" }),
    selectedIds: new Set(),
  });
  assert.ok(html.includes("还没有记录到提示词"));
  assert.ok(!html.includes("wand-quick-iteration-list"));
});

test("上下文归一化：缺字段、脏数据都不会让面板崩", () => {
  const normalized = normalizeQuickCommitContext({
    iteration: { id: "i1", name: "默认迭代", isDefault: true },
    entries: [
      { id: "p1", title: "a", detail: "a", createdAt: "2026-02-14T09:05:00.000Z", consumed: true },
      { title: "没有 id" },
      "脏数据",
    ],
    defaultEntryIds: ["p1", 7],
    truncated: true,
    effectiveMode: "whatever",
    mode: "diff",
  });
  assert.equal(normalized.entries.length, 1);
  assert.equal(normalized.entries[0].consumedCommit, "");
  assert.deepEqual(normalized.defaultEntryIds, ["p1"]);
  // selectableIds 缺失时退回「展示的全部条目」，前端校验不会把合法勾选拦掉。
  assert.deepEqual(normalized.selectableIds, ["p1"]);
  assert.equal(normalized.effectiveMode, "iteration");
  assert.equal(normalized.mode, "diff");
  assert.equal(normalized.truncated, true);

  const empty = normalizeQuickCommitContext(null);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.effectiveMode, "diff");
  assert.equal(empty.iteration.name, "");
});

test("里程碑下拉里默认迭代带「默认」徽标且不能删除", () => {
  const picker = readFileSync(
    new URL("../src/web-ui/react/milestones/picker.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(picker.includes("milestone-picker-item-default"));
  assert.ok(picker.includes("默认"));
  // 默认迭代选中时「清除」的语义是「回到默认」，不是清空归属。
  assert.ok(picker.includes('selected.isDefault ? "回到默认" : "清除"'));
});
