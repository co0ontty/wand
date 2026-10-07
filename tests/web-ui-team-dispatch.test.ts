import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import {
  canAddDispatchMember,
  dispatchProbabilityLabel,
  dispatchSelectionPayload,
  dispatchStartBlockedReason,
  initialDispatchSelection,
  setDispatchLeader,
  toggleDispatchMember,
} from "../src/web-ui/react/team-dispatch/roster.js";
import { defaultTeamStartProject, teamStartProjects } from "../src/web-ui/react/ai-teams/team-start-projects.js";
import { DISPATCH_VALUE, agentTargetIsDispatch, agentTargetOptions } from "../src/web-ui/react/issues/agent-fields.js";
import type { TeamDispatchPlan, TeamDispatchPlanMember } from "../src/web-ui/react/ai-teams/repository.js";

const read = (rel: string): string => readFileSync(new URL(`../src/web-ui/${rel}`, import.meta.url), "utf8");

function member(name: string, probability: number, isLeader = false): TeamDispatchPlanMember {
  return { employeeId: `e_${name}`, name, duty: `${name}的职责`, tags: [], avatar: "", probability, isLeader };
}

const plan: TeamDispatchPlan = {
  members: [member("甲", 0.91, true), member("乙", 0.72), member("丙", 0.55)],
  bench: [member("丁", 0.51)],
  considered: 4,
  omitted: 0,
  threshold: 0.5,
  maxMembers: 3,
  note: "从 4 名候选里建议 3 人（1 次本地判断）。",
  decision: { calls: 1, model: "aac6fef/laya-multilingual-mlx", inputTokens: 120 },
  experimental: true,
};

test("初始选择沿用建议名单与服务端的负责人标记", () => {
  const selection = initialDispatchSelection(plan);
  assert.deepEqual(selection.members.map((item) => item.name), ["甲", "乙", "丙"]);
  assert.equal(selection.leaderId, "e_甲");
  // 服务端没标负责人时退回第一位；空名单不产生负责人。
  assert.equal(initialDispatchSelection({ ...plan, members: [member("甲", 0.9), member("乙", 0.6)] }).leaderId, "e_甲");
  assert.equal(initialDispatchSelection({ ...plan, members: [] }).leaderId, "");
});

test("勾选只改名单：取消负责人时负责人顺延，重新加入按概率排序", () => {
  const selection = initialDispatchSelection(plan);
  const withoutLeader = toggleDispatchMember(selection, selection.members[0]!);
  assert.deepEqual(withoutLeader.members.map((item) => item.name), ["乙", "丙"]);
  assert.equal(withoutLeader.leaderId, "e_乙", "负责人被取消后落到剩下第一位");

  const readded = toggleDispatchMember(withoutLeader, member("丁", 0.99));
  assert.deepEqual(readded.members.map((item) => item.name), ["丁", "乙", "丙"], "新加入的按概率重排");
  assert.equal(readded.leaderId, "e_乙", "重排不改负责人");

  // 名单上限：满了就不再接受新成员（备选里也不再给加入入口）
  const full = { members: [member("1", 0.9), member("2", 0.8), member("3", 0.7), member("4", 0.6), member("5", 0.5),
    member("6", 0.4), member("7", 0.3), member("8", 0.2)], leaderId: "e_1" };
  assert.equal(canAddDispatchMember(full), false);
  assert.equal(toggleDispatchMember(full, member("9", 0.1)), full, "超员时原样返回");
});

test("负责人只能从名单内选，回传形状只标一个人", () => {
  const selection = initialDispatchSelection(plan);
  assert.equal(setDispatchLeader(selection, "e_乙").leaderId, "e_乙");
  assert.equal(setDispatchLeader(selection, "e_不在名单").leaderId, selection.leaderId, "不在名单里不接受");
  assert.deepEqual(dispatchSelectionPayload(setDispatchLeader(selection, "e_丙")), [
    { employeeId: "e_甲" },
    { employeeId: "e_乙" },
    { employeeId: "e_丙", isLeader: true },
  ]);
});

