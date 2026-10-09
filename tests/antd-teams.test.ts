import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiTeamRunDetail } from "../src/ai-team-types.js";
import { configureTeamChatComposerRuntime } from "../src/web-ui/react/ai-teams/composer-bridge.js";
import {
  CHAT_INPUT_PLACEHOLDER,
  chatMessageUrl,
  chatMessageBody,
  TeamChatView,
} from "../src/web-ui/react/ai-teams/team-chat-view.js";
import { TeamDeliveryDetails } from "../src/web-ui/react/ai-teams/team-delivery.js";
import { teamDeliveryFixture } from "./helpers/team-delivery-fixture.js";

const owned = (file: string): string =>
  readFileSync(new URL(`../src/web-ui/react/${file}`, import.meta.url), "utf8");

const LANE_SOURCES = [
  "ai-teams/teams-page.tsx",
  "ai-teams/team-chat-view.tsx",
  "ai-teams/team-chat-page.tsx",
  "ai-teams/team-dispatch.tsx",
  "ai-teams/team-delivery.tsx",
  "ai-teams/team-employee-invite.tsx",
  "agents/employee-list-page.tsx",
  "agents/employee-card.tsx",
  "agents/employee-create-form.tsx",
  "agents/employee-knowledge.tsx",
  "agents/employee-memory.tsx",
  "agents/employee-avatar.tsx",
  "agents/employee-tags-field.tsx",
  "agents/candidate-editor.tsx",
];

const laneText = (): string => LANE_SOURCES.map(owned).join("\n");

configureTeamChatComposerRuntime({
  read: () => ({ text: "", attachments: [], revision: 0 }),
  edit: () => false,
  subscribe: () => () => {},
  submit: (_id, text, deliver) => deliver({ text, attachments: [] }),
});

function chatDetail(overrides: Partial<AiTeamRunDetail> = {}): AiTeamRunDetail {
  const base = teamDeliveryFixture();
  return {
    ...base,
    delivery: undefined,
    chatTurns: [
      { role: "user", content: [{ type: "text", text: "把报告写短一点" }], createdAt: "2026-10-03T10:00:00.000Z" },
      { role: "assistant", notice: true, createdAt: "2026-10-03T10:00:01.000Z",
        author: { id: "m-lead", name: "负责人", leader: true },
        content: [{ type: "text", text: "邀请 @实现者 加入群聊" }] },
      { role: "assistant", createdAt: "2026-10-03T10:00:02.000Z",
        author: { id: "m-lead", name: "负责人", leader: true },
        content: [{ type: "text", text: "计划\n\n1. **@实现者** 实现 Web 端" }] },
      { role: "assistant", createdAt: "2026-10-03T10:00:03.000Z",
        author: { id: "m-dev", name: "实现者" },
        content: [{ type: "text", text: "我正在开始工作" }] },
    ],
    ...overrides,
  };
}

test("team chat messages render through the shared X bubble surface", () => {
  const html = renderToStaticMarkup(React.createElement(TeamChatView, {
    detail: chatDetail(), onChange() {},
  }));
  assert.match(html, /class="[^"]*ant-bubble/, "每条发言包在通用气泡里");
  assert.match(html, /ant-bubble-end/, "自己的发言靠气泡 placement 镜像");
  assert.match(html, /team-chat-mention/, "@ 成员名仍由本页呈现，不被气泡吞掉");
  assert.match(html, /chat-notice/, "系统提示行仍是居中 notice");
  // 超过阈值的正文只渲染预览，展开入口是整条发言的弹层。
  const source = owned("ai-teams/team-chat-view.tsx");
  assert.match(source, /<ChatMessage\s+className=\{shape === "document" \? "team-chat-doc" : "team-chat-bubble"\}/);
  assert.match(source, /data-shape=\{shape\}/);
  assert.match(source, /footer=\{truncated && onExpand \? <WandButton/);
});

