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
  agentSignatureLabel,
  CHAT_INPUT_PLACEHOLDER,
  chatInputHint,
  teamChatComposerMode,
  teamRunIsActive,
  chatMessageBody,
  chatMessageUrl,
  chatTurnKind,
  chatTurnText,
  isConfirmedBy,
  isFollowingTail,
  liveOmittedText,
  liveStateLabel,
  LIVE_EMPTY_TEXT,
  mergeLiveRows,
  MOTION_QUICK_EXIT_VAR,
  needsCollapse,
  orderLiveSteps,
  parseMotionDurationMs,
  parseStepReport,
  pruneExpiredLeaving,
  settleLocalTurns,
  shouldFollowTail,
  splitLeaderMessage,
  type LocalChatTurn,
} from "../src/web-ui/react/ai-teams/team-chat-view.js";
import type { AiTeamLiveStep } from "../src/ai-team-types.js";
import { memberCoatIndex, CAT_COATS } from "../src/web-ui/react/ai-teams/avatar.js";
import { normalizeWandModelCatalog } from "../src/web-ui/react/model-catalog.js";
import { taskBoardPageOf, taskBoardSearch, isTaskBoardView } from "../src/web-ui/react/issues/task-board-controller.js";
import { aiTeamsChunkStyles } from "../src/web-ui/react/ai-teams/styles.js";
import type { AiTeam, AiTeamMember, AiTeamRun } from "../src/ai-team-types.js";
import type { ConversationTurn } from "../src/types.js";
import type { WandTaskAgent } from "../src/task-types.js";

const read = (rel: string): string => readFileSync(new URL(`../src/web-ui/${rel}`, import.meta.url), "utf8");

/** 目录快照桩：Claude 配了默认模型 opus，Codex 没配（默认名由 CLI 自己报在目录项里）。 */
const defaultCatalog = normalizeWandModelCatalog({
  models: [{ id: "default", label: "跟随 Claude Code 默认" }, { id: "opus", label: "opus（最新 Opus）" }],
  defaultModels: { claude: "opus" },
});
const unconfiguredCatalog = normalizeWandModelCatalog({
  codexModels: [{ id: "default", label: "GPT-6-Astra · gpt-6-astra（Codex 默认）" }],
});

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