test("开工按钮的禁用原因覆盖项目、说明与人数，空串表示可以开工", () => {
  const selection = initialDispatchSelection(plan);
  const ok = { selection, workspaceId: "w1", note: "做点事", busy: false };
  assert.equal(dispatchStartBlockedReason(ok), "");
  assert.match(dispatchStartBlockedReason({ ...ok, note: "   " }), /先写清/);
  assert.match(dispatchStartBlockedReason({ ...ok, workspaceId: "" }), /先选一个项目/);
  assert.match(dispatchStartBlockedReason({ ...ok, busy: true }), /正在处理/);
  assert.match(
    dispatchStartBlockedReason({ ...ok, selection: { members: [member("甲", 0.9)], leaderId: "e_甲" } }),
    /至少需要 2 名员工/,
  );
});

test("概率只作参考：展示成整数百分比并夹在 0–100 之间", () => {
  assert.equal(dispatchProbabilityLabel(0.914), "91%");
  assert.equal(dispatchProbabilityLabel(0), "0%");
  assert.equal(dispatchProbabilityLabel(1.4), "100%");
  assert.equal(dispatchProbabilityLabel(Number.NaN), "");
});

test("项目候选规则与「直接开工」共用同一份实现（不再各写一套）", () => {
  const projects = [
    { id: "p1", name: "项目一", cwd: "/a", kind: "project" },
    { id: "g", name: "全局", cwd: "/tmp", kind: "global" },
  ] as never;
  assert.deepEqual(teamStartProjects(projects).map((project) => project.id), ["p1"]);
  assert.equal(defaultTeamStartProject(projects), "p1");
  assert.equal(defaultTeamStartProject([]), "");
  // 团队页只做再导出，避免两个入口各写一份过滤规则
  assert.match(read("react/ai-teams/teams-page.tsx"),
    /export \{ defaultTeamStartProject, teamStartProjects \} from "\.\/team-start-projects";/);
});