test("team chat keeps the composer bridge as the only draft owner and the relay body contract", () => {
  const source = owned("ai-teams/team-chat-view.tsx");
  assert.match(source, /<Sender/, "输入框交给通用发送器");
  assert.match(source, /value=\{draft\}/, "值仍来自 bridge");
  assert.match(source, /onChange=\{\(value\) => teamChatComposer\.edit\(chatSessionId, \{ text: value \}\)\}/);
  assert.match(source, /onSubmit=\{\(\) => void send\(\)\}/);
  assert.match(source, /onCancel=\{\(\) => void stop\(\)\}/);
  assert.match(source, /teamChatComposer\.submit\(sessionId, text, async \(payload\) => \{/);
  // 不自己另存一份草稿，也不在页面里加发送锁。
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.equal(chatMessageUrl("relay-a"), "/api/structured-sessions/relay-a/messages");
  assert.deepEqual(chatMessageBody("hi"), { input: "hi" });
  assert.match(source, /headers: \{ "content-type": "application\/json", "X-Wand-Tool-Projection": "compact" \}/);
  assert.equal(CHAT_INPUT_PLACEHOLDER.length > 0, true);
});

test("composer keeps the IME Enter boundary and the unknown-delivery rule", () => {
  const source = owned("ai-teams/team-chat-view.tsx");
  // 发送器自己挡 composition；这里再挡浏览器给的合成态与 229，回车确认候选词不会发送。
  assert.match(source, /submitType="enter"/);
  assert.match(source, /if \(native\.isComposing \|\| event\.keyCode === 229\) return false;/);
  assert.match(source, /chatSendDefinitelyRejected\(cause\)/);
  assert.match(source, /送达状态未知，请先查看群聊记录，避免重复发送。/);
  assert.match(source, /__wandAmbiguousDelivery: true/);
  // 已接受的部分 chunk / ACK 解析失败都按未知送达处理，不自动重发。
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{ void send\(\)/, "没有自动重发");
});

test("live step output uses the shared process block and keeps the bounded scroll owner", () => {
  const source = owned("ai-teams/team-chat-view.tsx");
  assert.match(source, /<Think/);
  assert.match(source, /destroyOnHidden=\{false\}/, "收起时内容不卸载，内部滚动窗口的贴尾状态要留着");
  assert.match(source, /pinnedRef\.current = isFollowingTail\(event\.currentTarget\)/);
  assert.match(source, /className="team-chat-live-text"/);
  assert.match(source, /retireMs = liveExitDurationMs\(\)/);
  assert.match(source, /pruneExpiredLeaving\(current, Date\.now\(\), retireMs\)/);
});

test("delivery and report files render as library file cards and never prefetch file bytes", () => {
  const delivery = teamDeliveryFixture().delivery!;
  const html = renderToStaticMarkup(React.createElement(TeamDeliveryDetails, { delivery }));
  assert.match(html, /ant-file-card/, "交付文件是通用文件卡");
  assert.equal(html.includes("/api/file-"), false, "打开交付列表不发请求、不预载");
  assert.match(html, /真实冻结摘要/);
  assert.ok((html.match(/ant-file-card /g) ?? []).length <= 20, "文件窗口有界");
  const source = owned("ai-teams/team-delivery.tsx");
  assert.match(source, /const files = delivery\.files\.slice\(0, 20\);/, "文件窗口有界");
  assert.match(source, /const handoffs = delivery\.handoffs\.slice\(0, 6\);/, "接力窗口有界");
  assert.match(source, /type="file"/, "交付文件卡固定文件形态，不按扩展名换成图片卡预载");
});

test("ordinary team and employee controls come from the library", () => {
  const text = laneText();
  // 旧的手写输入框样式类与原生控件已经退出这一批页面。
  assert.doesNotMatch(text, /className="wand-settings-input/, "普通输入不再手写外观类");
  assert.doesNotMatch(text, /className="wand-settings-label"/, "标签排版交给通用字段适配");
  assert.doesNotMatch(text, /<textarea\b/, "多行输入统一走库控件");
  assert.match(text, /<Input\b/);
  assert.match(text, /<Input\.TextArea/);
  assert.match(text, /<InputNumber/);
  assert.match(text, /<Card\b/);
  assert.match(text, /<Collapse\b/, "高级配置收进通用折叠面板");
  assert.match(text, /<Empty\b/);
  assert.match(text, /<Checkbox\b/);
  assert.match(text, /<Tooltip\b/);
  // 员工头像毛色是业务身份，保留像素猫，但按钮是通用圆钮。
  const avatar = owned("agents/employee-avatar.tsx");
  assert.match(avatar, /<Button\s+className="wand-team-coat"/);
  assert.match(owned("ai-teams/teams-page.tsx"), /<Button\s+className="wand-team-coat"/);
});

test("employee forms keep their validation, builtin and knowledge rules", () => {
  const create = owned("agents/employee-create-form.tsx");
  assert.match(create, /parseSiliconEmployeeTagInput\(tagInput\)/, "标签仍走同一份校验");
  assert.match(create, /siliconEmployeesRepository\.draft\(expectation\)/, "AI 起草仍是显式动作");
  assert.match(create, /forceRender: true/, "收起高级配置不丢字段状态");
  const card = owned("agents/employee-card.tsx");
  assert.match(card, /isBuiltinSiliconEmployee\(employee\)/);
  assert.match(card, /saveStatus === "saved" \? "已保存" : saveStatus === "failed" \? "保存失败" : "保存修改"/,
    "保存结果仍原位显示在这一枚按钮上");
  assert.match(card, /candidateListError\(draft\.agents\)/);
  assert.doesNotMatch(card, /showWandToast|notification\.|message\.success/, "结果不用浮层替代原位反馈");
  const knowledge = owned("agents/employee-knowledge.tsx");
  assert.match(knowledge, /if \(action === "clear" && !armed\) \{ setArmed\(true\); return; \}/, "清空知识库仍要二次确认");
  assert.match(knowledge, /return \(\) => \{ clearTimeout\(timer\); epoch\.current\+\+; \};/, "迟到的搜索结果不能落地");
});

test("X components stay display-only in this lane", () => {
  const text = laneText();
  for (const hook of ["useXAgent", "useXChat", "useXConversations", "XRequest", "useXSender"]) {
    assert.equal(text.includes(hook), false, `${hook} 不能引入第二个运行/请求 owner`);
  }
  assert.match(owned("ai-teams/team-chat-view.tsx"), /teamChatComposer\.edit/);
});

test("team chat keeps real author identity, @ rendering and arrival bookkeeping", () => {
  const source = owned("ai-teams/team-chat-view.tsx");
  assert.match(source, /export function projectChatTurns\(/);
  assert.match(source, /data-presentation-id=\{presentationId\}/);
  assert.match(source, /const arriving = arrival\.scope === scope && arrival\.ids\.has\(key\);/);
  assert.match(source, /export function displayChatTurn\(/);
  assert.match(source, /export function mergeTeamChatDetail\(/);
  assert.match(source, /export function mergeTeamChatTurns\(/);
});
