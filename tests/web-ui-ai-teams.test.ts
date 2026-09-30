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
  acknowledgedChatFingerprint,
  chatAvatarSpec,
  chatSendDefinitelyRejected,
  CHAT_EMPTY_BODY,
  CHAT_EXPAND_LABEL,
  CHAT_INPUT_PLACEHOLDER,
  CHAT_SELF_NAME,
  chatInputHint,
  chatAttachmentIsImage,
  chatAttachmentPrompt,
  chatUploadUrl,
  collapsedPreview,
  teamChatComposerMode,
  teamChatMessageShape,
  teamRunIsActive,
  teamOfficeMembers,
  displayChatTurn,
  displayTeamOf,
  chatMessageBody,
  chatMessageUrl,
  chatTurnFingerprint,
  projectChatTurns,
  chatTurnKind,
  chatTurnText,
  chatTimeMarker,
  isConfirmedBy,
  isFollowingTail,
  liveOmittedText,
  liveStateLabel,
  LIVE_EMPTY_TEXT,
  mentionSegments,
  mergeTeamChatDetail,
  mergeTeamChatTurns,
  mergeLiveRows,
  MOTION_QUICK_EXIT_VAR,
  needsCollapse,
  orderLiveSteps,
  parseMotionDurationMs,
  parseStepReport,
  parseChatAttachments,
  pruneExpiredLeaving,
  reportTypeLabel,
  settleLocalTurns,
  shouldFollowTail,
  splitLeaderMessage,
  teamChatScope,
  type LocalChatTurn,
} from "../src/web-ui/react/ai-teams/team-chat-view.js";
import type { AiTeamLiveStep, AiTeamRunDetail } from "../src/ai-team-types.js";
import { HttpResponseError } from "../src/web-ui/react/http-adapter.js";
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

test("团队工位从步骤和会话状态投影，待授权与已完成分层", () => {
  const detail = {
    run: { team: { members: [
      { id: "lead", name: "负责人", duty: "分派工作" },
      { id: "dev", name: "开发者", duty: "实现" },
      { id: "qa", name: "审查者", duty: "检查" },
    ] } },
    steps: [
      { id: "s1", memberId: "lead", seq: 1, title: "拟定计划", status: "done", sessionId: "lead-session" },
      { id: "s2", memberId: "dev", seq: 2, title: "实现接口", status: "running", sessionId: "dev-session" },
      { id: "s3", memberId: "qa", seq: 3, title: "审查接口", status: "queued", sessionId: null },
    ],
    memberStates: { "dev-session": "needs_permission" },
  } as unknown as AiTeamRunDetail;
  assert.deepEqual(teamOfficeMembers(detail).map(({ state, label, task, sessionId }) =>
    [state, label, task, sessionId]), [
    ["done", "已完成", "拟定计划", "lead-session"],
    ["attention", "待授权", "实现接口", "dev-session"],
    ["queued", "排队中", "审查接口", null],
  ]);
});

test("群聊改名只投影可见身份，原始消息指纹和旧引用保持不变", () => {
  const snapshot = { id: "team-1", name: "旧群名", updatedAt: "2026-01-01T00:00:00Z", members: [
    { id: "m_dev", name: "旧名字", avatar: "cat:1", duty: "开发" },
  ] } as AiTeam;
  const current = { ...snapshot, name: "新群名", updatedAt: "2026-01-02T00:00:00Z",
    members: [{ ...snapshot.members[0]!, name: "新名字", avatar: "cat:2" }] };
  const raw: ConversationTurn = { role: "assistant", author: { id: "m_dev", name: "旧名字", avatar: "cat:1", sessionId: "s1" },
    content: [{ type: "text", text: "@旧名字 已经处理" }] };
  const detail = { run: { id: "run-1", updatedAt: "2026-01-01T00:00:00Z", team: snapshot },
    displayTeam: current, steps: [], memberStates: {}, chatTurns: [raw] } as AiTeamRunDetail;
  assert.equal(displayTeamOf(detail).name, "新群名");
  assert.equal(teamOfficeMembers(detail)[0]?.member.name, "新名字");
  const fingerprint = chatTurnFingerprint(raw);
  const visible = displayChatTurn(raw, displayTeamOf(detail));
  assert.equal(visible.author?.name, "新名字");
  assert.equal(visible.author?.avatar, "cat:2");
  assert.equal(visible.author?.sessionId, "s1");
  assert.equal(chatTurnText(visible), "@旧名字 已经处理");
  assert.equal(chatTurnFingerprint(raw), fingerprint, "消息原文和账本身份不可变");
  assert.equal(displayChatTurn({ ...raw, author: { id: "deleted", name: "离职成员" } }, current).author?.name, "离职成员");
  assert.equal(displayTeamOf({ ...detail, displayTeam: undefined }), snapshot, "旧服务端仍可展示快照");
  const staleRun = { ...detail, run: { ...detail.run, updatedAt: "2025-12-31T00:00:00Z" },
    displayTeam: { ...snapshot, updatedAt: "2025-12-31T00:00:00Z" } };
  assert.equal(mergeTeamChatDetail(detail, staleRun).displayTeam?.name, "新群名",
    "旧运行请求不能回退新署名");
});

test("群聊名称单独跟随任务版本，不被运行快照和团队名覆盖", () => {
  const detail = { run: { id: "run-1", updatedAt: "2026-01-03T00:00:00Z", stepsUsed: 1 },
    chatTitle: "旧任务任务处理群", chatTitleUpdatedAt: "2026-01-01T00:00:00Z",
    steps: [], memberStates: {}, chatTurns: [] } as unknown as AiTeamRunDetail;
  const renamed = { ...detail, chatTitle: "新任务任务处理群", chatTitleUpdatedAt: "2026-01-04T00:00:00Z",
    run: { ...detail.run, updatedAt: "2026-01-02T00:00:00Z" } };
  const merged = mergeTeamChatDetail(detail, renamed);
  assert.equal(merged.run, detail.run, "运行仍取较新的进度");
  assert.equal(merged.chatTitle, renamed.chatTitle, "任务标题独立刷新");
  assert.equal(mergeTeamChatDetail(merged, detail).chatTitle, renamed.chatTitle, "迟到请求不能回退群名");
  assert.equal(mergeTeamChatDetail(merged, { ...detail, chatTitle: undefined }).chatTitle, renamed.chatTitle);
  const page = read("react/ai-teams/team-chat-page.tsx");
  assert.match(page, /label: visibleDetail\?\.chatTitle \|\| "任务处理群"/);
  assert.match(page, /subscribeTaskChanges/);
});