test("入口接在团队页页头，面板在页头下方原位展开、三条关闭路径齐备且不动用 Toast", () => {
  const page = read("react/ai-teams/teams-page.tsx");
  const panel = read("react/ai-teams/team-dispatch.tsx");
  const roster = read("react/team-dispatch/roster.tsx");
  assert.match(page, /<TeamDispatchTrigger/);
  assert.match(page, /<TeamDispatchPanel/);
  assert.match(page, /onStarted=\{\(started\) => afterDirectRun\(started\.teamId, started\)\}/,
    "开工成功后要复用既有的“打开群聊”落点");
  // 触发按钮在页头（与「新建团队」同行），面板是页头的下一个兄弟：展开不会拉宽页头、不会往右挤。
  const tree = ts.createSourceFile("teams-page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const includesComponent = (node: ts.Node, name: string): boolean => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === name) return true;
    return node.getChildren(tree).some((child) => includesComponent(child, name));
  };
  let header: ts.JsxElement | undefined;
  const findHeader = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "Flex"
      && node.openingElement.attributes.properties.some((attr) => ts.isJsxAttribute(attr)
        && attr.name.getText(tree) === "component" && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === "header")) header = node;
    ts.forEachChild(node, findHeader);
  };
  findHeader(tree);
  assert.ok(header, "团队页保留真实 header 语义");
  assert.ok(includesComponent(header, "TeamDispatchTrigger"), "入口属于页头");
  assert.equal(includesComponent(header, "TeamDispatchPanel"), false, "展开面板不能进页头挤走按钮");
  assert.ok(ts.isJsxElement(header.parent), "页头与面板共享路由容器");
  const siblings = header.parent.children.filter((node) => !(ts.isJsxText(node) && !node.text.trim())
    && !(ts.isJsxExpression(node) && !node.expression));
  assert.ok(includesComponent(siblings[siblings.indexOf(header) + 1]!, "TeamDispatchPanel"), "面板紧跟页头原位展开");
  assert.match(panel, />临时派工</);
  // 原位展开：同一套 0fr→1fr 网格过渡 + 双帧起点
  assert.match(panel, /<Collapse ghost bordered=\{false\} className="wand-team-candidate-slot" activeKey=\{settled \? \["dispatch"\] : \[\]\}/);
  assert.match(panel, /forceRender: true/);
  assert.match(panel, /let inner = 0;[\s\S]*inner = requestAnimationFrame/, "过渡要有起点（双帧）");
  // 展开时不能把面板内容滚出视野（focus 会把 overflow:hidden 容器带偏）
  assert.match(panel, /focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /innerRef\.current\.scrollTop = 0/);
  // 三条关闭路径：再点触发点 / Esc / 点到面板外
  assert.match(panel, /onClick=\{onToggle\}/);
  assert.match(panel, /window\.addEventListener\("keydown", onKeyDown, true\)/, "Esc 要在 window 捕获阶段拦：焦点常在页头触发点上");
  assert.match(panel, /window\.addEventListener\("pointerdown", onPointerDown, true\)/);
  assert.doesNotMatch(panel, /from "\.\.\/ui\/toast"|wandOverlay\.toast/, "结果留在原位，不用 Toast");
  // 只走仓储，不自己拼 URL；两个契约分别对应 plan 与 start
  // 两个契约与停留时长都只在主包共享模块里出现一份（三处入口共用）
  assert.match(roster, /aiTeamsRepository\.dispatchPlan\(\{/);
  assert.match(roster, /aiTeamsRepository\.dispatchStart\(\{/);
  assert.doesNotMatch(roster, /fetch\(/);
  assert.match(roster, /aiTeamsRepository\.settle\("success"\)/);
  assert.match(roster, /aiTeamsRepository\.settle\("error"\)/);
  // 面板外壳只借用共享模块，不再自己拼请求
  assert.doesNotMatch(panel, /aiTeamsRepository\./);
  assert.match(panel, /__wandAiTeamsHost\?\.\("team-dispatch\/roster"\)/);
});


test("按需包与主包的分工：面板与项目规则都在 chunk 清单里，不额外拖大主包", () => {
  const chunkScript = readFileSync(new URL("../scripts/ai-teams-chunk.js", import.meta.url), "utf8");
  assert.match(chunkScript, /"ai-teams", "team-dispatch\.tsx"/);
  assert.match(chunkScript, /"ai-teams", "team-start-projects\.ts"/);
});

test("看板的「第一次指派」下拉里出现临时派工，且它不是 ExecutionSubject", () => {
  const providers = [
    { value: "claude" as const, label: "Claude Code" },
    { value: "codex" as const, label: "Codex" },
  ];
  const withoutDispatch = agentTargetOptions(providers, [], []);
  assert.equal(withoutDispatch.some((option) => option.value === DISPATCH_VALUE), false, "默认不加：现有调用方行为不变");
  const withDispatch = agentTargetOptions(providers, [], [], { includeDispatch: true });
  assert.deepEqual(withDispatch[withDispatch.length - 1], { value: DISPATCH_VALUE, label: "临时派工 · 决策选人" });
  assert.equal(agentTargetIsDispatch(DISPATCH_VALUE), true);
  assert.equal(agentTargetIsDispatch("team:t1"), false);
  assert.equal(agentTargetIsDispatch("claude"), false);
});

test("看板新建任务接上共享派工流程：不建本地任务、成功后打开群聊", () => {
  const host = read("react/issues/task-board-host.tsx");
  assert.match(host, /const \[dispatchSelected, setDispatchSelected\] = React\.useState\(false\)/);
  assert.match(host, /const dispatchFlow = useTeamDispatchFlow\(\)/);
  assert.match(host, /agentTargetOptions\(providerOptions, teams, employees, \{ includeDispatch: true \}\)/);
  assert.match(host, /<TeamDispatchRoster\s/);
  assert.match(host, /<TeamDispatchActionButton\s/);
  // 派工分支必须在创建本地任务之前返回（服务端自己建卡）
  const dispatchBranch = host.slice(host.indexOf("if (dispatchSelected) {"));
  assert.match(dispatchBranch.slice(0, 400), /dispatchFlow\.(startNow|planNow)/);
  assert.match(dispatchBranch.slice(0, 900), /return;/);
  // 成功后按 run 的群聊会话导航
  assert.match(host, /started\.run\?\.chatSessionId/);
  assert.match(host, /onOpenSession\?\.\(chatId\)/);
});