test("团队页与群聊页头部：返回箭头只在列表态出现，收起交给面包屑", () => {
  const teams = read("react/ai-teams/teams-page.tsx");
  // 未选中团队时页面标题是「AI 团队」，退出靠箭头；选中后同一功能只留面包屑首段，箭头必须收起。
  assert.match(teams, /\{!selected \? <WandIconButton[\s\S]{0,160}aria-label="返回工作区"/);
  assert.match(teams, /\{ label: "AI 团队", onNavigate: \(\) => \{ void leaveDetail\(\); \} \}/);
  assert.doesNotMatch(teams, /\{selected \? <WandIconButton/);

  const chat = read("react/ai-teams/team-chat-page.tsx");
  // 群聊页是页面级面包屑（variant="title"，末段即 h1），首段回任务看板；箭头的落点不同（回进入前的会话），
  // 所以两个出口都保留，但文案要跟着落点走，不再写「返回工作区」。
  assert.match(chat, /<WandBreadcrumb\n\s*variant="title"\n\s*className="wand-team-chat-crumb"/);
  assert.match(chat, /\{ label: "任务看板", onNavigate: \(\) => taskBoardController\.open\("", "", "board"\) \}/);
  assert.match(chat, /aria-label="返回上一会话"/);
  assert.doesNotMatch(chat, /aria-label="返回工作区"/);
  // 「完整会话记录」只在真的挂了 chat 会话、且外层给了打开会话的回调时才出现，避免点了没反应的死按钮。
  assert.match(chat, /\{detail\.run\.chatSessionId && onOpenSession \? <WandButton/);
  assert.match(chat, /onOpenSession\(detail\.run\.chatSessionId!\)/);
  // 独立群聊页头部就能停：滚动看消息时输入栏可能不在视野里，顶栏这枚始终在。
  assert.match(chat, /teamRunIsActive\(detail\.run\.status\) \? <WandButton/);
  assert.match(chat, /aiTeamsRepository\.stop\(detail\.run\.id\)/);
  assert.match(chat, /aria-label="停止团队"/);
  // 群聊页用的是 title 变体，样式里不该再留 compact 变体的死选择器。
  const chatStyles = read("react/ai-teams/styles.ts");
  assert.doesNotMatch(chatStyles, /\.wand-team-chat-crumb\.is-compact/);
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
  assert.match(read("scripts.ts"), /\.replace\("\$\{aiTeamsChunkSrc\}", `\/assets\/ai-teams\.js\?v=\$\{chunkHash\}`\)/);
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

// chunk 的 CSS 要等按需脚本到位才注入（chunk-entry.ts 先 installStyleSheet 再导出组件）。
// 所以真正的硬约束不是「主包不许出现这些类名」，而是「主包出现的每一个 chunk 类名，主包样式池里
// 必须另有定义」—— 否则就会有一帧「节点已渲染、样式还没到」。
// 下面这份共享清单是当前事实（团队页头像两处都用），它由断言算出来，不是手工豁免。
const SHARED_CHUNK_CLASSES = [
  "task-board-create-button",
  "wand-stretch-tabs",
  "wand-settings-save-bar",
  "wand-team-avatar",
  "wand-team-avatar-cat",
  "wand-team-avatar-stack",
  "wand-team-coat",
].sort();

/** 整词匹配类名：既不让 `wand-teams-list` 冒充 `wand-teams-list-head`，也认 CSS 里的 `.name` 写法。 */
function mentionsClass(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(source);
}

test("[T8] 主包用到的 chunk 类名必须在主包样式池里另有定义", () => {
  const chunkClasses = [...new Set(
    [...aiTeamsChunkStyles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([A-Za-z][\w-]*)/g)].map((hit) => hit[1]!),
  )];
  assert.ok(chunkClasses.length > 100, `只枚举到 ${chunkClasses.length} 个类名，枚举方式可能失效`);

  // tsSources 拼路径会留下重复斜杠（和上面那条 importers 断言同款），归一化后再比。
  const relOf = (file: string): string =>
    file.slice(file.indexOf("/src/web-ui/") + "/src/web-ui/".length).replace(/\/{2,}/g, "/");
  const chunkFiles = new Set(
    [...chunkScriptSource.matchAll(/path\.join\(REACT_ROOT, "([^"]+)", "([^"]+)"\)/g)]
      .map((hit) => `react/${hit[1]}/${hit[2]}`),
  );
  assert.ok(chunkFiles.has("react/ai-teams/chunk-entry.ts"), "CHUNK_FILES 写法变了，这条断言要一起改");
  assert.ok(chunkFiles.has("react/ai-teams/styles.ts"), "chunk 样式模块没在 CHUNK_FILES 里");

  // 主包 = src/web-ui/react/** 去掉 CHUNK_FILES。注意不能整目录排除 ai-teams：
  // avatar.tsx / cat-coats.ts / lazy.tsx 都在主包里，只有那 6 个文件跟着按需脚本走。
  const mainSources = tsSources(new URL("../src/web-ui/react/", import.meta.url))
    .filter((file) => !chunkFiles.has(relOf(file)));
  const shared = chunkClasses
    .filter((name) => mainSources.some((file) => mentionsClass(readFileSync(file, "utf8"), name)))
    .sort();
  assert.deepEqual(shared, SHARED_CHUNK_CLASSES,
    "主包与 chunk 共用的类名变了：新增的一律要在主包样式池里补定义，并同步这份清单");

  const mainSheets = [
    read("content/styles.css"),
    ...tsSources(new URL("../src/web-ui/react/styles/", import.meta.url)).map((file) => readFileSync(file, "utf8")),
  ].join("\n");
  const unstyled = shared.filter((name) => !mentionsClass(mainSheets, name));
  assert.deepEqual(unstyled, [],
    `这些类名主包组件在用、样式却只在 /assets/ai-teams.js 里：${unstyled.join(", ")}（首帧会裸样式）`);
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

test("群聊输入栏发送 ⇄ 停止：未结束的运行占发送的位置，有草稿时两者并排", () => {
  assert.equal(teamRunIsActive("running"), true);
  assert.equal(teamRunIsActive("awaiting_approval"), true);
  assert.equal(teamRunIsActive("waiting_user"), true);
  assert.equal(teamRunIsActive("done"), false);
  assert.equal(teamRunIsActive("stopped"), false);
  assert.equal(teamRunIsActive("failed"), false);
  assert.equal(teamChatComposerMode("running", false), "stop");
  assert.equal(teamChatComposerMode("awaiting_approval", false), "stop");
  assert.equal(teamChatComposerMode("waiting_user", false), "stop");
  assert.equal(teamChatComposerMode("running", true), "send-and-stop");
  assert.equal(teamChatComposerMode("done", true), "send");
  assert.equal(teamChatComposerMode("stopped", false), "blocked");
  assert.equal(teamChatComposerMode("failed", false), "blocked");
  assert.equal(teamChatComposerMode("running", false, "send"), "send-and-stop", "发送中清掉草稿仍留发送按钮");
  assert.equal(teamChatComposerMode("done", false, "send"), "send");
  const body = stripComments(chatSource);
  assert.match(body, /composerMode === "send-and-stop" \|\| composerMode === "stop"/);
  assert.match(body, /aiTeamsRepository\.stop\(run\.id\)/);
  assert.match(body, /aria-label="停止团队"/);
  assert.match(body, /composerMode === "stop" \? null : <WandButton/, "空草稿时发送让位给停止，不占第二枚按钮");
});

test("[T8] 群聊输入框占位文案不等于任何引导语：空输入框同一句话只显示一遍", () => {
  const hints = ["awaiting_approval", "running", "done", "stopped", "failed"]
    .map((status) => chatInputHint(status as AiTeamRun["status"]))
    .filter((hint) => hint !== "");
  assert.ok(hints.length >= 4, "引导语覆盖的状态要有样本");
  for (const hint of hints) {
    assert.notEqual(CHAT_INPUT_PLACEHOLDER, hint, `placeholder 不能顶掉引导语（${hint}）`);
  }
  const body = stripComments(chatSource);
  assert.match(body, /placeholder=\{CHAT_INPUT_PLACEHOLDER\}/);
  assert.doesNotMatch(body, /placeholder=\{hint/, "placeholder 不再复用引导语，否则同一句话显示两遍");
  assert.match(body, /className="task-board-team-chat-hint"/, "引导语仍走 <p>，「回复『批准』即开工」要一直看得见");
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
  assert.match(chatSource, /const signature = agentSignatureLabel\(author \?\? \{\}, catalog\);/, "署名走同一个标签函数：provider + 模型 + 思考深度");
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

const liveStep = (over: Partial<AiTeamLiveStep> & { stepId: string; seq: number }): AiTeamLiveStep => ({
  memberId: "m_impl",
  memberName: "实现者",
  provider: "claude",
  sessionId: `sess_${over.stepId}`,
  state: "working",
  text: "开始读文件",
  omittedChars: 0,
  updatedAt: "2026-09-27T10:00:00.000Z",
  ...over,
});

test("[live] 状态芯片与提示文案：等人才说话，空文本不留白框", () => {
  assert.equal(liveStateLabel("needs_permission"), "等待授权");
  assert.equal(liveStateLabel("needs_input"), "等待回答");
  assert.equal(liveStateLabel("working"), "工作中");
  assert.equal(liveStateLabel(undefined), "", "未知状态不给芯片");
  assert.equal(liveOmittedText(0), "", "没截断就不提示");
  assert.equal(liveOmittedText(431), "已省略前面 431 字");
  assert.equal(LIVE_EMPTY_TEXT, "已开始，等待第一段输出…");
});

test("[live] 贴尾判定与排序去重：用户上滚以后不把他拽回尾部", () => {
  assert.equal(shouldFollowTail(0, 400, 200), false, "在中间看历史");
  assert.equal(shouldFollowTail(200, 400, 200), true, "正好贴底");
  assert.equal(shouldFollowTail(176, 400, 200), true, "距底 24px 以内仍跟随");
  assert.equal(shouldFollowTail(175, 400, 200), false, "超过阈值就不跟随");
  const ordered = orderLiveSteps([liveStep({ stepId: "s3", seq: 3 }), liveStep({ stepId: "s1", seq: 1 }), liveStep({ stepId: "s1b", seq: 1 })]);
  assert.deepEqual(ordered.map((step) => step.stepId), ["s1", "s1b", "s3"], "按 seq 升序");
  assert.deepEqual(orderLiveSteps([liveStep({ stepId: "s1", seq: 1 }), liveStep({ stepId: "s1", seq: 2 })]).length, 1, "同一 stepId 只留一行");
});

test("[live] merge 只按 seq 排：退场行留在原位，不被搬到尾部", () => {
  const now = 1_000;
  const base = mergeLiveRows([], [
    liveStep({ stepId: "a", seq: 1 }), liveStep({ stepId: "b", seq: 2 }), liveStep({ stepId: "c", seq: 3 }),
  ], now);
  // a 收工、b/c 还在输出。a 本来就在最前面：排序不看 leaving，不能被搬到尾部
  // （DOM move 会让没播完的收工动画重播一次并且位置跳动）。
  const rows = mergeLiveRows(base, [liveStep({ stepId: "b", seq: 2 }), liveStep({ stepId: "c", seq: 3 })], now + 50);
  assert.deepEqual(rows.map((row) => [row.step.stepId, row.leaving]), [["a", true], ["b", false], ["c", false]],
    "退场行前面还有 active 行时也不被搬走");
  assert.equal(rows[0]!.leavingSince, now + 50, "刚开始退场的行按这一批推送的时刻起算");
  assert.equal(rows[1]!.leavingSince, 0, "还在输出的行没有退场时刻");
  // 同一批内再来一次推送：位置一个都不交换。
  const again = mergeLiveRows(rows, [liveStep({ stepId: "b", seq: 2 }), liveStep({ stepId: "c", seq: 3 })], now + 90);
  assert.deepEqual(again.map((row) => row.step.stepId), rows.map((row) => row.step.stepId), "新一轮推送不产生位置交换");
  assert.equal(again[0]!.leavingSince, now + 50, "已经在退场的行不被新推送续命");
  // 中间行退场也留在中间，不被前面的 active 行顶到后面。
  const middle = mergeLiveRows(base, [liveStep({ stepId: "a", seq: 1 }), liveStep({ stepId: "c", seq: 3 })], now + 10);
  assert.deepEqual(middle.map((row) => [row.step.stepId, row.leaving]), [["a", false], ["b", true], ["c", false]]);
  // 全部消失也保持原顺序（旧断言里「新行在前」的口径已作废）。
  assert.deepEqual(mergeLiveRows(rows, []).map((row) => row.step.stepId), ["a", "b", "c"], "退场行按 seq 留在原位");
  // 同一步又开工就取消退场、不出现两行，起算时刻归零。
  assert.deepEqual(
    mergeLiveRows(rows, [
      liveStep({ stepId: "a", seq: 1 }), liveStep({ stepId: "b", seq: 2 }), liveStep({ stepId: "c", seq: 3 }),
    ], now + 200).map((row) => [row.step.stepId, row.leaving, row.leavingSince]),
    [["a", false, 0], ["b", false, 0], ["c", false, 0]],
  );
});

test("[live] 退场兜底：时长取自动效 token，后台标签页攒下的退场行回可见时摘掉", () => {
  assert.equal(parseMotionDurationMs("90ms"), 90);
  assert.equal(parseMotionDurationMs(" 0.09s "), 90, "秒写法换算成毫秒");
  assert.equal(parseMotionDurationMs("1.5s"), 1500);
  assert.equal(parseMotionDurationMs(""), null, "读不到 token 就不挂兜底定时器");
  assert.equal(parseMotionDurationMs("fast"), null, "不合法值不当成 0 毫秒（会把动画腰斩）");
  const now = 5_000;
  const rows = mergeLiveRows(
    mergeLiveRows([], [liveStep({ stepId: "a", seq: 1 }), liveStep({ stepId: "b", seq: 2 })], now),
    [liveStep({ stepId: "b", seq: 2 })],
    now,
  );
  assert.equal(pruneExpiredLeaving(rows, now + 89, 90), rows, "没到退场时长的一行都不摘");
  assert.equal(pruneExpiredLeaving(rows, now + 89, 90) === rows, true, "没摘就不换引用，免得白重渲染");
  assert.deepEqual(pruneExpiredLeaving(rows, now + 90, 90).map((row) => row.step.stepId), ["b"],
    "到点的退场行摘掉，还在输出的留下");
  const retired = pruneExpiredLeaving(rows, now + 90, 90);
  assert.equal(pruneExpiredLeaving(retired, now + 5_000, 90), retired, "已经没有退场行就原样返回");
  // 组件侧：兜底定时器、animationend、可见性恢复三处都走同一个幂等摘除。
  assert.match(chatSource, /const retireMs = liveExitDurationMs\(\);/, "兜底时长从动效 token 读");
  assert.match(chatSource, /getPropertyValue\(MOTION_QUICK_EXIT_VAR\)/);
  assert.match(chatSource, /Math\.max\(0, row\.leavingSince \+ retireMs - now\)/, "按每行自己的起算时刻兜底，不被新推送续命");
  assert.match(chatSource, /setLiveRows\(\(current\) => dropRetiredRow\(current, row\.step\.stepId\)\)/);
  assert.match(chatSource, /onRetire=\{\(stepId\) => setLiveRows\(\(current\) => dropRetiredRow\(current, stepId\)\)\}/,
    "animationend 与兜底定时器共用同一个摘除函数");
  assert.match(chatSource, /document\.addEventListener\("visibilitychange", onVisible\)/, "回到可见补一次清理");
  assert.doesNotMatch(chatSource, /setTimeout\(\s*\(\) => setLiveRows[\s\S]{0,140}\d{2,}\)/, "兜底时长不写字面毫秒");
  // 兜底读的 token 必须正是退场动画用的那一个，否则两边会漂到不同时长。
  assert.ok(read("react/ai-teams/styles.ts").includes(MOTION_QUICK_EXIT_VAR),
    "styles.ts 的退场动画与 JS 兜底共用同一个动效 token");
});

test("[live] 换一次运行就重新从尾部开始跟随（与 Android remember(runId) 同口径）", () => {
  // 上一轮里用户上滚过 → ref 停在 false；不换 run.id 时不重置，新页面一进来就不跟随。
  assert.match(
    chatSource,
    /setLocal\(\[\]\);\s*setDraft\(""\);\s*setError\(""\);\s*setPending\(""\);\s*(?:\/\/[^\n]*\n\s*)?listPinnedRef\.current = true;\s*\}, \[run\.id\]\);/,
    "重置点在按 run.id 的 effect 里",
  );
});

test("[live] 外层列表与卡片同一套贴底口径：上滚看历史不被 live 行拽到底", () => {
  assert.equal(isFollowingTail({ scrollTop: 175, scrollHeight: 400, clientHeight: 200 }), false, "距底 25px 不算贴底");
  assert.equal(isFollowingTail({ scrollTop: 176, scrollHeight: 400, clientHeight: 200 }), true, "距底 24px 仍贴底");
  assert.equal(isFollowingTail({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }), false, "看历史时不跟随");
  assert.match(chatSource, /listPinnedRef\.current = isFollowingTail\(event\.currentTarget\)/, "外层列表的贴底状态由滚动算出来");
  assert.match(chatSource, /if \(!list \|\| !listPinnedRef\.current\) return;/, "行数变了也不无条件拉底");
  assert.doesNotMatch(chatSource, /if \(list\) list\.scrollTop = list\.scrollHeight;/, "旧的无条件拉底已经去掉");
  assert.match(chatSource, /listPinnedRef\.current = true;/, "自己发消息算一次明确的回到底部");
});

test("[署名] CLI · 模型 · 思考深度：三处共用一个函数，缺字段只剩 provider", () => {
  assert.equal(agentSignatureLabel({ provider: "qoder", model: "Qwen3.8-Flash", thinkingEffort: "max" }), "Qoder · Qwen3.8-Flash · 最大");
  // `default` 是「跟随服务端默认」的哨兵值、不是模型名：有目录就换成服务端默认模型的名字。
  assert.equal(agentSignatureLabel({ provider: "claude", model: "default", thinkingEffort: "off" }, defaultCatalog), "Claude · opus · 关闭",
    "default 解析成服务端配置的默认模型，不写「默认模型」");
  assert.equal(agentSignatureLabel({ provider: "claude", model: "default", thinkingEffort: "off" }), "Claude · 关闭",
    "目录还没到时只省略模型段，不冒出「默认」");
  assert.equal(agentSignatureLabel({ provider: "codex", model: "default" }, unconfiguredCatalog), "Codex · GPT-6-Astra · gpt-6-astra",
    "没配默认模型时用 CLI 报出来的默认项名字");
  assert.equal(agentSignatureLabel({ provider: "codex", model: "gpt-5.2", thinkingEffort: "deep" }), "Codex · gpt-5.2 · 深入");
  assert.equal(agentSignatureLabel({ provider: "opencode", model: "  ", thinkingEffort: "opencode:minimal" }), "OpenCode · 最低",
    "CLI 原生档位走 compactThinkingLabel");
  assert.equal(agentSignatureLabel({ provider: "pi" }), "Pi", "老服务端没有 model / effort 时只剩 provider");
  assert.equal(agentSignatureLabel({ provider: null, model: null, thinkingEffort: null }), "", "全缺就不给芯片");
  assert.equal(agentSignatureLabel({ model: "glm-4.7" }), "glm-4.7", "只有模型也不能冒出前导分隔符");
  assert.doesNotMatch(agentSignatureLabel({ provider: "claude", model: undefined, thinkingEffort: undefined }), /undefined|·\s*$|\s·/, "不出现 undefined 或多余分隔符");
  // 三处署名（live 卡头部、成员步骤行、负责人行）都走这个函数，不允许各自拼文案。
  assert.equal(chatSource.match(/agentSignatureLabel\(/g)?.length, 4, "定义 1 处 + 调用 3 处");
  assert.equal(chatSource.match(/agentSignatureLabel\([^)]*, catalog\)/g)?.length, 3, "三处调用都带上目录，才能把 default 换成具体模型名");
  assert.doesNotMatch(chatSource, /\{issueAgentProviderLabel\(step\.provider\)\}/, "live 卡不再单独拼 provider");
});

test("[live] 数据接进来：GET /live 一次 + 只吃 ai-team-step-live 推送，不轮询", () => {
  const repo = read("react/ai-teams/repository.ts");
  const ws = read("browser/websocket.ts");
  assert.match(repo, /aiTeamLive\(runId: string\)[\s\S]*?runUrl\(runId, "\/live"\)/);
  assert.match(repo, /export function notifyAiTeamStepLive/);
  assert.match(repo, /export function subscribeAiTeamStepLive/);
  // lazy.tsx 的注册表名单不含 live 函数，所以 chunk 只经 aiTeamsRepository 对象借到它们。
  assert.match(repo, /live: aiTeamLive,\n  subscribeAiTeamStepLive,/);
  assert.match(chatSource, /aiTeamsRepository\.subscribeAiTeamStepLive\(/);
  assert.match(ws, /msg\.data\.kind === "ai-team-step-live"[\s\S]*?notifyAiTeamStepLive/);
  assert.doesNotMatch(chatSource, /setInterval|setTimeout\([^)]*live/i, "live 不引入轮询");
});

test("[live] 正在输出的成员：chatTurns 之后追加定尺寸内滚卡，整卡可点可键盘", () => {
  assert.match(chatSource, /React\.useEffect\(\(\) => \{\s*setLiveRows\(\[\]\);\s*if \(!running\) return undefined;/, "运行结束或换运行就清空");
  assert.match(chatSource, /if \(!alive \|\| update\.runId !== run\.id\) return;/, "只吃本次运行的推送");
  assert.match(chatSource, /\{liveRows\.map\(\(row\) => <LiveStepRow/, "live 行在 chatTurns 之后");
  assert.match(chatSource, /state=\{detail\.memberStates\[row\.step\.sessionId\]\}/, "状态芯片取 detail 的实时状态");
  assert.match(chatSource, /title=\{steps\.find\(\(step\) => step\.id === row\.step\.stepId\)\?\.title/, "步骤芯片「#seq 标题」查本次运行的步骤");
  assert.match(chatSource, /className="team-chat-live-card"\s*\n\s*role="button"\s*\n\s*tabIndex=\{0\}/, "整卡是键盘可达的按钮");
  assert.match(chatSource, /if \(event\.key !== "Enter" && event\.key !== " "\) return;/);
  assert.match(chatSource, /if \(window\.getSelection\(\)\?\.toString\(\)\) return;/, "选中正文复制不算点开");
  assert.match(chatSource, /LIVE_CARD_DRAG_PX/, "卡片内拖动滚动不算点开");
  assert.match(chatSource, /pinnedRef\.current = isFollowingTail\(/, "只有贴尾才跟随最新一行");
  assert.match(chatSource, /onOpenSession\(step\.sessionId\)/, "点击进成员会话，复用群聊页跳转路径");
  assert.match(chatSource, /aria-label=\{`打开\$\{step\.memberName\}正在输出的会话`\}/, "读屏只报名字与动作，不整段朗读正文");
  assert.match(chatSource, /if \(row\.leaving && event\.target === event\.currentTarget\) onRetire\(step\.stepId\);/,
    "退场只认这一行自己的动画，头名/卡片分两段进场的 animationend 会冒泡上来");
});

test("[live] 卡片样式：宽高等于收起时也一样，窄屏不缩高，动画只取 token", () => {
  const block = chatStylesSource.slice(
    chatStylesSource.indexOf("/* ---------- 正在输出的成员"),
    chatStylesSource.indexOf("/* 主任务层：负责人决策"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(block, /\.team-chat-live-card \{[\s\S]*?max-width: 560px;/);
  assert.match(block, /\.team-chat-live-card \{[\s\S]*?height: 200px;/);
  assert.match(block, /\.team-chat-live-text \{[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior-y: contain;/, "内部滚动且不抢外层");
  assert.match(block, /font-family: var\(--font-mono\)/, "等宽");
  assert.match(block, /@keyframes wand-team-live-grow \{\s*from \{ opacity: 0; transform: translateX\(-10px\); \}/, "从头像方向长出");
  assert.match(block, /\.team-chat-live-row\[data-leaving\] \{\s*animation: wand-team-live-grow var\(--motion-quick-exit\) var\(--ease-in-out-smooth\) reverse forwards;/, "收起是同一段动画倒放，且快于进场");
  // 两段式进场（负责人拍板，与 Android 同拍）：头像 + 名字行先来，卡片隔一拍再长出。
  assert.match(block, /\.team-chat-live-head \{[\s\S]*?animation: wand-team-live-grow var\(--motion-fast\) var\(--ease-out-expo\) both;/, "第一段：头名");
  assert.match(block, /\.team-chat-live-card \{[\s\S]*?animation: wand-team-live-grow var\(--motion-normal\) var\(--ease-out-expo\) both;[\s\S]*?animation-delay: var\(--motion-fast\);/, "第二段：卡片晚一拍，延迟取自 token");
  assert.doesNotMatch(block, /\.team-chat-live-row \{[^}]*animation:/, "整行不再同帧原子插入");
  assert.doesNotMatch(block, /\b(?:\d+(?:\.\d+)?)(?:ms|s)\b/, "不得写死时长");
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/, "只能引用 token");
  const narrow = chatStylesSource.slice(
    chatStylesSource.indexOf("@media (max-width: 760px)"),
    chatStylesSource.indexOf("@media (prefers-reduced-motion"),
  );
  assert.doesNotMatch(narrow, /team-chat-live/, "窄屏不改卡片高度");
  const reduced = chatStylesSource.slice(chatStylesSource.indexOf("@media (prefers-reduced-motion"));
  assert.match(reduced, /\.team-chat-live-head,\s*\.team-chat-live-card \{ animation-delay: 0s; \}/,
    "reduce-motion 下两段都瞬时：全局规则只压时长，延迟在这里归零");
});

test("团队详情：草稿未保存时，每个离开入口都先确认，取消不丢", () => {
  const teams = read("react/ai-teams/teams-page.tsx");
  // 编辑器只上报一个布尔，宿主用 ref 接，避免每次击键重渲染整页。
  assert.match(teams, /const teamDraftDirty = React\.useRef\(false\);/);
  assert.match(teams, /const dirty = React\.useMemo\(\(\) => JSON\.stringify\(draft\) !== initialKey/);
  assert.match(teams, /React\.useEffect\(\(\) => \{ onDirtyChange\?\.\(dirty\); \}, \[dirty, onDirtyChange\]\);/);
  // 三个入口共用同一段守卫：面包屑父段、「新建团队」收起、「换一个模板」。
  assert.match(teams, /const confirmDiscardTeamDraft = async \(\): Promise<boolean> => \{\s*if \(!teamDraftDirty\.current\) return true;/);
  assert.match(teams, /const leaveDetail = async \(\): Promise<void> => \{\s*if \(!await confirmDiscardTeamDraft\(\)\) return;/);
  assert.match(teams, /\{ label: "AI 团队", onNavigate: \(\) => \{ void leaveDetail\(\); \} \}/);
  assert.match(teams, /onClick=\{\(\) => \(creating \? void leaveDetail\(\) : void startCreate\(\)\)\}/);
  assert.match(teams, /aria-label="换一个模板" onClick=\{\(\) => \{ void backToTemplates\(\); \}\}/);
  assert.doesNotMatch(teams, /onClick=\{\(\) => setTemplate\(null\)\}/);
  assert.doesNotMatch(teams, /creating \? setSelectedId\(""\)/);
  // 左侧列表换人也是「离开当前详情」：详情面板按 selectedId 挂 key，直接切会静默卸载未保存的编辑器。
  assert.match(teams, /const selectTeam = async \(teamId: string\): Promise<void> => \{\s*if \(teamId === selectedId\) return;\s*if \(!await confirmDiscardTeamDraft\(\)\) return;/);
  assert.match(teams, /onClick=\{\(\) => \{ void selectTeam\(team\.id\); \}\}/);
  assert.doesNotMatch(teams, /onClick=\{\(\) => setSelectedId\(team\.id\)\}/, "列表项不再有绕过确认的直连入口");
  // Esc 与面包屑同路；leaveDetail 在 handler 里取，不写进依赖数组（后声明的 const，渲染期取值会 TDZ）。
  assert.match(teams, /if \(selectedId\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*void leaveDetail\(\);\s*return;/);
  assert.doesNotMatch(teams, /if \(selectedId\) \{\s*setSelectedId\(""\);/);
  // 取消（含关掉浮层）不丢：默认焦点在「继续编辑」，丢弃才是 danger。
  assert.match(teams, /title: "放弃未保存的团队改动？"/);
  assert.match(teams, /\{ label: "继续编辑", value: false, autoFocus: true \}/);
  assert.match(teams, /\{ label: "放弃改动", value: true, kind: "danger" \}/);
  assert.match(teams, /return answer\.dismissed === false && answer\.action === true;/);
  // 切标签的叠放面板常驻，TeamEditor 不再因换团队留旧草稿。
  assert.match(teams, /> : <TeamEditor\n\s*key=\{selected\.id\}/);
});

test("团队详情切标签：两块面板常驻叠放，只翻可见性，不再整块重挂载", () => {
  const teams = read("react/ai-teams/teams-page.tsx");
  assert.doesNotMatch(teams, /className="wand-teams-detail-pane" key=\{detailTab\}/);
  assert.match(teams, /<div className="wand-teams-detail-stack">\s*\{DETAIL_TABS\.map\(\(tab\) => <div\n\s*key=\{tab\.value\}/);
  assert.match(teams, /data-hidden=\{detailTab !== tab\.value \|\| undefined\}\n\s*inert=\{detailTab !== tab\.value\}/, "隐藏面板不可聚焦、不可点");

  const styles = read("react/ai-teams/styles.ts");
  const block = styles.slice(styles.indexOf("/* 团队详情两个面板叠放常驻"), styles.indexOf(".wand-teams-detail > .wand-stretch-tabs"));
  assert.match(block, /\.wand-teams-detail-stack \{ position: relative; display: grid; \}/);
  assert.match(block, /\.wand-teams-detail-pane \{\s*grid-area: 1 \/ 1;/, "两块面板叠在同一格");
  assert.match(block, /transition: opacity var\(--motion-normal\) var\(--ease-in-out-smooth\);/, "进场用 normal");
  assert.match(block, /\.wand-teams-detail-pane\[data-hidden\] \{\s*opacity: 0;\s*visibility: hidden;\s*pointer-events: none;\s*transition: opacity var\(--motion-quick-exit\)/, "旧内容退场快于进场");
  assert.doesNotMatch(block, /\b\d+(?:\.\d+)?ms\b/, "时长只从 token 取，不写字面毫秒");
  const narrow = styles.slice(styles.indexOf("@media (max-width: 760px)"), styles.indexOf("@media (prefers-reduced-motion"));
  assert.match(narrow, /\.wand-teams-detail-stack \{ display: block; \}/, "窄屏退回静态流式，常驻块不占高度");
  const reduced = styles.slice(styles.indexOf("@media (prefers-reduced-motion"));
  assert.match(reduced, /\.wand-teams-detail-pane \{ transition: none; \}/, "reduce-motion 下瞬时切换");
});

test("团队页：「新建团队」也先确认，开工成功那条路刻意不插确认", () => {
  const teams = read("react/ai-teams/teams-page.tsx");
  // 第五个丢草稿入口：正在改某个团队时点「新建团队」，详情面板按 selectedId/key 换掉，草稿直接没了。
  assert.match(teams, /const startCreate = async \(\): Promise<void> => \{\s*if \(!await confirmDiscardTeamDraft\(\)\) return;/);
  assert.match(teams, /onClick=\{\(\) => \(creating \? void leaveDetail\(\) : void startCreate\(\)\)\}/);
  assert.match(teams, /onClick=\{\(\) => \{ void startCreate\(\); \}\}/, "空列表里的「从模板创建」也等确认结果");
  assert.doesNotMatch(teams, /onClick=\{startCreate\}/, "异步守卫不能当成同步 click 直接传");
  // afterDirectRun 不弹确认：运行已经成功、主路径是把用户送去群聊会话（整页要走），
  // 在成果之后追问「放弃改动」只会打断交接。它仍是同步函数，没被 async 守卫污染。
  assert.match(teams, /const afterDirectRun = \(teamId: string, started: AiTeamDirectRun\): void => \{/);
  assert.match(teams, /if \(sessionId && onOpenSession\) \{\s*onOpenSession\(sessionId\);\s*return;\s*\}/);
  // 运行时刻的格式交给浏览器，和群聊 chatTurnClock 的 toLocaleTimeString([]) 同一口径。
  assert.match(teams, /new Date\(run\.updatedAt\)\.toLocaleString\(\[\], \{ month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" \}\)/);
  assert.doesNotMatch(teams, /toLocaleString\("zh-CN"/, "不再写死 zh-CN");
});