test("群聊只把明确拒收判为可恢复草稿，未知送达留未确认", () => {
  assert.equal(chatSendDefinitelyRejected(new HttpResponseError("bad", 400)), true);
  for (const status of [0, 200, 408, 409, 500]) {
    assert.equal(chatSendDefinitelyRejected(new HttpResponseError("unknown", status)), false);
  }
  assert.equal(chatSendDefinitelyRejected(new Error("network")), false);
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
  assert.match(chat, /\{visibleDetail\.run\.chatSessionId && onOpenSession \? <WandButton/);
  assert.match(chat, /onOpenSession\(visibleDetail\.run\.chatSessionId!\)/);
  // 顶栏只保留群状态；停止入口仍由群聊输入栏承接，避免首屏重复操作。
  assert.doesNotMatch(chat, /aria-label="停止团队"/);
  assert.match(chatSource, /const stopRunId = run\.id;[\s\S]*aiTeamsRepository\.stop\(stopRunId\)/);
  // 群聊页用的是 title 变体，样式里不该再留 compact 变体的死选择器。
  const chatStyles = read("react/ai-teams/styles.ts");
  assert.doesNotMatch(chatStyles, /\.wand-team-chat-crumb\.is-compact/);
});

test("群聊页对话区下方展示工作任务二级目录", () => {
  const page = read("react/ai-teams/team-chat-page.tsx");
  // 目录沉在对话区下方，数据来自已加载的 detail（run/steps），运行推进仍走 ai-team-run 通知，不轮询。
  assert.match(page, /<WorkTaskTree detail=\{visibleDetail\} onOpenSession=\{onOpenSession\}\/>/);
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
  const editor = read("react/agents/candidate-editor.tsx");
  assert.match(editor, /<AgentFields[\s\S]*?showKind/);
  assert.match(page, /patch\.isLeader \? \{ \.\.\.member, isLeader: false \} : member/);
});

test("task assignment offers CLI and teams as distinct targets", () => {
  const team = { id: "t1", name: "全栈" } as AiTeam;
  const options = agentTargetOptions([{ value: "claude", label: "Claude" }], [team]);
  assert.deepEqual(options.map((option) => option.value), ["claude", "team:t1"]);
  assert.equal(options[1]!.label, "团队 · 全栈");
  assert.equal(agentTargetTeamId("team:t1"), "t1");
  assert.equal(agentTargetTeamId("claude"), "");
  const board = read("react/issues/task-board-host.tsx");
  assert.match(board, /team \? dispatchTeam\(selected, team, prompt\)/);
  assert.match(board, /subject: \{ type: "team", id: team\.id \}/);
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
    "agents/candidate-list": "react/agents/candidate-list.ts",
    "agents/candidate-editor": "react/agents/candidate-editor.tsx",
    "agents/employee-avatar": "react/agents/employee-avatar.tsx",
    "agents/employee-card": "react/agents/employee-card.tsx",
    "agents/employee-create-form": "react/agents/employee-create-form.tsx",
    "agents/employee-list-page": "react/agents/employee-list-page.tsx",
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
      const key = parts.join("/").replace(/\.js$/, "");
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

test("员工头像选择器沿用团队的有界头像按钮尺寸", () => {
  const avatar = read("react/agents/employee-avatar.tsx");
  const styles = read("react/ai-teams/styles.ts");
  assert.match(avatar, /className="wand-team-avatar-picker"/);
  assert.match(avatar, /className="wand-team-coat"/);
  assert.doesNotMatch(avatar, /wand-ai-team-avatar-grid|wand-ai-team-coat-btn/);
  assert.match(styles, /\.wand-team-coat\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/);
});

test("新建员工默认只填期望，手动字段收进可原位展开的高级配置", () => {
  const form = read("react/agents/employee-create-form.tsx");
  // 默认只有期望输入框 + 创建按钮：名字/职责/Prompt/候选都在高级配置里。
  assert.match(form, /id="new-employee-expectation"/);
  assert.match(form, /const \[advanced, setAdvanced\] = React\.useState\(false\)/);
  assert.match(form, /className="wand-employee-advanced"/);
  assert.match(form, /data-open=\{advanced \|\| undefined\}/);
  assert.match(form, /id="new-employee-name"/);
  assert.match(form, /<CandidatesListEditor/);
  // 期望为空时不调模型；高级配置里手动填了名字则按手动值落库。
  assert.match(form, /if \(advanced && name\.trim\(\)\) \{/);
  assert.match(form, /\/api\/silicon-employees\/draft|siliconEmployeesRepository\.draft/);

  const styles = read("react/ai-teams/styles.ts");
  assert.match(styles, /\.wand-employee-advanced \{[^}]*grid-template-rows: 0fr/);
  assert.match(styles, /\.wand-employee-advanced\[data-open\] \{ grid-template-rows: 1fr/);
  assert.match(styles, /\.wand-employee-advanced,\s*\n\s*\.wand-employee-advanced-toggle button > svg \{ transition: none; \}/);
  assert.match(styles, /\.wand-employee-create-submit \{ min-inline-size:/);
  // 箭头同实例旋转变形，标签不换字，按钮尺寸不变。
  assert.match(styles, /\.wand-employee-advanced-toggle\[data-open\] button > svg:last-child \{ transform: rotate\(180deg\)/);
  assert.doesNotMatch(form, /收起高级配置/);
});

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
  const editor = read("react/agents/candidate-editor.tsx");
  assert.match(editor, /className="wand-team-candidate-error" role="alert"/);
  assert.doesNotMatch(page, /alert\(|WandToast|wandOverlay\.toast/);
  assert.doesNotMatch(page, /draggable|onDragStart|dragover/, "不做拖拽排序");
});

test("[T6] 成员卡一行一候选：复用 AgentFields，双写 agents/agent，上限与末位保护落在按钮上", () => {
  const page = read("react/ai-teams/teams-page.tsx");
  const editor = read("react/agents/candidate-editor.tsx");
  const compact = page.replace(/\s+/g, " ");
  const editorCompact = editor.replace(/\s+/g, " ");
  assert.match(editor, /<AgentFields[\s\S]*?showKind/);
  assert.match(page, /memberAgents\(member\)/, "读候选要走 memberAgents，不依赖兼容字段");
  assert.match(compact, /onChange\(\{ agents: next, agent: \{ \.\.\.next\[0\]! \} \}\)/, "保存要双写 agents + agent");
  assert.match(editorCompact, /disabled=\{disabled \|\| agents\.length >= AI_TEAM_MAX_CANDIDATES\}/);
  assert.match(editorCompact, /disabled=\{disabled \|\| total <= 1\}/);
  assert.match(editor, /duplicate=\{duplicates\.includes\(at\)\}/);
  assert.match(editor, /candidateLabel\(index\)/);
  // 旧的单候选写法不该还留在成员卡上。
  assert.doesNotMatch(compact, /onChange\(\{ agent, agents: \[agent\] \}\)/);
  assert.match(read("react/ai-teams/styles.ts"), /grid-template-rows: 0fr/);
});

// ---------- [T7] 入口适配：picker 团队分组、三入口、原位「直接开工」 ----------

const pickerSource = read("react/workspaces/workspace-agent-picker.tsx");
const unifiedPickerSource = read("react/workspaces/unified-execution-subject-picker.tsx");
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

  assert.match(unifiedPickerSource, /const teamBlocked = teamWorkspaceId === ""/);
  assert.match(unifiedPickerSource, /disabled=\{disabled \|\| teamBlocked\}/);
  assert.match(unifiedPickerSource, /TEAM_NEEDS_PROJECT_HINT[\s\S]*?<\/p>/, "禁用说明原位出现在分组里");
  assert.doesNotMatch(unifiedPickerSource, /wandOverlay|Toast|toast\(/);
});

test("[T7] 团队是 picker 自己的选择态，没有撑宽 WorkspaceSessionTarget", () => {
  assert.match(workspaceTypesSource, /export type WorkspaceSessionTarget = WorkspaceProvider \| "shell";/);
  assert.doesNotMatch(workspaceTypesSource, /export type WorkspaceSessionTarget[^;]*team/, "types.ts 只加新类型，不动联合");
  assert.match(workspaceTypesSource, /export interface WorkspaceTeamOption/);

  // 共享选择器把团队/员工/CLI 作为互斥主体；PTY 下只保留 CLI。
  assert.match(pickerSource, /<UnifiedExecutionSubjectPicker/);
  assert.match(unifiedPickerSource, /kind !== "pty"/);
  assert.match(unifiedPickerSource, /selectedSubject\.type === "cli"/);
  assert.match(unifiedPickerSource, /<legend className="wand-new-session-field-label">会话类型<\/legend>/);
  assert.match(unifiedPickerSource, /<legend className="wand-new-session-field-label">模型<\/legend>/);
  assert.match(pickerSource, /onTeamChange\?\.\(""\)/);
  assert.match(pickerSource, /onStart\(target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string, employeeId\?: string\): void \| Promise<void>;/);
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
  assert.match(list, /if \(teamListPending === pending\) teamListPending = null/, "旧请求不能清掉新请求");
  assert.match(list, /if \(version === teamListVersion\) teamList = list/, "改名期间返回的旧名单不回填缓存");
  assert.match(body, /function invalidateTeamList\(\): void/, "定义变更共用失效入口");
  const runNotify = body.slice(body.indexOf("export function notifyAiTeamRunChanged"),
    body.indexOf("type TeamListener"));
  assert.doesNotMatch(runNotify, /teamList/, "运行状态通知不重拉团队定义");
  assert.match(body, /function notifyAiTeamDefinitionChanged\(teamId: string\): void \{\s*invalidateTeamList\(\);/,
    "定义变更统一清缓存并广播");
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
  assert.match(registry, /"http-adapter": \{ HttpResponseError, jsonBody, requestJson \}/, "群聊发送要的 http-adapter 没注册");
});

// chunk 的 CSS 要等按需脚本到位才注入（chunk-entry.ts 先 installStyleSheet 再导出组件）。
// 所以真正的硬约束不是「主包不许出现这些类名」，而是「主包出现的每一个 chunk 类名，主包样式池里
// 必须另有定义」—— 否则就会有一帧「节点已渲染、样式还没到」。
// 下面这份共享清单是当前事实（团队页头像两处都用），它由断言算出来，不是手工豁免。
const SHARED_CHUNK_CLASSES = [
  "composer-plus-popover",
  "is-archived",
  "task-board-create-button",
  "wand-execution-subject-picker",
  "wand-link-btn",
  "wand-settings-field",
  "wand-settings-save-bar",
  "wand-stretch-tabs",
  "wand-subject-empty-row",
  "wand-subject-group",
  "wand-subject-group-title",
  "wand-team-avatar",
  "wand-team-avatar-cat",
  "wand-team-avatar-stack",
  "wand-team-coat",
  // 全文弹层沿用通用弹层的几何类（设计 §6.3 要求带 .wand-team-chat-doc-dialog 一起覆盖，
  // 提高特异性但不是给 base 重定义），base.ts 里已有定义，不会出现首帧裸样式。
  "wand-ui-dialog-content",
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
  assert.match(body, /requestJson\(chatMessageUrl\(sessionId\), jsonBody\(chatMessageBody\(message\)\)\)/);
  assert.doesNotMatch(body, /new WebSocket|\/ws\b|io\.sockets/, "不新增 WS 消息类型");
  assert.equal(chatInputHint("awaiting_approval"), "回复『批准』即开工，其他内容会作为修改意见转给负责人");
  assert.equal(chatInputHint("running"), "将作为插话，负责人下一轮看到");
  assert.equal(chatInputHint("done"), "发消息会接着这一轮的进度开新一轮", "跑完再说话是接着开新一轮，先说清行为");
  assert.equal(chatInputHint("stopped"), chatInputHint("done"));
  assert.equal(chatInputHint("failed"), chatInputHint("done"));
});

test("群聊图片和文件上传沿用会话接口，回显只隐藏路径前缀", () => {
  assert.equal(chatUploadUrl("relay/1"), "/api/sessions/relay%2F1/upload");
  const files = [
    { savedPath: "/workspace/.wand-uploads/1790-aabbccdd-screen.png" },
    { savedPath: "/workspace/.wand-uploads/1790-aabbccdd-notes.pdf" },
  ];
  const prompt = chatAttachmentPrompt(files, "请看图和文档");
  assert.deepEqual(parseChatAttachments(prompt), {
    paths: files.map((file) => file.savedPath), body: "请看图和文档",
  });
  assert.equal(parseChatAttachments("普通消息").body, "普通消息");
  assert.equal(parseChatAttachments(chatAttachmentPrompt(files, "")).body, "请查看附件。");
  assert.equal(chatAttachmentIsImage(files[0]!.savedPath), true);
  assert.equal(chatAttachmentIsImage(files[1]!.savedPath), false);
  assert.match(chatSource, /teamChatComposer\.submit\(sessionId, text, async \(payload\) =>/);
  assert.match(chatSource, /form\.append\("files", item\.file, item\.name\)/);
  assert.match(chatSource, /<ChatAttachments paths=\{parsed\.paths\}\/>/);
});

test("群聊时间标签只在开场或长时间间隔出现", () => {
  const now = new Date("2026-09-29T12:00:00+08:00");
  const first = { createdAt: "2026-09-29T07:40:00+08:00" };
  const soon = { createdAt: "2026-09-29T07:50:00+08:00" };
  const later = { createdAt: "2026-09-29T09:40:00+08:00" };
  assert.equal(chatTimeMarker(first, undefined, now), "今天 07:40");
  assert.equal(chatTimeMarker(soon, first, now), "");
  assert.equal(chatTimeMarker(later, soon, now), "今天 09:40");
  assert.equal(chatTimeMarker({ createdAt: "2026-09-28T07:40:00+08:00" }, undefined, now), "昨天 07:40");
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
  const body = chatSource;
  assert.match(body, /composerMode === "send-and-stop" \? <button/);
  assert.match(body, /const stopRunId = run\.id;[\s\S]*aiTeamsRepository\.stop\(stopRunId\)/);
  assert.match(body, /aria-label="停止团队"/);
  assert.match(body, /const primaryStops = composerMode === "stop";/);
  assert.match(body, /data-phase=\{primaryPhase\}/, "空草稿时停止占据发送按钮原位");
  assert.match(body, /<ComposerAttachmentList/, "待发送附件共用普通会话预览组件");
  assert.match(body, /className="input-composer-row"/, "输入框共用普通会话的布局与样式");
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
  assert.match(page, /const epoch = \+\+loadEpochRef\.current;/);
  assert.match(page, /epoch !== loadEpochRef\.current \|\| currentRunRef\.current !== runId/,
    "旧的详情请求与同 chat 查询都不能盖过后来的导航");
  assert.match(page, /continuingRunRef\.current = newer;\s*taskBoardController\.open\("", "", "teamchat", newer\)/,
    "自动跟随后保留旧 View，直到新 run 详情到达");
  assert.match(page, /if \(continuingRunRef\.current !== runId\) \{\s*continuingRunRef\.current = "";\s*setDetail\(null\);/,
    "手动切到别的群聊仍卸载旧 View");
  assert.match(page, /if \(next\.run\.id === currentRunRef\.current\) \{\s*setDetail\(\(current\) => mergeTeamChatDetail\(current, next\)\);/,
    "旧 View 异步回包不能把新 run 拉回去");
  assert.match(page, /setDetail\(\(current\) => mergeTeamChatDetail\(current, next\)\)/,
    "页面同 run 的并发重拉只合入较新的详情");
  assert.match(page, /staleRun=\{showingPreviousRun\}/,
    "跟随新 run 的过渡期保留旧输入，但禁止旧 run 的发送和停止");
});

test("[T8] 乐观临时行：ACK 服务端指纹优先；无 ACK 才用已见基线和有界时间窗", () => {
  const sentAt = Date.parse("2026-09-27T10:00:00.000Z");
  const row = localRow("把报告写短一点", sentAt);
  assert.equal(isConfirmedBy(userTurn(row.text, new Date(sentAt + 500).toISOString()), sentAt, row.text), true);
  assert.equal(isConfirmedBy(userTurn("别人发的话", new Date(sentAt + 500).toISOString()), sentAt, row.text), false,
    "别的客户端稍晚发言不能撤掉自己的临时行");
  const oldSameText = userTurn(row.text, new Date(sentAt - 1).toISOString());
  assert.equal(isConfirmedBy(oldSameText, sentAt, row.text, [chatTurnFingerprint(oldSameText)!]), false,
    "发送前已见的同文旧话不能确认本次提交");
  assert.equal(isConfirmedBy(userTurn(row.text, new Date(sentAt - 6 * 60_000).toISOString()), sentAt, row.text), false,
    "无 ACK 的回退匹配不能越过五分钟窗口");
  assert.equal(isConfirmedBy({ role: "assistant", content: [{ type: "text", text: row.text }], createdAt: new Date(sentAt + 500).toISOString() }, sentAt, row.text), false);
  assert.equal(isConfirmedBy(userTurn(row.text, ""), sentAt, row.text), false, "没有 createdAt 不认");

  const turns = [userTurn("旧话", new Date(sentAt - 9e5).toISOString()), userTurn(row.text, new Date(sentAt + 300).toISOString())];
  assert.deepEqual(settleLocalTurns([row], turns), [], "服务端已回显 → 撤掉临时行");
  assert.deepEqual(settleLocalTurns([row], [userTurn("别的", new Date(sentAt - 9e5).toISOString())]), [row]);
  assert.deepEqual(settleLocalTurns([row], [userTurn("别的", new Date(sentAt + 300).toISOString())]), [row],
    "较新的其他消息仍不能确认本地行");
  const duplicate = localRow(row.text, sentAt + 1);
  assert.deepEqual(settleLocalTurns([row, duplicate], [userTurn(row.text, new Date(sentAt + 300).toISOString())]),
    [duplicate], "一条服务端回合只能确认一条本地行");
  assert.deepEqual(settleLocalTurns([{ ...row, accepted: false, unconfirmed: true }], turns),
    [{ ...row, accepted: false, unconfirmed: true }], "送达未知时不能靠同文回合猜测成功");
  assert.deepEqual(settleLocalTurns([row], null), [localRow(row.text, sentAt, true)], "重拉失败 → 留着标未确认");
  assert.match(chatSource, /未确认/);
});

test("[T8] 客户端时钟快于服务端仍用成功 ACK 的唯一新回合撤临时行", () => {
  const sentAt = Date.parse("2026-09-27T10:10:00.000Z");
  const text = "继续检查报告";
  const known = userTurn(text, new Date(sentAt - 10 * 60_000).toISOString());
  const echoed = userTurn(text, new Date(sentAt - 7 * 60_000).toISOString());
  const baseline = [chatTurnFingerprint(known)!];
  const ack = acknowledgedChatFingerprint({ messages: [known, echoed] }, text, baseline);
  assert.equal(ack, chatTurnFingerprint(echoed));
  assert.equal(isConfirmedBy(echoed, sentAt, text, baseline), false, "七分钟偏差超出模糊匹配窗口");
  const accepted = { ...localRow(text, sentAt), accepted: true, knownFingerprints: baseline,
    ackFingerprint: ack! };
  assert.deepEqual(settleLocalTurns([accepted], [known, echoed]), [], "服务端 ACK 能唯一确认回显");
  assert.equal(acknowledgedChatFingerprint({ messages: [known, echoed, { ...echoed }] }, text, baseline), null,
    "两个无法区分的同文新回合不猜哪条是本次提交");
  assert.equal(acknowledgedChatFingerprint({ messages: [echoed] }, text, baseline), null,
    "旧窗与 ACK 完全无重叠时不推断新尾");
});

test("[T8] 同 run 详情只推进消息窗和步骤，迟到旧 GET 不覆盖 WS 新回合", () => {
  const [a, b, c, d] = ["A", "B", "C", "D"].map((text, index) =>
    userTurn(text, `2026-09-27T10:00:0${index}.000Z`));
  assert.deepEqual(mergeTeamChatTurns([a, b, c], [a, b]), [a, b, c], "旧 GET 的短窗不回退");
  assert.deepEqual(mergeTeamChatTurns([a, b, c], [b, c, d]), [a, b, c, d], "连续重叠才能补新尾");
  assert.deepEqual(mergeTeamChatTurns([a, b, c], [d]), [a, b, c], "无重叠时不猜顺序");
  const before = { run: { id: "run-1", status: "done", updatedAt: "2026-09-27T10:00:03.000Z",
    stepsUsed: 3 }, steps: [{ status: "done" }], chatTurns: [a, b, c], memberStates: {} } as AiTeamRunDetail;
  const stale = { ...before, run: { ...before.run, status: "running",
    updatedAt: "2026-09-27T10:00:02.000Z", stepsUsed: 1 }, steps: [], chatTurns: [a, b] } as AiTeamRunDetail;
  assert.deepEqual(mergeTeamChatDetail(before, stale), before, "旧状态、旧步骤和旧聊天均不能回退");
  const newRun = { ...stale, run: { ...stale.run, id: "run-2" } } as AiTeamRunDetail;
  assert.equal(mergeTeamChatDetail(before, newRun), newRun, "另一轮的状态和步骤直接切换");
});

test("[T8] 同一 relay 群聊接续运行时维持消息与草稿作用域，切群聊才隔离", () => {
  const first = teamChatScope({ id: "run-1", chatSessionId: "chat-1" });
  assert.equal(teamChatScope({ id: "run-2", chatSessionId: "chat-1" }), first);
  assert.notEqual(teamChatScope({ id: "run-3", chatSessionId: "chat-2" }), first);
  assert.notEqual(teamChatScope({ id: "run-4", chatSessionId: null }), first);
  assert.notEqual(teamChatScope({ id: "run-4", chatSessionId: null }),
    teamChatScope({ id: "run-5", chatSessionId: null }));
  assert.match(chatSource, /const scope = teamChatScope\(run\);/);
  assert.match(chatSource, /if \(composerScopeRef\.current === scope\) return;/);
  assert.match(chatSource, /setLocal\(\[\]\);\s*setError\(""\);\s*setPending\(""\);\s*listPinnedRef\.current = true;\s*\}, \[scope\]\);/);
  assert.match(chatSource, /teamChatComposer\.read\(chatSessionId\)/, "草稿与附件由会话 Composer 持有");
  assert.match(chatSource, /const requestedRunId = activeRunRef\.current\.runId;/);
  assert.match(chatSource, /activeRunRef\.current\.epoch === sendEpoch/,
    "A→B→A 的旧请求也不能误以为还属于当前群聊实例");
  assert.match(chatSource, /activeRunRef\.current\.runId === requestedRunId\s*&& latestDetailRef\.current\.run\.id === requestedRunId/,
    "旧发送回包不覆盖正在看的新 run");
  assert.match(chatSource, /const merged = mergeTeamChatDetail\(latestDetailRef\.current,/,
    "发送后仅合入可证明的新聊天尾部，不回退较新的运行状态");
  assert.match(chatSource, /const primaryDisabled = busy \|\| staleRun \|\| composerMode === "blocked";[\s\S]*disabled=\{primaryDisabled\}/,
    "新一轮详情未就绪时，保留草稿但禁用旧 run 发送入口");
});

test("[T8] 群聊沿用消息类名，技术签名不反复挤进发言行", () => {
  assert.match(chatSource, /className="chat-message chat-notice"/);
  assert.match(chatSource, /className="chat-notice-line"/, "降级 notice 走居中弱化行");
  assert.match(chatSource, /className="chat-message assistant team-chat-msg"/, "消息行仍沿用普通会话的消息类名");
  assert.doesNotMatch(chatSource, /className="chat-message-avatar assistant chat-message-author"/,
    "署名行不再借用普通会话的头像槽（它会把头像塞进文本流里）");
  assert.match(chatSource, /badge="负责人"/, "负责人徽标仍在这一行上，只是换成属性传");
  assert.doesNotMatch(chatSource, /wand-team-chat-provider/, "模型信息不反复出现在群聊发言行");
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

// ---------- [T8] 群聊消息 IM 化：头像 + 名字、气泡/文档卡分流、点击展开弹层 ----------

test("[T8] 形态分流：notice 居中、自己的发言走气泡、超长或含派工清单走文档卡", () => {
  assert.equal(teamChatMessageShape("notice", "团队已停止"), "notice");
  assert.equal(teamChatMessageShape("user", "啊".repeat(500)), "bubble", "自己的长消息仍是气泡，只是预览 + 点击展开");
  assert.equal(teamChatMessageShape("step", "T1 改完了"), "bubble", "短发言不套文档卡");
  assert.equal(teamChatMessageShape("step", "行\n".repeat(9)), "document", "超行数阈值走文档卡");
  assert.equal(teamChatMessageShape("step", "啊".repeat(421)), "document", "超字符阈值走文档卡");
  assert.equal(teamChatMessageShape("leader", "先做后端", 2), "document", "含派工清单就是文档性质");
  assert.equal(teamChatMessageShape("leader", "要不要改目录？", 0), "bubble", "负责人发短消息也还是气泡");
});

test("[T8] 预览 = 前 6 行且不超过 420 字，被截断一定以 … 结尾", () => {
  assert.equal(collapsedPreview("短报告"), "短报告");
  assert.equal(needsCollapse(collapsedPreview("短报告")), false, "没截断就不出展开入口");
  const byLines = collapsedPreview("行\n".repeat(9));
  assert.equal(byLines.endsWith("…"), true, "行数截断要补省略号");
  assert.equal(byLines.split("\n").length, 6);
  const byChars = collapsedPreview("啊".repeat(500));
  assert.equal(byChars.length, 421, "420 字 + 一个省略号（与 Android 单测同值）");
  assert.equal(byChars.endsWith("…"), true);
  const plain = "第一行\n第二行";
  assert.equal(collapsedPreview(plain), plain, "没超阈值时预览就是全文");
  assert.equal(needsCollapse(plain), false);
});

test("[T8] 头像解析：上传图 > 显式毛色 > 派生毛色 > 默认 APP logo", () => {
  assert.deepEqual(chatAvatarSpec({ id: "m_impl", name: "实现者" }),
    { kind: "cat", coat: memberCoatIndex({ id: "m_impl", name: "实现者" }) }, "没选毛色的成员用派生毛色（与团队页同一张脸）");
  assert.deepEqual(chatAvatarSpec({ id: "m_impl", name: "实现者", avatar: "cat:3" }), { kind: "cat", coat: 3 });
  assert.deepEqual(chatAvatarSpec({ id: "m_impl", name: "实现者", avatar: "data:image/png;base64,AAA" }),
    { kind: "upload", src: "data:image/png;base64,AAA" });
  assert.deepEqual(chatAvatarSpec(null), { kind: "brand" }, "没有署名的发言（用户自己）用默认 APP logo");
  assert.deepEqual(chatAvatarSpec({ id: "", name: "", avatar: "说不清的取值" }), { kind: "brand" },
    "非法 avatar 且定位不到身份也不渲染空 <img>");
  assert.deepEqual(chatAvatarSpec({ id: "", name: "实现者", avatar: "说不清的取值" }),
    { kind: "cat", coat: memberCoatIndex({ id: "", name: "实现者" }) }, "非法 avatar 但能定位身份 → 派生毛色");
});

test("[T8] 每条发言都有头像 + 名字，自己的发言是「我」+ 默认 APP logo", () => {
  const body = stripComments(chatSource);
  assert.equal(CHAT_SELF_NAME, "我");
  assert.match(chatSource, /export const CHAT_SELF_NAME = "我";/);
  assert.match(body, /<MessageAvatar spec=\{avatar\}\/>/, "消息行先渲染头像");
  assert.match(body, /<div className="team-chat-msg-head">/, "然后是署名行");
  assert.match(body, /data-side=\{side\}/);
  assert.match(body, /\{sessionId && onOpenSession[\s\S]{0,240}className="avatar-name chat-author-link"/, "成员名字可点进会话");
  assert.match(body, /: <span className="avatar-name">\{name\}<\/span>\}/, "不可点时名字仍是普通文本");
  assert.match(chatSource, /avatar=\{\{ kind: "brand" \}\}/, "自己的发言与临时行固定用默认 APP logo");
  assert.match(body, /<WandBrandMark className="team-chat-avatar-brand"\/>/, "默认头像就是系统 APP logo");
  assert.match(body, /<PixelCat coat=\{spec\.coat\}\/>/, "成员头像是像素猫");
  assert.match(body, /<img className="team-chat-avatar-upload" src=\{spec\.src\} alt=""\/>/);
  // 消息行在 hover 时不位移（普通会话的 .chat-message:hover 会上浮 1px）。
  assert.match(chatStylesSource, /\.task-board-team-chat \.team-chat-msg:hover \{ transform: none; \}/);
  assert.match(chatStylesSource, /\.team-chat-avatar \{[\s\S]*?width: 32px;[\s\S]*?height: 32px;[\s\S]*?border-radius: 30%;/, "头像 32px / 圆角 30%");
});

test("[T8] 超长正文只渲染预览 + 「点击展开」，不藏第二份全文", () => {
  const body = stripComments(chatSource);
  const messageBody = body.slice(body.indexOf("function MessageBody("), body.indexOf("function TeamMessageRow("));
  assert.ok(messageBody.length > 400, "没切到正文块");
  assert.equal(CHAT_EXPAND_LABEL, "点击展开");
  assert.equal(CHAT_EMPTY_BODY, "（这条消息没有正文）");
  assert.match(body, /className="team-chat-preview"><MentionText text=\{collapsedPreview\(body\)\} names=\{names\} source=\{body\}\/>/, "预览用去路径后的正文验证边界");
  assert.match(body, /\{CHAT_EXPAND_LABEL\}<\/button>/);
  assert.match(chatSource, /aria-haspopup="dialog"/, "触发点是覆盖层入口");
  assert.equal(chatSource.match(/className="team-chat-expand"\s*\n\s*aria-expanded=/g)?.length, 1,
    "只有公告卡的原位展开带 aria-expanded");
  assert.match(chatSource, /className="team-chat-expand"\s*\n\s*aria-haspopup="dialog"\s*\n\s*onClick=\{onExpand\}/,
    "消息触发点只有「打开弹层」一个状态，不是两分支硬切");
  assert.doesNotMatch(messageBody, /-webkit-line-clamp/, "行数截断交给 collapsedPreview，不叠第二层夹取");
  assert.doesNotMatch(chatStylesSource, /\.team-chat-preview[^}]*line-clamp/, "预览样式只负责排版");
  assert.doesNotMatch(messageBody, /inert=/, "预览态不靠 inert 藏全文（DOM 里只有一份文本）");
  assert.match(body, /: list\.length === 0 && parsed\.paths\.length === 0[\s\S]{0,120}CHAT_EMPTY_BODY/, "没有正文和附件才显示空正文");
});

test("[T8] 点击展开：Portal 弹层显示全文，关闭路径四条齐全且触发点不位移", () => {
  const body = stripComments(chatSource);
  assert.match(body, /<WandDialogSurface/, "复用既有弹层，不自造覆盖层");
  assert.match(body, /open=\{docLayer\?\.phase === "open"\}/);
  assert.match(body, /if \(!open\) closeDoc\(\)/, "✕ / Escape / 点遮罩都走同一退场路径");
  assert.match(body, /closeLabel="关闭"/);
  assert.match(body, /title=\{docLayer\?\.name \?\? ""\}/);
  assert.match(body, /\[docLayer\.clock, docLayer\.typeLabel\]\.filter\(Boolean\)\.join\(" · "\)/, "副标题 = 时刻 · 类型");
  assert.match(body, /className=\{\[\s*"wand-ui-dialog-content",\s*"wand-team-chat-doc-dialog"/);
  assert.match(body, /"wand-doc-dx-end" : "wand-doc-dx-start"/, "水平方向取发言侧");
  assert.match(body, /"wand-doc-dy-top" : "wand-doc-dy-bottom"/, "垂直方向取触发点上/下半");
  assert.match(body, /<pre className="team-chat-doc-layer-text" tabIndex=\{0\} data-wand-autofocus>/, "正文可聚焦可滚动");
  assert.match(body, /<MentionText text=\{parsed\.body\} names=\{layer\.mentionNames\}\/>/, "全文名单来自打开来源快照");
  assert.match(body, /rect\.top \+ rect\.height \/ 2 < window\.innerHeight \/ 2/, "只在打开时量一次触发点");
  // 兜底关闭：弹层开着时那条回合消失了就关层。
  assert.match(body, /chatDocOwnerPresent\(docLayer\.ownerId, docLayer\.scope, projection, local\)/);
  assert.match(body, /phase: "closing"/);
  // 弹层正文是整条发言（负责人行给的是未拆分的原文），一定比预览长。
  assert.match(body, /const text = report \? report\.body : chatTurnText\(turn\);/, "报告剥掉前缀后再进正文块");
  assert.match(body, /const \{ head, assignments \} = splitLeaderMessage\(text\);/);
});

test("[T8] 弹层样式：Portal 前缀 + 只用 token + 不碰全局 .chat-*", () => {
  const layer = chatStylesSource.slice(
    chatStylesSource.indexOf("/* ---------- 全文弹层"),
    chatStylesSource.indexOf("/* ---------- 独立群聊页"),
  );
  assert.ok(layer.length > 600, "没切到弹层样式块");
  assert.match(layer, /\.wand-ui-dialog-content\.wand-team-chat-doc-dialog \{/, "覆盖通用弹层几何");
  assert.match(layer, /width: min\(720px, calc\(100vw - var\(--wand-safe-left\) - var\(--wand-safe-right\) - 32px\)\)/);
  assert.match(layer, /max-height: min\(72vh, 640px\)/, "高度上限 72vh（与 Android 同比例）");
  assert.match(layer, /animation: team-chat-doc-in var\(--motion-normal\) var\(--ease-out-expo\)/);
  assert.match(layer, /animation: team-chat-doc-out var\(--motion-quick-exit\) var\(--ease-in-out-smooth\)/, "退场快于进场");
  assert.match(layer, /translate: var\(--wand-doc-dx, 0\) var\(--wand-doc-dy, 0\); scale: 0.98/, "translate/scale 是独立属性，不拼 transform");
  assert.match(layer, /\.wand-doc-dx-start \{ --wand-doc-dx: -10px; \}/);
  assert.match(layer, /\.team-chat-doc-layer-text \{[\s\S]*?min-height: 40px;/, "空内容也不让滚动区塌陷");
  assert.doesNotMatch(layer, /!important/);
  assert.doesNotMatch(layer, /\d+ms\b|cubic-bezier\(/, "时长与曲线只从 token 取");
  assert.doesNotMatch(layer, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "只能引用 token");
  assert.doesNotMatch(layer, /\.chat-message|\.chat-input/, "不碰普通会话聊天的类名");
  assert.doesNotMatch(layer, /\.wand-team-chat-page /, "弹层不在页面树里，不许写页面后代选择器");
  // Base UI 靠动画结束卸载：reduce-motion 交给全局兜底，这里不能写 animation: none。
  assert.doesNotMatch(layer, /animation: none/);
  const reduced = chatStylesSource.slice(chatStylesSource.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.doesNotMatch(reduced, /team-chat-doc/, "reduce-motion 不接管弹层：压掉动画会卡半开");
});

test("[T8] 新样式全部作用域化：消息层在 .task-board-team-chat 下，弹层用自己的前缀", () => {
  const block = chatStylesSource.slice(
    chatStylesSource.indexOf("/* ---------- 消息行（IM）"),
    chatStylesSource.indexOf("/* ---------- 正在输出的成员"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(block.length > 1500, "没切到消息行样式块");
  const selectors = [...block.matchAll(/(^|\})[^{}]*?\{/g)].map((hit) => hit[0].slice(1).trim());
  assert.ok(selectors.length > 20, `只枚举到 ${selectors.length} 个选择器，枚举方式可能失效`);
  for (const selector of selectors) {
    if (selector.startsWith("@")) continue;
    for (const part of selector.split(",").map((item) => item.trim()).filter(Boolean)) {
      // .team-chat-step-chip 是署名行与弹层元信息行共用的那一枚，两端同一套样式；
      // .team-chat-doc-layer 是弹层自己的前缀（G3：Portal 不在 .task-board-team-chat 树里）。
      assert.ok(
        part.startsWith(".task-board-team-chat ")
          || part.startsWith(".team-chat-step-chip")
          || part.startsWith(".team-chat-doc-layer"),
        `新增的消息层选择器必须作用域在 .task-board-team-chat 下：${part}`,
      );
    }
  }
  // 消息层的新类名一个都不许裸着写（裸类名会外泄到普通会话聊天）。
  const SCOPED = [
    "team-chat-msg", "team-chat-msg-content", "team-chat-msg-head", "team-chat-avatar",
    "team-chat-avatar-upload", "team-chat-avatar-brand", "team-chat-bubble", "team-chat-bubble-text",
    "team-chat-doc", "team-chat-doc-text", "team-chat-preview", "team-chat-msg-empty",
  ];
  for (const name of SCOPED) {
    assert.match(chatStylesSource, new RegExp(`\\.task-board-team-chat \\.${name}\\b`), `${name} 必须作用域在 .task-board-team-chat 下`);
  }
  // 弹层经 Portal 渲染，不在页面树里：头像靠 G3 的共享前缀同时命中两个根。
  assert.match(chatStylesSource, /\.team-chat-doc-layer \.team-chat-avatar\b/);
  assert.doesNotMatch(chatStylesSource, /\.chat-message-bubble \{|\n\.chat-message \{/, "不重定义普通会话的聊天规则");
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
    { member: "实现者", title: "T1 类型与存储迁移", note: "" },
    { member: "审查者", title: "T1 验收", note: "等第 1 项完成后" },
  ], "旧数据的「等第 N 项完成后」仍读得出来（同一个 note 槽位）");
  // 新数据（S5）：`（依据：…）` 取代等待说明，仍然是同一个槽位。
  const basis = splitLeaderMessage([
    "1. **@实现者** T1 类型与存储迁移",
    "2. **@审查者** T1 验收（依据：第 1 步「T1 类型与存储迁移」的产物）",
  ].join("\n"));
  assert.deepEqual(basis.assignments, [
    { member: "实现者", title: "T1 类型与存储迁移", note: "" },
    { member: "审查者", title: "T1 验收", note: "依据：第 1 步「T1 类型与存储迁移」的产物" },
  ]);
  assert.equal(basis.assignments[1]!.title.includes("依据"), false, "依据不进标题");
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

test("[T8] 群聊默认聚焦消息，公告和工作详情从一行入口原位展开", () => {
  const chatBlock = chatStylesSource.slice(
    chatStylesSource.indexOf("/* 「主任务」"),
    chatStylesSource.indexOf("/* 备用候选被跳原因"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(chatBlock, /\.team-chat-goal \{/, "主任务公告位");
  assert.match(chatBlock, /\.team-chat-goal-label \{/, "主任务标签");
  assert.match(chatBlock, /\.team-chat-msg \{/, "消息行是头像 + 内容列的两列布局");
  assert.match(chatBlock, /\.team-chat-msg\[data-side="end"\] \{ flex-direction: row-reverse/, "自己的发言镜像靠右");
  assert.match(chatStylesSource, /\.team-chat-context \{/, "公告摘要保持一行");
  assert.match(chatStylesSource, /\.team-chat-details\[data-open\]/, "详情原位展开");
  assert.match(chatBlock, /\.team-chat-plan-list li \{/, "派工清单是一组任务条目");
  assert.match(chatBlock, /\.team-chat-goal-body \{[\s\S]*grid-template-rows: 0fr/, "主任务收起是倒放");
  assert.match(chatBlock, /\.team-chat-goal-body\[data-open\]/, "主任务展开态");
  assert.match(chatBlock, /var\(--transition-normal\)/);
  assert.doesNotMatch(chatBlock, /\b(?:\d+(?:\.\d+)?)(?:ms|s)\b/, "新的群聊样式不得写死时长");
  assert.doesNotMatch(chatBlock, /#[0-9a-f]{3,8}\b|rgba?\(/, "只能引用 token");
  const reduced = chatStylesSource.slice(chatStylesSource.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.team-chat-goal-body,/);
  assert.match(reduced, /\.team-chat-details,/);
  // 主任务与子任务必须渲染成两个不同层，而不是同一个气泡换个名字。
  assert.match(chatSource, /className="team-chat-goal"/);
  assert.match(chatSource, /kind="step"/, "成员报告是 step 层");
  assert.match(chatSource, /kind="leader"/, "负责人发言是 leader 层");
  assert.match(chatSource, /className="team-chat-expand"/);
  assert.match(chatSource, /aria-expanded=\{expanded\}/);
  assert.match(chatSource, /aria-controls=\{detailsId\}/);
  assert.match(chatSource, /<TeamOffice detail=\{detail\}/, "成员工位仍可从详情查看");
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

test("[live] 同 chat 续跑保留滚动锚点；换 chat 才重新从尾部开始跟随", () => {
  assert.match(
    chatSource,
    /if \(lastScopeRef\.current !== scope\) \{\s*anchorRef\.current = null;\s*listPinnedRef\.current = true;\s*lastScopeRef\.current = scope;/,
    "滚动复位由 relay 群聊作用域控制",
  );
  assert.match(chatSource, /setDetailsOpen\(false\);\s*closeDoc\(\);\s*\}, \[run\.id, closeDoc\]\);/,
    "运行级详情切换仍会收起");
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

test("[署名] 技术签名仍可解析，但群聊发言只突出成员名字", () => {
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
  assert.equal(chatSource.match(/agentSignatureLabel\(/g)?.length, 1, "发言行不重复呈现 CLI 和模型");
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
  assert.match(chatSource, /aria-label=\{`打开\$\{memberName\}正在输出的会话`\}/, "读屏只报最新名字与动作，不整段朗读正文");
  assert.match(chatSource, /if \(row\.leaving && event\.target === event\.currentTarget\) onRetire\(step\.stepId\);/,
    "退场只认这一行自己的动画，头名/卡片分两段进场的 animationend 会冒泡上来");
});

test("[live] 实时输出先收成一行，展开后保留定高内滚", () => {
  const block = chatStylesSource.slice(
    chatStylesSource.indexOf("/* ---------- 正在输出的成员"),
    chatStylesSource.indexOf("/* 主任务层：负责人决策"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(block, /\.team-chat-live-card \{[\s\S]*?max-width: 560px;/);
  assert.match(block, /\.team-chat-live-card \{[\s\S]*?height: 200px;/);
  assert.match(block, /\.team-chat-live-text \{[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior-y: contain;/, "内部滚动且不抢外层");
  assert.match(block, /font-family: var\(--font-mono\)/, "等宽");
  assert.match(block, /\.team-chat-live-summary \{/, "首屏是一行摘要");
  assert.match(block, /\.team-chat-live-body\[data-open\]/, "输出原位展开");
  assert.match(chatSource, /aria-expanded=\{expanded\}/);
  assert.match(block, /@keyframes wand-team-live-grow \{\s*from \{ opacity: 0; transform: translateX\(-10px\); \}/, "从头像方向长出");
  assert.match(block, /\.team-chat-live-row\[data-leaving\] \{\s*animation: wand-team-live-grow var\(--motion-quick-exit\) var\(--ease-in-out-smooth\) reverse forwards;/, "收起是同一段动画倒放，且快于进场");
  // 头名仍从头像方向进场；完整输出由用户主动展开。
  assert.match(block, /\.team-chat-live-head \{[\s\S]*?animation: wand-team-live-grow var\(--motion-fast\) var\(--ease-out-expo\) both;/, "第一段：头名");
  assert.doesNotMatch(block, /\.team-chat-live-row \{[^}]*animation:/, "整行不再同帧原子插入");
  assert.doesNotMatch(block, /\b(?:\d+(?:\.\d+)?)(?:ms|s)\b/, "不得写死时长");
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/, "只能引用 token");
  const narrow = chatStylesSource.slice(
    chatStylesSource.indexOf("@media (max-width: 760px)"),
    chatStylesSource.indexOf("@media (prefers-reduced-motion"),
  );
  assert.doesNotMatch(narrow, /team-chat-live/, "窄屏不改卡片高度");
  const reduced = chatStylesSource.slice(chatStylesSource.indexOf("@media (prefers-reduced-motion"));
  assert.match(reduced, /\.team-chat-live-body,/);
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

// ---------- [v2] 群聊开场与协作流转（入群序列 / 开工发言 / @ 流转） ----------

test("[v2] @ 流转：mentionSegments 按 roster 最长优先 + 前边界命中", () => {
  const names = ["实现者", "审查者", "设计师", "设计"];
  // 最长优先：`@设计师` 命中「设计师」而不是「设计」。
  assert.deepEqual(mentionSegments("依据 @设计师 第 1 步", names), [
    { text: "依据 " }, { text: "@设计师", mention: true }, { text: " 第 1 步" },
  ]);
  // 前边界：行首 / 空白 / 中文标点都算；多个 @ 各自成段。
  assert.deepEqual(mentionSegments("邀请 @实现者、@审查者 加入群聊", names), [
    { text: "邀请 " }, { text: "@实现者", mention: true }, { text: "、" },
    { text: "@审查者", mention: true }, { text: " 加入群聊" },
  ]);
  assert.deepEqual(mentionSegments("@实现者 开工", names)[0], { text: "@实现者", mention: true });
  assert.deepEqual(mentionSegments("（@实现者）", names), [
    { text: "（" }, { text: "@实现者", mention: true }, { text: "）" },
  ]);
  // 前边界不成立时不命中；成对包裹的完整名字保留标记并装饰。
  assert.equal(mentionSegments("a@实现者", names).some((segment) => segment.mention), false);
  assert.deepEqual(mentionSegments("1. **@实现者** 改代码", names), [
    { text: "1. **" }, { text: "@实现者", mention: true }, { text: "** 改代码" },
  ]);
  // 名字不在 roster / 空名单 / 被切在半截 → 整段普通文本，不丢字符、不崩。
  assert.deepEqual(mentionSegments("找 @某人 帮忙", names), [{ text: "找 @某人 帮忙" }]);
  assert.deepEqual(mentionSegments("@实现", names), [{ text: "@实现" }]);
  assert.deepEqual(mentionSegments("@实现者", []), [{ text: "@实现者" }]);
  assert.deepEqual(mentionSegments("", names), []);
  // 拼回来必须与原文逐字相同（高亮不改字）。
  const text = "邀请 @实现者、@审查者 加入群聊";
  assert.equal(mentionSegments(text, names).map((segment) => segment.text).join(""), text);
});

test("[v2] 报告类型标签：标题纯空白 → 成员发言（与 Android 同规则）", () => {
  assert.equal(reportTypeLabel(null), "成员发言");
  assert.equal(reportTypeLabel({ ok: true, title: "", body: "正文" }), "成员发言");
  assert.equal(reportTypeLabel({ ok: true, title: "   ", body: "正文" }), "成员发言");
  assert.equal(reportTypeLabel({ ok: true, title: " T1 实现 ", body: "正文" }), "成员报告 ·  T1 实现 ");
  assert.match(stripComments(chatSource), /typeLabel: reportTypeLabel\(report\)/);
});

test("[v2] 入群序列与开工发言按到达顺序渲染，@ 高亮只作用在群聊作用域", () => {
  const body = stripComments(chatSource);
  // 入群行仍是 notice 系统行：作者槽 + 正文（正文走 MentionText）。
  assert.match(body, /className="chat-notice-text"><MentionText text=\{chatTurnText\(turn\)\} names=\{rosterNames\}\/>/);
  assert.doesNotMatch(body, /className="chat-notice-text">\{chatTurnText\(turn\)\}/, "notice 正文不再直接铺纯文本");
  // roster 从当前运行的成员来（空名单 → 不高亮）。
  assert.match(body, /const rosterNames = React\.useMemo\(\s*\(\) => \[\.\.\.new Set\(\[\.\.\.displayTeam\.members\.map/,
    "当前署名和历史 @ 提及都能识别");
  // 开工发言是普通 step 回合：走 StepTurn → TeamMessageRow（头像 + 名字 + 气泡/文档卡），正文走 MentionText。
  assert.match(body, /<MessageBody\s*\n\s*shape=\{shape\}\s*\n\s*text=\{text\}\s*\n\s*names=\{names\}/);
  // 派工行：mention + 标题 + 依据槽（wait 选择器已改名）。
  assert.match(body, /<span className="team-chat-mention">@\{item\.member\}<\/span>/);
  assert.match(body, /<small className="team-chat-plan-basis">\{item\.note\}<\/small>/);
  assert.doesNotMatch(chatSource, /team-chat-plan-member|team-chat-plan-wait/, "旧 JSX 类名已退出");
  assert.doesNotMatch(chatStylesSource, /\.team-chat-plan-member\s*\{/, "无 DOM 的旧派工 CSS 规则也必须清理");
  // 入群行也跟进场动画（它就是新到的回合）。
  assert.match(chatStylesSource, /\.task-board-team-chat \.chat-message\.chat-notice\[data-arriving\] \{[\s\S]{0,120}animation: wand-team-msg-in/);
});

test("[v2] 名字排版与行距对齐（A1/A2/A3）", () => {
  // A1：署名行名字 12px / 600，且只用群聊作用域覆盖，不动共享 .avatar-name。
  assert.match(chatStylesSource,
    /\.task-board-team-chat \.team-chat-msg-head \.avatar-name \{[\s\S]*?font-size: var\(--font-size-xs\);[\s\S]*?font-weight: var\(--font-weight-semibold\);/);
  assert.doesNotMatch(read("content/styles.css"), /\.avatar-name \{[^}]*font-size: var\(--font-size-xs\)/, "共享 .avatar-name 未被改");
  // A2：不可点的名字是正文色；可点的按钮保持动作色（由 .chat-author-link 那条负责）。
  assert.match(chatStylesSource,
    /\.task-board-team-chat \.team-chat-msg-head span\.avatar-name \{ color: var\(--text-primary\); \}/);
  assert.doesNotMatch(chatStylesSource, /span\.avatar-name\.chat-author-link/, "可点那条没有被一起改成正文色");
  // A3：消息行自身外边距清零，列表 gap 12 才是最终行距。
  assert.match(chatStylesSource, /\.task-board-team-chat \.chat-message\.team-chat-msg \{ margin: 0; \}/);
});

test("[v2] live 行署名行去头像，卡片本体与退场沿用 v1", () => {
  const live = chatSource.slice(chatSource.indexOf("function LiveStepRow("), chatSource.indexOf("export function chatTurnFingerprint("));
  assert.ok(live.length > 800, "没切到 live 行");
  assert.doesNotMatch(live, /MessageAvatar|team-chat-avatar/, "live 署名行不再重复一张脸");
  assert.match(live, /<span className="team-chat-live-name" title=\{memberName\}>\{memberName\}<\/span>/);
  // 名字不再单独挂链接（整卡已可点），步骤 chip / 状态 chip / 时刻都在。
  assert.doesNotMatch(live, /chat-author-link/);
  assert.match(live, /team-chat-live-chip/);
  assert.match(live, /team-chat-live-state/);
  assert.match(live, /className="chat-message-time"/);
  const block = chatStylesSource.slice(
    chatStylesSource.indexOf("/* ---------- 正在输出的成员"),
    chatStylesSource.indexOf("/* 主任务层：负责人决策"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(block, /\.team-chat-live-card \{[\s\S]*?max-width: 560px;/);
  assert.match(block, /\.team-chat-live-card \{[\s\S]*?height: 200px;/);
  assert.match(block, /wand-team-live-grow var\(--motion-quick-exit\) var\(--ease-in-out-smooth\) reverse forwards/, "退场仍是入场倒放");
  assert.match(block, /\.team-chat-live-name \{[\s\S]*?font-size: var\(--font-size-2xs\);/);
});

test("[v2续接] 入场由页面呈现账本结算，不从挂载或窗口下标推断", () => {
  const body = stripComments(chatSource);
  assert.match(body, /\{projection\.rows\.map\(\(\{ turn: storedTurn, presentationId: key \}, index\) => \{\s*const turn = displayChatTurn\(storedTurn, displayTeam\);/,
    "先以原始 turn 定位再投影展示身份");
  assert.doesNotMatch(body, /createdAt \?\? ""\}#\$\{index\}/, "下标不再当 key");
  assert.match(chatSource, /export function projectChatTurns\(/);
  // 没有任何演示用定时动画：入场不串播、不写 delay；也不许为入群/开工新建定时器。
  // 注释里的词不算；只检查真正的声明（那条死重置 `.team-chat-live-head { animation-delay: 0s }` 已删）。
  assert.doesNotMatch(chatStylesSource, /animation-delay\s*:/, "连那条死重置也删了");
  assert.equal(chatSource.match(/window\.setTimeout\(/g)?.length, 2,
    "仅有 IME 确认键保护和 live 行退场兜底，没有演示动画定时器");
  assert.match(chatSource, /onCompositionEnd=\{\(\) => \{[\s\S]*?window\.setTimeout\(\(\) => \{/,
    "确认输入法候选的 Enter 不能作为发送");
  assert.match(chatSource, /retireMs = liveExitDurationMs\(\)/, "确认那一个定时器读的是 token 时长");
  // 入场动画本身：淡入 + 下 4px，只用 token。
  assert.match(chatStylesSource, /@keyframes wand-team-msg-in \{\s*from \{ opacity: 0; translate: 0 4px; \}/);
  assert.match(chatStylesSource,
    /\.task-board-team-chat \.chat-message\.team-chat-msg\[data-arriving\],[\s\S]{0,120}animation: wand-team-msg-in var\(--motion-normal\) var\(--ease-out-expo\);/);
  // reduce-motion：入场整条关掉（它不承载退场清理，和 live 行区别对待）。
  const reduced = chatStylesSource.slice(chatStylesSource.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.task-board-team-chat \.chat-message\.team-chat-msg\[data-arriving\],[\s\S]{0,120}\{ animation: none; \}/);
});

test("[v2] mention / 依据 的样式只用 token，且不溢出到普通会话", () => {
  const block = chatStylesSource.slice(
    chatStylesSource.indexOf("/* @ 流转 token"),
    chatStylesSource.indexOf("/* 头像只在这一处画"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(block.length > 300, "没切到 mention 样式块");
  assert.match(block, /\.task-board-team-chat \.team-chat-mention,/);
  assert.match(block, /\.team-chat-doc-layer \.team-chat-mention \{/);
  for (const wanted of ["color: var(--accent);", "background: var(--accent-muted);", "font-weight: var(--font-weight-medium);", "padding: 0 4px;", "border-radius: var(--radius-xs);", "max-width: min(24ch, 100%);", "white-space: nowrap;", "text-overflow: ellipsis;"]) {
    assert.ok(block.includes(wanted), `mention token 缺 ${wanted}`);
  }
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "只能引用 token");
  assert.doesNotMatch(block, /^\s*\.team-chat-mention/m, "不允许裸类名（会污染普通会话）");
  assert.match(chatStylesSource, /\.team-chat-plan-basis \{ color: var\(--text-tertiary\); font-size: var\(--font-size-2xs\); \}/);
});

test("[v2续接] 相同毫秒与重复载荷仍逐条呈现；句柄不等于服务端 ID", () => {
  const lead = { id: "m_lead", name: "沈砚", leader: true };
  const dev = { id: "m_dev", name: "实现者" };
  const turns: ConversationTurn[] = [
    userTurn("把报告写短一点", "2026-09-29T10:00:00.000Z"),
    assistantTurn("创建了团队群聊「前端双人组」", lead, { notice: true, createdAt: "2026-09-29T10:00:01.000Z" }),
    assistantTurn("邀请 @实现者、@审查者 加入群聊", lead, { notice: true, createdAt: "2026-09-29T10:00:01.000Z" }),
    assistantTurn("计划\n\n1. **@实现者** 实现 Web 端", lead, { createdAt: "2026-09-29T10:00:02.000Z" }),
    assistantTurn("我正在开始工作：第 2 步「实现 Web 端」", dev, { createdAt: "2026-09-29T10:00:03.000Z" }),
    assistantTurn("✅ 完成「实现 Web 端」\n\n改好了", dev, { createdAt: "2026-09-29T10:00:09.000Z" }),
  ];
  const baseline = projectChatTurns(null, "run/chat", turns);
  const keys = baseline.rows.map((row) => row.presentationId);
  assert.equal(new Set(keys).size, keys.length);
  const repeat = projectChatTurns(baseline, "run/chat", turns.map((turn) => ({ ...turn })));
  assert.deepEqual(repeat.rows.map((row) => row.presentationId), keys);
  assert.deepEqual(repeat.candidates, []);
  assert.notEqual(chatTurnFingerprint(assistantTurn("别的话", dev, { createdAt: "2026-09-29T10:00:03.000Z" })),
    baseline.rows[4]!.fingerprint);
});

test("[v2] 旧数据降级：旧 roster / 旧开工 notice 与「（等第…）」都还能读", () => {
  // 旧服务端发的是居中 notice（入群序列与开工都还没有）：分类规则不变，客户端不崩、不空。
  const oldRoster = assistantTurn("团队「前端双人组」接手了这个任务：沈砚（负责人）、实现者", null, { notice: true });
  assert.equal(chatTurnKind(oldRoster), "notice");
  assert.equal(chatTurnText(oldRoster), "团队「前端双人组」接手了这个任务：沈砚（负责人）、实现者");
  const oldStart = assistantTurn("实现者 开始「写代码」", { id: "m_dev", name: "实现者" }, { notice: true });
  assert.equal(chatTurnKind(oldStart), "notice", "旧开工 notice 仍按 notice 渲染，不冒充开工发言");
  // 旧派工括注仍落在同一个 note 槽位（同一个渲染分支）。
  assert.equal(splitLeaderMessage("1. **@实现者** 写代码（等第 1 项完成后）").assignments[0]!.note, "等第 1 项完成后");
  // 缺字段不冒 undefined：没有 author → 默认头像；没有报告前缀 → 成员发言。
  assert.equal(chatAvatarSpec(null).kind, "brand");
  assert.equal(reportTypeLabel(parseStepReport("普通发言")), "成员发言");
  assert.deepEqual(mentionSegments("依据 @查不到的名字 继续", ["实现者"]), [{ text: "依据 @查不到的名字 继续" }]);
});
