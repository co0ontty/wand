import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRealtimeRenderHarness, textTurn } from "./helpers/realtime-refresh-harness.js";

for (const provider of ["claude", "codex", "pi", "opencode"]) {
  test(`${provider} empty chat renders no invented welcome or provider promise`, () => {
    const h = createRealtimeRenderHarness();
    h.setMessages([]); h.state.sessions[0].provider = provider;
    h.chat.doRenderChat(false);
    assert.equal(h.messages.innerHTML, "");
    const writes = h.fullWrites();
    h.chat.doRenderChat(false);
    assert.equal(h.fullWrites(), writes, "quiet polling does not rewrite the empty stream");
    h.setMessages([textTurn("真实的第一条消息", "user")]); h.chat.doRenderChat(false);
    assert.match(h.bodyAt(0), /真实的第一条消息/);
    h.setMessages([]); h.chat.doRenderChat(false);
    assert.equal(h.messages.innerHTML, "", "returning to empty cannot retain a previous reply or tutorial");
  });
}

test("deselecting a session clears its stream without teaching the user to send", () => {
  const h = createRealtimeRenderHarness();
  h.setMessages([textTurn("历史内容")]); h.chat.doRenderChat(false);
  h.state.selectedId = null; h.state.sessions = []; h.state.currentMessages = [];
  h.chat.doRenderChat(false);
  assert.equal(h.messages.innerHTML, "");
  assert.equal(h.state.lastRenderedEmpty, "none");
});

test("chat surfaces keep meaningful conditions, not permanent empty-state teaching", () => {
  const root = new URL("../src/web-ui/", import.meta.url);
  const chat = readFileSync(new URL("browser/chat-render.ts", root), "utf8");
  const home = readFileSync(new URL("react/conversations/home.tsx", root), "utf8");
  const team = readFileSync(new URL("react/ai-teams/team-chat-view.tsx", root), "utf8");
  assert.doesNotMatch(chat + home + team, /在下方输入框发送消息|Claude 会自动回复|对话已开始|开始你的第一次对话|群已建立。可以先沟通|回复会在这里实时显示|在下方消息框填写任务要求|群聊还没有消息。/);
  assert.match(home, /const emptyNotice = turns\.length \|\| loadError/);
  assert.match(home, /正在加载对话/); assert.match(home, /此任务暂无消息/);
  assert.match(home, /loadError.*只读重试/);
  assert.match(home, /if \(next === "sent"\) setFeedback\(""\)/, "only successful feedback expires; errors remain available");
  assert.doesNotMatch(home, /hidden=\{!target && !feedback/);
  assert.equal((home.match(/>取消派发<\/WandButton>/g) || []).length, 1);
  assert.equal((home.match(/每次发送创建独立工作；补充已有工作请使用回复中的「继续此工作」。/g) || []).length, 1, "explain the context boundary on the new-work label without a permanent teaching row");
  assert.match(home, /placeholder=\{inputPlaceholder\}/);
  assert.match(home, /描述一项新工作…/);
  assert.match(home, /onOpenSession\(previousWork\.sessionId\)/, "continuation opens the actual prior work without a fresh dispatch");
  assert.match(home, /selected\.kind === "dm" \? "把要完成的事发给我/, "first-use guidance is limited to a genuinely empty private conversation");
  assert.match(home, /\|\| !id \|\| !selected \|\| !!selected\.unavailableReason/, "unloaded target cannot accept a silently ignored submit");
  assert.match(team, /回复『批准』即开工/, "permission guidance is not useless copy");
});

test("会话页样式在骨架帧就位，且几何属性不参与过渡动画", () => {
  const home = readFileSync(new URL("../src/web-ui/react/conversations/home.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/react/conversations/home-styles.ts", import.meta.url), "utf8");
  // 骨架屏用的是同一批类名，样式表晚一帧安装就会让标题 16→20px、发送按钮 padding 0→12px。
  const mount = home.slice(home.indexOf("export function ConversationHome("), home.indexOf("function ReadyConversationHome("));
  assert.match(mount, /React\.useLayoutEffect\(\(\) => \{ installChatComposerStyles\(\); installConversationHomeStyles\(\); \}, \[\]\);/,
    "样式必须在 ConversationHome 本体里安装，骨架帧和真实页面共用同一套几何");
  assert.doesNotMatch(home.slice(home.indexOf("function ReadyConversationHome(")), /installConversationHomeStyles\(\);/,
    "真实页面不再单独安装，避免骨架帧缺样式");
  // antd 按钮默认 transition:all，会把晚到的字号/内边距当动画播放 240ms。
  assert.match(styles, /transition-property: color, background-color, border-color, box-shadow, opacity;/);
  assert.match(styles, /\.conversation-root \.conversation-heading-title,\n\.conversation-root \.conversation-submit-labelled\.ant-btn,/);
  // 空态提示不参与阅读列布局：它撤掉时投影槽必须留在原处。
  assert.match(styles, /\.conversation-message-scroll > \.conversation-empty:first-child \{ position:absolute; inset-block-start:var\(--conversation-scroll-pad-top\)/);
});
