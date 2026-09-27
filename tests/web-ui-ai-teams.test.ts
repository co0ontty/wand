import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../src/web-ui/react/ui/motion-tokens.js";
import { reduceMotion } from "../src/web-ui/react/ui/reduce-motion.js";
import {
  addCandidate,
  candidateLabel,
  candidateListError,
  defaultTeamStartProject,
  duplicateCandidates,
  moveCandidate,
  removeCandidate,
  setCandidate,
  teamStartProjects,
  validateTeamDraft,
} from "../src/web-ui/react/ai-teams/teams-page.js";
import { usableTeamWorkspaceId } from "../src/web-ui/react/workspaces/workspace-agent-picker.js";
import { agentTargetOptions, agentTargetTeamId } from "../src/web-ui/react/issues/agent-fields.js";
import {
  chatInputHint,
  chatMessageBody,
  chatMessageUrl,
  chatTurnKind,
  chatTurnText,
  isConfirmedBy,
  needsCollapse,
  parseStepReport,
  settleLocalTurns,
  splitLeaderMessage,
  type LocalChatTurn,
} from "../src/web-ui/react/ai-teams/team-chat-view.js";
import { memberCoatIndex, CAT_COATS } from "../src/web-ui/react/ai-teams/avatar.js";
import { taskBoardPageOf, taskBoardSearch, isTaskBoardView } from "../src/web-ui/react/issues/task-board-controller.js";
import type { AiTeam, AiTeamMember } from "../src/ai-team-types.js";
import type { ConversationTurn } from "../src/types.js";
import type { WandTaskAgent } from "../src/task-types.js";

const read = (rel: string): string => readFileSync(new URL(`../src/web-ui/${rel}`, import.meta.url), "utf8");

test("AI teams live on their own sidebar page, not in settings", () => {
  const sidebar = read("react/shell/shell-sidebar.tsx");
  const main = read("react/shell/shell-main-content.tsx");
  const settings = read("react/settings/host.tsx");
  assert.match(sidebar, /taskBoardController\.open\([^)]*"teams"\)/);
  assert.match(main, /taskBoard\.page === "teams" \? <AiTeamsPage/);
  assert.doesNotMatch(settings, /ai-teams/);
  assert.equal(isTaskBoardView("?view=teams"), true);
  assert.equal(taskBoardPageOf("?view=teams"), "teams");
  assert.equal(taskBoardPageOf("?view=taskboard"), "board");
  assert.equal(taskBoardSearch("?a=1", true, "teams"), "?a=1&view=teams");
});

test("群聊条目走独立 IM 路由：teamchat 页带 run 参数，侧栏点击进群聊页", () => {
  assert.equal(isTaskBoardView("?view=teamchat"), true);
  assert.equal(taskBoardPageOf("?view=teamchat"), "teamchat");
  assert.equal(taskBoardSearch("", true, "teamchat", "run_1"), "?view=teamchat&run=run_1");
  assert.equal(taskBoardSearch("?view=teamchat&run=run_1", true, "board"), "?view=taskboard");
  assert.equal(taskBoardSearch("?view=teamchat&run=run_1", false, "board"), "");
  const main = read("react/shell/shell-main-content.tsx");
  assert.match(main, /taskBoard\.page === "teamchat" \? <TeamChatPage/);
  const panel = read("react/workspaces/workspaces-panel.tsx");
  assert.match(panel, /taskBoardController\.open\("", "", "teamchat", session\.teamChat\.runId\)/);
  assert.match(panel, /workspace-session-kind-team/);
});

