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
  assert.equal((home.match(/新消息开始新工作；补充上一项请打开对应会话。/g) || []).length, 1, "explain the context boundary and the actual continuation path once");
  assert.match(home, /selected\.kind === "dm" \? "把要完成的事发给我/, "first-use guidance is limited to a genuinely empty private conversation");
  assert.match(home, /\|\| !id \|\| !selected \|\| !!selected\.unavailableReason/, "unloaded target cannot accept a silently ignored submit");
  assert.match(team, /回复『批准』即开工/, "permission guidance is not useless copy");
});