test("群聊页对话区下方展示工作任务二级目录", () => {
  const page = read("react/ai-teams/team-chat-page.tsx");
  // 目录沉在对话区下方，数据来自已加载的 detail（run/steps），运行推进仍走 ai-team-run 通知，不轮询。
  assert.match(page, /<WorkTaskTree detail=\{detail\} onOpenSession=\{onOpenSession\}\/>/);
  assert.match(page, /detail\.steps\.filter\(\(step\) => step\.kind === "work"\)/, "一级只列派发给成员的工作步骤");
  assert.match(page, /<TeamAvatar member=\{member\}[\s\S]*?state=\{stepAvatarState\(step\.status\)\}/, "二级带归属成员头像");
  assert.match(page, /onOpenSession\(step\.sessionId!\)/, "二级里的会话跳转复用群聊页成员跳转路径");
  assert.match(page, /负责人还没有派发工作任务/, "无工作步骤时显示空态，不报错");
  assert.doesNotMatch(page, /setInterval|setTimeout\([^)]*load/, "本页不引入轮询：状态更新靠 ai-team-run 通知");
  const styles = read("react/ai-teams/styles.ts");
  assert.match(styles, /\.wand-team-work-body\s*\{[\s\S]*?grid-template-rows: 0fr/, "原位展开：0fr → 1fr");
  assert.match(styles, /\.wand-team-work-item\[data-open\] \.wand-team-work-body \{ grid-template-rows: 1fr/);
  // S3：新目录过渡统一到 motion + ease-in-out-smooth 一族，不再用缺省 easing 的 --transition-*。
  assert.match(styles, /\.wand-team-work-body \{[\s\S]*?transition: grid-template-rows var\(--motion-normal\) var\(--ease-in-out-smooth\), opacity var\(--motion-fast\) var\(--ease-in-out-smooth\)/);
  assert.match(styles, /\.wand-team-work-head > svg \{[^}]*transform var\(--motion-fast\) var\(--ease-in-out-smooth\)/);
  assert.doesNotMatch(styles, /\.wand-team-work-[^{]*\{[^}]*var\(--transition-(?:normal|fast)\)/, "工作任务目录不再引用 --transition-* 缺省 easing");
  assert.match(styles, /\.wand-team-work-body,\n\s*\.wand-team-work-head > svg,/, "reduce-motion 下退化瞬时");
});

test("team page edits members with the shared agent fields; only one leader", () => {
  const page = read("react/ai-teams/teams-page.tsx");
  assert.match(page, /<AgentFields[\s\S]*?showKind/);
  assert.match(page, /patch\.isLeader \? \{ \.\.\.member, isLeader: false \} : member/);
});

test("teams join the CLI picker as extra options", () => {
  const team = { id: "t1", name: "全栈" } as AiTeam;
  const options = agentTargetOptions([{ value: "claude", label: "Claude" }], [team]);
  assert.deepEqual(options.map((option) => option.value), ["claude", "team:t1"]);
  assert.equal(options[1]!.label, "团队 · 全栈");
  assert.equal(agentTargetTeamId("team:t1"), "t1");
  assert.equal(agentTargetTeamId("claude"), "");
  const board = read("react/issues/task-board-host.tsx");
  assert.match(board, /team \? dispatchTeam\(selected, team, prompt\) : dispatchTask\(/);
});

test("member avatars pick a stable coat unless one is chosen", () => {
  const base = { id: "m_abc", name: "实现" };
  assert.equal(memberCoatIndex(base), memberCoatIndex({ ...base }));
  assert.equal(memberCoatIndex({ ...base, avatar: "cat:3" }), 3);
  assert.equal(memberCoatIndex({ ...base, avatar: `cat:${CAT_COATS.length + 1}` }), 1);
});

test("task detail hosts the team run panel, refreshed by ai-team-run notifications instead of polling", () => {
  const board = read("react/issues/task-board-host.tsx");
  const panel = read("react/issues/team-run-panel.tsx");
  const ws = read("browser/websocket.ts");
  assert.match(board, /<TaskTeamRunPanel taskId=\{task\.id\}/);
  assert.match(ws, /msg\.data\.kind === "ai-team-run"[\s\S]*?notifyAiTeamRunChanged/);
  assert.match(panel, /subscribeAiTeamRunChanges/);
  assert.doesNotMatch(panel, /setInterval/);
});

test("team page and run panel stay out of the inline bundle and load on demand", () => {
  const main = read("react/shell/shell-main-content.tsx");
  const board = read("react/issues/task-board-host.tsx");
  assert.match(main, /import \{ AiTeamsPage, TeamChatPage \} from "\.\.\/ai-teams\/lazy";/);
  assert.match(board, /import \{ TaskTeamRunPanel \} from "\.\.\/ai-teams\/lazy";/);
  // 主包里除 lazy.tsx 的 import type 外，谁也不能直接引 chunk 文件，否则它们会被打回 scripts.js。
  const lazy = read("react/ai-teams/lazy.tsx");
  assert.match(lazy, /import type \{ AiTeamsPageProps \} from "\.\/teams-page";/);
  assert.match(lazy, /import type \{ TaskTeamRunPanelProps \} from "\.\.\/issues\/team-run-panel";/);
  assert.match(read("react/ai-teams/chunk-entry.ts"), /installStyleSheet\("wand-ai-teams-styles", aiTeamsChunkStyles\)/);
  assert.match(read("react/ai-teams/lazy.tsx"), /const AI_TEAMS_CHUNK_SRC = "\$\{aiTeamsChunkSrc\}";/);
  assert.match(read("scripts.ts"), /\.replace\("\$\{aiTeamsChunkSrc\}", `\/assets\/ai-teams\.js\?v=\$\{getAiTeamsChunk\(\)\.hash\}`\)/);
});

test("ai-teams chunk borrows every shared import from the main-bundle host registry", () => {
  const chunkFiles: Record<string, string> = {
    "ai-teams/chunk-entry": "react/ai-teams/chunk-entry.ts",
    "ai-teams/teams-page": "react/ai-teams/teams-page.tsx",
    "ai-teams/team-chat-view": "react/ai-teams/team-chat-view.tsx",
    "ai-teams/team-chat-page": "react/ai-teams/team-chat-page.tsx",
    "ai-teams/styles": "react/ai-teams/styles.ts",
    "issues/team-run-panel": "react/issues/team-run-panel.tsx",
  };
  const lazy = read("react/ai-teams/lazy.tsx");
  const registry = lazy.slice(lazy.indexOf("const AI_TEAMS_HOST"), lazy.indexOf("};\n", lazy.indexOf("const AI_TEAMS_HOST")));
  const hostNames = (key: string): string[] => {
    const match = registry.match(new RegExp(`"${key}": \\{([^}]*)\\}`));
    assert.ok(match, `lazy.tsx 注册表缺少模块 ${key}`);
    return match[1].split(",").map((name) => name.trim()).filter(Boolean);
  };
  for (const [selfKey, rel] of Object.entries(chunkFiles)) {
    const source = read(rel);
    for (const found of source.matchAll(/^import (?!type )([\s\S]*?) from "([^"]+)";/gm)) {
      const [, clause, spec] = found;
      if (spec === "react") {
        assert.match(registry, /"react": React,/);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const parts = selfKey.split("/").slice(0, -1);
      for (const segment of spec.split("/")) {
        if (segment === "..") parts.pop();
        else if (segment !== ".") parts.push(segment);
      }
      const key = parts.join("/");
      // react 目录外的纯数据模块（ai-team-types 等）直接打进 chunk；chunk 自己的文件互相引用。
      if (key.startsWith("..") || parts.length === 0 || spec.startsWith("../../../")) continue;
      if (Object.hasOwn(chunkFiles, key)) continue;
      const names = clause.replace(/[{}]/g, "").split(",").map((name) => name.trim())
        .filter((name) => name && !name.startsWith("type "));
      const provided = hostNames(key);
      for (const name of names) assert.ok(provided.includes(name), `${rel} 引的 ${key}.${name} 不在 lazy.tsx 注册表里`);
    }
  }
});

// ---------- [T6] Web 动效 token + 成员多候选编辑 ----------

const DWELL_TOKENS: Array<[string, number]> = [["--motion-dwell-sent", 720], ["--motion-dwell-failed", 1500]];
const TRANSITION_TOKENS: Array<[string, string]> = [
  ["--motion-press", "110ms"],
  ["--motion-fast", "150ms"],
  ["--motion-normal", "240ms"],
  ["--motion-morph", "200ms"],
  ["--motion-indicator", "260ms"],
  ["--motion-quick-exit", "90ms"],
];

function agentOf(provider: WandTaskAgent["provider"]): WandTaskAgent {
  return { provider, model: "default", thinkingEffort: "off", mode: "default", kind: "structured" };
}

function memberOf(name: string, agents: WandTaskAgent[], isLeader = false): AiTeamMember {
  return { id: `m_${name}`, name, duty: "", agents, agent: { ...agents[0]! }, isLeader };
}

function tsSources(dir: URL, into: string[] = []): string[] {
  const root = fileURLToPath(dir);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory()) tsSources(new URL(`${entry.name}/`, `file://${root}/`), into);
    else if (/\.tsx?$/.test(entry.name)) into.push(full);
  }
  return into;
}

test("[T6] dwell 常量与 CSS 同名 token 同值，reduce-motion 下不归零", () => {
  assert.equal(MOTION_DWELL_SENT_MS, 720);
  assert.equal(MOTION_DWELL_FAILED_MS, 1500);
  const css = read("content/styles.css");
  for (const [token, ms] of DWELL_TOKENS) {
    assert.match(css, new RegExp(`${token}: ${ms}ms;`), `${token} 没按 ${ms}ms 定义`);
  }
  for (const [token, value] of TRANSITION_TOKENS) {
    assert.match(css, new RegExp(`${token}: ${value};`), `${token} 缺失`);
  }
  // dwell 是「读结果的等待」：定义它的模块不许引用 reduce-motion 判定，CSS 也不许覆盖它。
  assert.doesNotMatch(read("react/ui/motion-tokens.ts"), /reduceMotion|prefers-reduced-motion/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.doesNotMatch(reduced.slice(0, reduced.indexOf("\n    }")), /--motion-dwell/);
  assert.equal(typeof reduceMotion, "function");
});

test("[T6] 毫秒只从 ui/motion-tokens.ts 进 JS，本轮动效全走 var(--motion-*)", () => {
  const offenders = tsSources(new URL("../src/web-ui/react/", import.meta.url))
    .filter((file) => /\b(?:720|1500)ms\b/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
  const chunk = read("react/ai-teams/styles.ts");
  const block = chunk.slice(chunk.indexOf("/* ---------- 成员执行候选"), chunk.indexOf("/* ---------- 运行记录"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(block.length > 200, "没切到候选样式块");
  assert.doesNotMatch(block, /:[^;]*\b\d+(?:ms|s)\b/, "候选样式里出现了裸时长");
  assert.match(block, /var\(--motion-normal\)/);
  assert.match(block, /var\(--motion-morph\)/);
  assert.match(block, /var\(--motion-press\)/);
});

test("[T6] 候选行模型：加/删/移/改与首选标签，越界与上限都不动原数组", () => {
  const a = agentOf("claude");
  const b = agentOf("codex");
  const c = agentOf("qoder");
  assert.equal(candidateLabel(0), "首选");
  assert.equal(candidateLabel(2), "备用 3");
  assert.deepEqual(addCandidate([a]), [a, a]);
  const four = [a, b, c, agentOf("pi")];
  assert.equal(addCandidate(four), four, "到 4 个上限必须原样返回");
  assert.deepEqual(setCandidate([a, b], 1, c), [a, c]);
  assert.deepEqual(moveCandidate([a, b, c], 1, -1), [b, a, c]);
  assert.deepEqual(moveCandidate([a, b, c], 2, 1), [a, b, c], "末位不能下移");
  assert.deepEqual(moveCandidate([a, b, c], 0, -1), [a, b, c], "首选不能上移");
  assert.deepEqual(removeCandidate([a, b], 0), [b]);
  assert.deepEqual(removeCandidate([a], 0), [a], "最后一个候选删不掉");
});

test("[T6] 重复与超上限的候选在保存前就被拦住，错误原位显示", () => {
  const a = agentOf("claude");
  const b = agentOf("codex");
  assert.deepEqual(duplicateCandidates([a, b, { ...a }]), [2]);
  assert.deepEqual(duplicateCandidates([a, b]), []);
  assert.equal(candidateListError([a, b]), "");
  assert.match(candidateListError([]), /至少/);
  assert.match(candidateListError([a, { ...a }]), /相同/);
  assert.match(candidateListError([a, b, { ...a }, { ...b }, agentOf("pi")]), /4/);

  const ok = [memberOf("负责人", [a], true), memberOf("实现", [b, { ...b, model: "opus" }])];
  assert.deepEqual(validateTeamDraft(ok), []);
  assert.match(validateTeamDraft(ok.map((member) => ({ ...member, isLeader: false }))).join("\n"), /负责人/);
  assert.match(validateTeamDraft(ok.map((member) => ({ ...member, isLeader: true }))).join("\n"), /负责人/);
  const duplicated = [ok[0]!, memberOf("实现", [{ ...b }, { ...b }])];
  assert.match(validateTeamDraft(duplicated).join("\n"), /实现：/);
  assert.equal(validateTeamDraft([ok[0]!]).length, 1, "成员数不足也要报");

  const page = read("react/ai-teams/teams-page.tsx");
  assert.match(page, /className="wand-team-candidate-error" role="alert"/);
  assert.doesNotMatch(page, /alert\(|WandToast|wandOverlay\.toast/);
  assert.doesNotMatch(page, /draggable|onDragStart|dragover/, "不做拖拽排序");
});

test("[T6] 成员卡一行一候选：复用 AgentFields，双写 agents/agent，上限与末位保护落在按钮上", () => {
  const page = read("react/ai-teams/teams-page.tsx");
  const compact = page.replace(/\s+/g, " ");
  assert.match(page, /<AgentFields[\s\S]*?showKind/);
  assert.match(page, /memberAgents\(member\)/, "读候选要走 memberAgents，不依赖兼容字段");
  assert.match(compact, /onChange\(\{ agents: next, agent: \{ \.\.\.next\[0\]! \} \}\)/, "保存要双写 agents + agent");
  assert.match(compact, /disabled=\{disabled \|\| locked \|\| agents\.length >= AI_TEAM_MAX_CANDIDATES\}/);
  assert.match(compact, /disabled=\{disabled \|\| locked \|\| total <= 1\}/);
  assert.match(page, /duplicate=\{duplicates\.includes\(at\)\}/);
  assert.match(page, /data-leaving=/, "删除走同一段过渡的倒放");
  assert.match(page, /candidateLabel\(index\)/);
  // 旧的单候选写法不该还留在成员卡上。
  assert.doesNotMatch(compact, /onChange\(\{ agent, agents: \[agent\] \}\)/);
  assert.match(read("react/ai-teams/styles.ts"), /grid-template-rows: 0fr/);
});

// ---------- [T7] 入口适配：picker 团队分组、三入口、原位「直接开工」 ----------

const pickerSource = read("react/workspaces/workspace-agent-picker.tsx");
const hostSource = read("react/workspaces/host.tsx");
const teamPageSource = read("react/ai-teams/teams-page.tsx");
const repositorySource = read("react/ai-teams/repository.ts");
const workspaceTypesSource = read("react/workspaces/types.ts");

/** 去掉注释后再断言，免得解释性文字里的字面量被当成实现。 */
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("[T7] 团队只在「已选中已有项目」时可选，global 与未选中都禁用", () => {
  assert.equal(usableTeamWorkspaceId("ws_1"), "ws_1");
  assert.equal(usableTeamWorkspaceId("ws_1", "project"), "ws_1");
  assert.equal(usableTeamWorkspaceId("ws_1", "global"), "", "kind=global 服务端会 400");
  assert.equal(usableTeamWorkspaceId("wand-global"), "", "合成出来的全局 id 也要挡住");
  assert.equal(usableTeamWorkspaceId(undefined), "", "还没选项目");
  assert.equal(usableTeamWorkspaceId(""), "");

  assert.match(pickerSource, /const teamBlocked = teamWorkspaceId === ""/);
  assert.match(pickerSource, /disabled=\{disabled \|\| teamBlocked\}/);
  assert.match(pickerSource, /TEAM_NEEDS_PROJECT_HINT\}<\/p>/, "禁用说明原位出现在分组里");
  assert.doesNotMatch(pickerSource, /wandOverlay|Toast|toast\(/);
});

test("[T7] 团队是 picker 自己的选择态，没有撑宽 WorkspaceSessionTarget", () => {
  assert.match(workspaceTypesSource, /export type WorkspaceSessionTarget = WorkspaceProvider \| "shell";/);
  assert.doesNotMatch(workspaceTypesSource, /export type WorkspaceSessionTarget[^;]*team/, "types.ts 只加新类型，不动联合");
  assert.match(workspaceTypesSource, /export interface WorkspaceTeamOption/);

  // 选中团队后隐藏「会话类型 / 模型」，选回 CLI 时清掉团队。
  assert.match(pickerSource, /const teamSelected = teamId !== ""/);
  assert.equal(pickerSource.match(/\{!teamSelected && target !== "shell" \? \(/g)?.length, 2, "会话类型与模型两处一起让位");
  assert.match(pickerSource, /<legend className="wand-new-session-field-label">会话类型<\/legend>/);
  assert.match(pickerSource, /<legend className="wand-new-session-field-label">模型<\/legend>/);
  assert.match(pickerSource, /if \(teamSelected\) onTeamChange\?\.\(""\)/);
  // WelcomeChooser 的 onStart 签名不变，团队走可选旁路。
  assert.match(pickerSource, /onStart\(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string\): void \| Promise<void>;/);
  assert.match(pickerSource, /onStartTeam\?\(teamId: string, workspaceId: string\): void \| Promise<void>;/);
  assert.match(pickerSource, /if \(!onStartTeam \|\| !teamWorkspaceId\) throw new Error\(TEAM_NEEDS_PROJECT_HINT\)/);
});

test("[T7] 侧栏新建任务与项目欢迎页都接了团队旁路，任务上下文那条没有", () => {
  assert.match(hostSource, /const teamWorkspaceId = usableTeamWorkspaceId\(selectedProject\?\.id, selectedProject\?\.kind\)/);
  assert.match(hostSource, /teams=\{teamOptions\}[\s\S]*?teamWorkspaceId=\{teamWorkspaceId\}[\s\S]*?teamId=\{teamId\}/);
  assert.match(hostSource, /try \{\n      if \(teamId\) \{[\s\S]*?await startDirectTeamRun\(\);\n        return;/);
  // 项目欢迎页：workspaceId 是当前项目；global 项目不下发团队候选。
  const main = read("react/shell/shell-main-content.tsx");
  assert.match(main, /teams=\{teamWorkspaceId \? teamOptions : null\}/);
  assert.match(main, /onStartTeam=\{startTeamInProject\}/);
  // 任务上下文分支：这张卡已经存在，再加团队只会冗余建卡，所以不接团队。
  const taskBranch = main.slice(main.indexOf("eyebrow={workspaceTask.workspaceName"), main.indexOf(") : workspaceProject ? ("));
  assert.ok(taskBranch.length > 0 && taskBranch.length < 800, "任务分支片段异常");
  assert.doesNotMatch(taskBranch, /teams=|onStartTeam|teamWorkspaceId/);
});

test("[T7] startDirect 只发 note + workspaceId，不发 cwd", () => {
  const body = stripComments(repositorySource);
  assert.match(body, /startDirect\(teamId: string, input: \{ note: string; workspaceId: string \}\)/);
  assert.match(body, /`\/api\/ai-teams\/\$\{encodeURIComponent\(teamId\)\}\/runs`/);
  assert.match(body, /jsonBody\(\{ note: input\.note, workspaceId: input\.workspaceId \}\)/);
  assert.doesNotMatch(body.slice(body.indexOf("startDirect"), body.indexOf("startDirect") + 420), /cwd/, "工作目录由服务端按项目解析");
  assert.match(body, /settle\(tone: "success" \| "error"\): Promise<void>/);
  assert.match(body, /tone === "error" \? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS/);
});

test("[T7] 开工的停留时长只从 motion-tokens 取，入口文件里没有字面毫秒", () => {
  for (const [rel, source] of [
    ["react/ai-teams/repository.ts", repositorySource],
    ["react/ai-teams/teams-page.tsx", teamPageSource],
    ["react/workspaces/host.tsx", hostSource],
    ["react/shell/shell-main-content.tsx", read("react/shell/shell-main-content.tsx")],
  ] as Array<[string, string]>) {
    assert.doesNotMatch(stripComments(source), /\b720ms|\b1500ms|\b720\b|\b1500\b/, `${rel} 不得写死 dwell 毫秒`);
  }
  assert.match(stripComments(repositorySource), /from "\.\.\/ui\/motion-tokens"/);
  // 团队页的展开收起一律 motion token（[T6] 已扫过全仓，这里再盯住新行）。
  assert.match(teamPageSource, /data-collapsed=\{!settled \|\| undefined\}/);
  assert.match(teamPageSource, /requestAnimationFrame/);
  assert.match(teamPageSource, /noteRef\.current\?\.focus\(\)/, "展开后光标自动落到说明框");
  assert.match(teamPageSource, /addEventListener\("pointerdown"/, "点行外收起");
  assert.match(teamPageSource, /event\.key !== "Escape"/, "Esc 收起");
});

test("[T7] 团队列表轻缓存：运行通知不失效，团队页保存才失效", () => {
  const body = stripComments(repositorySource);
  const list = body.slice(body.indexOf("list(): Promise<AiTeam[]>"), body.indexOf("async create"));
  assert.match(list, /if \(teamList\) return Promise\.resolve\(teamList\)/);
  assert.match(list, /if \(!teamListPending\)/, "并发只发一次请求");
  assert.match(list, /teamListPending = null/, "失败不留缓存");
  assert.equal(body.match(/teamList = null/g)?.length, 3, "只有 create/update/remove 各清一次");
  const notify = body.slice(body.indexOf("export function notifyAiTeamRunChanged"), body.indexOf("const runUrl"));
  assert.ok(notify.includes("subscribeAiTeamRunChanges"), "片段应是运行通知那两个函数");
  assert.doesNotMatch(notify, /teamList/, "ai-team-run 通知不重拉团队定义");
});

test("[T7] 团队页「直接开工」原位展开，提交期间禁点，结果不靠 Toast", () => {
  const projects = [
    { id: "g", name: "全局", cwd: "/tmp", kind: "global" },
    { id: "p1", name: "最近", cwd: "/repo/a", kind: "project" },
    { id: "p2", name: "另一个", cwd: "/repo/b" },
  ];
  assert.deepEqual(teamStartProjects(projects).map((project) => project.id), ["p1", "p2"]);
  assert.equal(defaultTeamStartProject(projects), "p1", "缺省最近一个");
  assert.equal(defaultTeamStartProject([{ id: "g", name: "全局", cwd: "/tmp", kind: "global" }]), "", "一个都没有 → 空串");
  assert.equal(defaultTeamStartProject([]), "");

  const row = teamPageSource.slice(teamPageSource.indexOf("function TeamStartRow"), teamPageSource.indexOf("/** 团队的运行记录"));
  assert.match(row, /const busy = phase === "sending" \|\| phase === "sent"/);
  assert.match(row, /if \(busy\) return/, "连点不再发第二次请求");
  assert.match(row, /disabled=\{busy\}/, "开关按钮只在提交中禁用：没有项目时也要能展开看到说明");
  assert.match(row, /disabled=\{busy \|\| !note\.trim\(\) \|\| !picked\}/, "缺项目或缺说明时不给提交");
  assert.match(row, /inert=\{!open\}/, "收起后不再可聚焦");
  assert.doesNotMatch(row, /alert\(|toast\(|wandOverlay/, "结果在原位，不弹窗");
  assert.match(row, /aiTeamsRepository\.settle\("success"\)[\s\S]*?onStarted\(started\)/, "先停够再导航");
  assert.match(row, /setPhase\("failed"\)/);
  assert.match(row, /还没有可开工的项目/, "一个都没有时原位提示先建项目");
});

test("[T7] 开工成功后落到 IM 群聊页，拿不到 chatSessionId 才退回团队页", () => {
  const after = teamPageSource.slice(teamPageSource.indexOf("const afterDirectRun"), teamPageSource.indexOf("return <section className=\"task-board-native-page wand-teams-page\""));
  assert.match(after, /started\.run\.chatSessionId/);
  assert.match(after, /onOpenSession\(sessionId\)/);
  assert.match(after, /setDetailTab\("runs"\)/);
  assert.match(after, /setFocusRunId\(started\.run\.id\)/, "兜底也要停在「团队页-该运行」，不静默");
  assert.match(teamPageSource, /if \(focusRunId\) setOpenId\(focusRunId\)/);
  // 另两个入口（团队开工弹窗、项目欢迎页）开团首屏统一进 IM 群聊页（teamchat，按 runId），兜底才是团队页。
  assert.match(hostSource, /taskBoardController\.open\("", "", "teamchat", started\.run\.id\)/);
  assert.match(hostSource, /else taskBoardController\.open\("", "", "teams"\)/);
  const main = read("react/shell/shell-main-content.tsx");
  assert.match(main, /taskBoardController\.open\("", "", "teamchat", started\.run\.id\)/);
  assert.match(main, /taskBoardController\.open\("", "", "teams"\)/);
  // S2：两条开团路径开页后各补一次 task-changes 通知，侧栏群聊徽标不必等 ~6s 轮询。
  assert.match(hostSource, /taskBoardController\.open\("", "", "teams"\);\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*notifyTasksChanged\(\);/, "开团弹窗补刷新");
  assert.match(main, /notifyTasksChanged\(\);/, "项目欢迎页补刷新");
  // S4：开工 notice 按有没有拿到 chatSessionId 分支措辞，退化到团队页时不再谎报"正在打开群聊"。
  assert.match(hostSource, /已开工，\$\{sessionId \? "正在打开群聊…" : "正在打开团队页…"}/);
});

// ---------- [T8] 群聊面板：三视图叠放、内嵌群聊、乐观临时行 ----------

const panelSource = read("react/issues/team-run-panel.tsx");
const chatSource = read("react/ai-teams/team-chat-view.tsx");
const chatStylesSource = read("react/ai-teams/styles.ts");
const chunkScriptSource = readFileSync(new URL("../scripts/ai-teams-chunk.js", import.meta.url), "utf8");

const userTurn = (text: string, createdAt: string): ConversationTurn => ({
  role: "user",
  content: [{ type: "text", text }],
  createdAt,
});
const localRow = (text: string, sentAt: number, unconfirmed = false): LocalChatTurn => ({
  local: true,
  text,
  sentAt,
  unconfirmed,
});

test("[T8] team-chat-view 进 chunk、主包不含它，借的模块靠注册表逐名同步", () => {
  assert.match(chunkScriptSource, /"ai-teams", "team-chat-view\.tsx"/, "CHUNK_FILES 没加新文件");
  assert.match(read("react/ai-teams/chunk-entry.ts"), /TeamChatView,/);
  // 主包侧只允许 lazy.tsx 以 import type 引它，别处一旦值引用就会被打回 scripts.js。
  const importers = tsSources(new URL("../src/web-ui/", import.meta.url))
    .filter((file) => /from "[^"]*team-chat-view"/.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(file.indexOf("src/web-ui/")).replace(/\/{2,}/g, "/"));
  assert.deepEqual(importers.sort(), [
    "src/web-ui/react/ai-teams/chunk-entry.ts",
    "src/web-ui/react/ai-teams/lazy.tsx",
    "src/web-ui/react/ai-teams/team-chat-page.tsx",
    "src/web-ui/react/issues/team-run-panel.tsx",
  ]);
  assert.match(read("react/ai-teams/lazy.tsx"), /import type \{ TeamChatViewProps \} from "\.\/team-chat-view";/);
  const lazy = read("react/ai-teams/lazy.tsx");
  const registry = lazy.slice(lazy.indexOf("const AI_TEAMS_HOST"), lazy.indexOf("};\n", lazy.indexOf("const AI_TEAMS_HOST")));
  assert.match(registry, /"http-adapter": \{ jsonBody, requestJson \}/, "群聊发送要的 http-adapter 没注册");
});

test("[T8] 三视图 tabs 以群聊为默认，切换走持久容器可见性、不 remount", () => {
  const compact = panelSource.replace(/\s+/g, " ");
  assert.match(compact, /const RUN_VIEWS = \[ \{ value: "chat", label: "群聊" \}, \{ value: "timeline", label: "时间线" \}, \{ value: "members", label: "按成员" \}, \]/);
  assert.match(panelSource, /React\.useState\("chat"\)/, "默认视图得是群聊（§11-Q4）");
  assert.match(panelSource, /<WandStretchTabs/, "tabs 复用 WandStretchTabs，不自造指示条");
  assert.doesNotMatch(panelSource, /key=\{view\}|key=\{activeView\}/, "禁止按视图 remount，退场元素会被卸载");
  assert.match(compact, /data-hidden=\{activeView !== tab\.value \|\| undefined\}/);
  assert.match(panelSource, /inert=\{activeView !== tab\.value\}/, "非当前视图不再可聚焦");
  assert.match(panelSource, /task-board-team-views-stack/);
  // 「打开群聊」按钮原样保留。
  assert.match(panelSource, /aiTeamsRepository|onOpenSession\(run\.chatSessionId!\)/);
  assert.match(panelSource, />\s*打开群聊\s*<\/WandButton>/);
});

test("[T8] 交叉淡入只引用 motion token，窄屏退回静态流式", () => {
  const block = chatStylesSource.slice(
    chatStylesSource.indexOf("/* ---------- 三视图叠放与内嵌群聊 ---------- */"),
    chatStylesSource.indexOf("/* 备用候选被跳原因"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(block.length > 300, "没切到叠放样式块");
  assert.doesNotMatch(block, /:[^;]*\b\d+(?:ms|s)\b/, "叠放样式里出现了裸时长");
  assert.match(block, /opacity var\(--motion-normal\) var\(--ease-in-out-smooth\)/, "进场走 normal + 平滑曲线");
  assert.match(block, /var\(--motion-quick-exit\)/, "退场要比进场快");
  const narrow = chatStylesSource.slice(chatStylesSource.indexOf("@media (max-width: 760px)"));
  assert.match(narrow.slice(0, narrow.indexOf("\n}")), /\.task-board-team-view\[data-hidden\] \{ display: none;/, "窄屏改隐藏非当前视图 + 静态流式");
  const reduced = chatStylesSource.slice(chatStylesSource.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced.slice(0, reduced.indexOf("\n}")), /\.task-board-team-view,\n/, "reduce-motion 下叠放退化瞬时");
});

test("[T8] 群聊输入走 messages 端点，请求体字段是 input 不是 text", () => {
  assert.equal(chatMessageUrl("s/1 x"), "/api/structured-sessions/s%2F1%20x/messages");
  assert.deepEqual(chatMessageBody("批准"), { input: "批准" });
  assert.equal(Object.hasOwn(chatMessageBody("批准"), "text"), false, "不能发 text 字段");
  assert.equal(Object.hasOwn(chatMessageBody("批准"), "interrupt"), false, "插话不带 interrupt");
  const body = stripComments(chatSource);
  assert.match(body, /requestJson\(chatMessageUrl\(sessionId\), jsonBody\(chatMessageBody\(text\)\)\)/);
  assert.doesNotMatch(body, /new WebSocket|\/ws\b|io\.sockets/, "不新增 WS 消息类型");
  assert.equal(chatInputHint("awaiting_approval"), "回复『批准』即开工，其他内容会作为修改意见转给负责人");
  assert.equal(chatInputHint("running"), "将作为插话，负责人下一轮看到");
  assert.equal(chatInputHint("done"), "发消息会接着这一轮的进度开新一轮", "跑完再说话是接着开新一轮，先说清行为");
  assert.equal(chatInputHint("stopped"), chatInputHint("done"));
  assert.equal(chatInputHint("failed"), chatInputHint("done"));
});

test("[T8] 群聊页按 chat 会话跟随新运行：接着开一轮后状态与步骤不停在旧的一轮", () => {
  const page = read("react/ai-teams/team-chat-page.tsx");
  assert.match(read("react/ai-teams/repository.ts"), /runsForChat\(taskId: string, chatSessionId: string\)/);
  assert.match(page, /runsForChat\(detail\.run\.taskId, chatSessionId\)/);
  assert.match(page, /taskBoardController\.open\("", "", "teamchat", newer\)/, "原地切到新运行（地址栏 replace）");
  assert.match(page, /change\.runId === runId \|\| \(taskId && change\.taskId === taskId\)/, "新运行的 runId 不同，得按任务 id 收通知");
  assert.match(page, /newerRunIdOnSameChat\(next\)/, "重拉时也判一次，不停在旧运行的 chatTurns 上");
  // 跟随只在同一个群聊会话内生效，别的 chat 不属于这一页。
  assert.match(page, /runs\.filter\(\(run\) => run\.chatSessionId === chatSessionId\)|sameChat\[0\]/);
});

test("[T8] 乐观临时行：确认靠 user 回合 + 发送时刻粗匹配，重拉失败留「未确认」", () => {
  const sentAt = Date.parse("2026-09-27T10:00:00.000Z");
  const row = localRow("把报告写短一点", sentAt);
  assert.equal(isConfirmedBy(userTurn("收到", new Date(sentAt + 500).toISOString()), sentAt), true);
  assert.equal(isConfirmedBy(userTurn("收到", new Date(sentAt - 1).toISOString()), sentAt), false, "早于发送时刻的是上一轮");
  assert.equal(isConfirmedBy({ role: "assistant", content: [{ type: "text", text: "好" }], createdAt: new Date(sentAt + 500).toISOString() }, sentAt), false);
  assert.equal(isConfirmedBy(userTurn("没有时刻", ""), sentAt), false, "没有 createdAt 不认");

  const turns = [userTurn("旧话", new Date(sentAt - 9e5).toISOString()), userTurn(row.text, new Date(sentAt + 300).toISOString())];
  assert.deepEqual(settleLocalTurns([row], turns), [], "服务端已回显 → 撤掉临时行");
  assert.deepEqual(settleLocalTurns([row], [userTurn("别的", new Date(sentAt - 9e5).toISOString())]), [row]);
  assert.deepEqual(settleLocalTurns([row], null), [localRow(row.text, sentAt, true)], "重拉失败 → 留着标未确认");
  assert.match(chatSource, /未确认/);
});

test("[T8] 群聊渲染对齐 chat-render 的类名，不复制色值也不自造气泡", () => {
  assert.match(chatSource, /className="chat-message chat-notice"/);
  assert.match(chatSource, /className="chat-notice-line"/, "降级 notice 走居中弱化行");
  assert.match(chatSource, /className="chat-message-avatar assistant chat-message-author"/);
  assert.match(chatSource, /className="chat-author-badge">负责人/);
  assert.match(chatSource, /issueAgentProviderLabel\(author\.provider\)/, "署名要带上该步实际用的 provider");
  assert.equal(chatTurnText(userTurn("第一行\n第二行", "")), "第一行\n第二行");
  for (const rel of ["react/ai-teams/team-chat-view.tsx"]) {
    assert.doesNotMatch(read(rel), /#[0-9a-f]{3,8}\b|rgba?\(|--[a-z-]+:\s/, `${rel} 不该定义颜色`);
  }
  const chatBlock = chatStylesSource.slice(
    chatStylesSource.indexOf(".task-board-team-chat {"),
    chatStylesSource.indexOf("/* 备用候选被跳原因"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(chatBlock, /#[0-9a-f]{3,8}\b|rgba?\(/, "群聊样式只能引用 token");
});

test("[T8] 时间线备用候选在原位展开被跳原因，收起是倒放", () => {
  assert.match(panelSource, /step\.dispatchInfo\?\.skipped \?\? \[\]/);
  assert.match(panelSource, /备用候选 \{skipped\.map/);
  assert.match(panelSource, /inert=\{!skippedOpen\}/);
  assert.doesNotMatch(panelSource, /wandOverlay|Toast|toast\(/, "被跳原因在原位，不弹窗");
  const skipBlock = chatStylesSource.slice(chatStylesSource.indexOf("/* 备用候选被跳原因"), chatStylesSource.indexOf("@media (max-width: 760px)"));
  assert.match(skipBlock, /grid-template-rows: 0fr/);
  assert.match(skipBlock, /var\(--motion-normal\)/);
  assert.doesNotMatch(skipBlock, /:[^;]*\b\d+(?:ms|s)\b/, "展开时长必须是 token");
});

// ---------- [T8] 群聊分层：主任务 / 子任务 ----------

const assistantTurn = (
  text: string,
  author: { id: string; name: string; leader?: boolean; provider?: string } | null,
  extra: Partial<ConversationTurn> = {},
): ConversationTurn => ({
  role: "assistant",
  content: [{ type: "text", text }],
  author: author ?? undefined,
  ...extra,
});

test("[T8] 群聊按发言人分层：notice / 用户 / 主任务（负责人）/ 子任务（成员）", () => {
  assert.equal(chatTurnKind(assistantTurn("团队已停止", null, { notice: true })), "notice");
  assert.equal(chatTurnKind(userTurn("插一句", "")), "user");
  assert.equal(chatTurnKind(assistantTurn("计划", { id: "m_lead", name: "负责人", leader: true })), "leader");
  assert.equal(chatTurnKind(assistantTurn("报告", { id: "m_dev", name: "实现者" })), "step");
  assert.equal(chatTurnKind(assistantTurn("没署名的旧消息", null)), "step", "旧运行没有 author，当成员层降级渲染");
});

test("[T8] 子任务报告识别状态前缀，主任务派工拆成任务条目", () => {
  assert.deepEqual(parseStepReport("✅ 完成「T1 类型与存储迁移」\n\n状态: 完成\n改了 src/a.ts"), {
    ok: true, title: "T1 类型与存储迁移", body: "状态: 完成\n改了 src/a.ts",
  });
  assert.deepEqual(parseStepReport("❌ 没完成「T3 验收」\n\n不通过"), { ok: false, title: "T3 验收", body: "不通过" });
  assert.equal(parseStepReport("普通发言"), null);
  assert.equal(parseStepReport("实现者 开始「T1」"), null, "开始 notice 不带状态前缀");

  const plan = splitLeaderMessage([
    "本轮先做后端，再做前端。",
    "",
    "1. **@实现者** T1 类型与存储迁移",
    "2. **@审查者** T1 验收（等第 1 项完成后）",
  ].join("\n"));
  assert.equal(plan.head, "本轮先做后端，再做前端。");
  assert.deepEqual(plan.assignments, [
    { member: "实现者", title: "T1 类型与存储迁移", wait: "" },
    { member: "审查者", title: "T1 验收", wait: "等第 1 项完成后" },
  ]);
  const ask = splitLeaderMessage("这一步需要你拍板：用哪个目录？");
  assert.equal(ask.head, "这一步需要你拍板：用哪个目录？");
  assert.deepEqual(ask.assignments, [], "没有清单就不是计划卡，照常当正文渲染");
});

test("[T8] 只有长报告才折叠，短报告原地铺开", () => {
  assert.equal(needsCollapse("短报告"), false);
  assert.equal(needsCollapse("行\n".repeat(5)), false);
  assert.equal(needsCollapse("行\n".repeat(9)), true, "超过 6 行就折");
  assert.equal(needsCollapse("啊".repeat(421)), true, "超长单行也折");
});

test("[T8] 群聊样式：主任务钉顶、子任务带导轨与状态色、展开走 token 且 reduce-motion 退化", () => {
  const chatBlock = chatStylesSource.slice(
    chatStylesSource.indexOf("/* 「主任务」"),
    chatStylesSource.indexOf("/* 备用候选被跳原因"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(chatBlock, /\.team-chat-goal \{/, "主任务公告位");
  assert.match(chatBlock, /\.team-chat-goal-label \{/, "主任务标签");
  assert.match(chatBlock, /\.team-chat-step \{/, "子任务块");
  assert.match(chatBlock, /\.team-chat-step\[data-status="running"\]/, "子任务按状态上色");
  assert.match(chatBlock, /\.team-chat-plan-list li \{/, "派工清单是一组任务条目");
  assert.match(chatBlock, /\.team-chat-step-body,[\s\S]*grid-template-rows: 0fr/, "收起是倒放");
  assert.match(chatBlock, /var\(--transition-normal\)/);
  assert.doesNotMatch(chatBlock, /\b(?:\d+(?:\.\d+)?)(?:ms|s)\b/, "新的群聊样式不得写死时长");
  assert.doesNotMatch(chatBlock, /#[0-9a-f]{3,8}\b|rgba?\(/, "只能引用 token");
  const reduced = chatStylesSource.slice(chatStylesSource.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.team-chat-step-body,/);
  assert.match(reduced, /\.team-chat-goal-body,/);
  // 主任务与子任务必须渲染成两个不同层，而不是同一个气泡换个名字。
  assert.match(chatSource, /className="team-chat-goal"/);
  assert.match(chatSource, /className="chat-message assistant team-chat-step"/);
  assert.match(chatSource, /className="chat-message assistant chat-message-lead team-chat-plan"/);
  assert.match(chatSource, /className="team-chat-expand"/);
  assert.match(chatSource, /aria-expanded=\{expanded\}/);
});
