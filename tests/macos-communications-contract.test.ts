import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { employeeConversationId } from "../src/conversation-types.js";
import { conversationMentionToken, conversationLeaderMention } from "../src/conversation-mentions.js";
import { agentToolDisplayName } from "../src/web-ui/provider-identity.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/native-communications.json", import.meta.url), "utf8")) as {
  synthetic: boolean;
  contacts: Array<{ id: string; agents: Array<{ provider: string; engine?: "sdk" | "cli" }> }>;
  conversations: Array<{
    id: string; kind: string; peerEmployeeId?: string;
    team?: { members: Array<{ id: string; name: string }> };
    messages: Array<{ sessionLink?: { sessionId: string }; conversationLink?: { conversationId: string }; taskPreview?: { runId?: string } }>;
  }>;
};

test("native communications fixture stays self-contained and agrees with stable employee DM and execution identities", () => {
  assert.equal(fixture.synthetic, true);
  const mirror = new URL("../macos/WandTests/Fixtures/communications.json", import.meta.url);
  if (existsSync(mirror)) assert.deepEqual(JSON.parse(readFileSync(mirror, "utf8")), fixture);
  for (const item of fixture.conversations.filter(item => item.kind === "dm")) {
    assert.equal(item.id, employeeConversationId(item.peerEmployeeId!));
  }
  assert.equal(agentToolDisplayName(fixture.contacts[0]!.agents[0]!.provider, fixture.contacts[0]!.agents[0]!.engine), "Wand Agent");
  const direct = fixture.conversations[0]!;
  assert.equal(direct.messages.find(message => message.sessionLink)?.sessionLink?.sessionId, "session-exact");
  const task = fixture.conversations[1]!.messages.find(message => message.conversationLink)!;
  assert.equal(task.conversationLink?.conversationId, "group-fixture");
  assert.equal(task.taskPreview?.runId, "run-fixture");
});

test("native member-ID mention insertions address exact members without relying on display-name uniqueness", () => {
  const members = fixture.conversations.find(item => item.kind === "group")!.team!.members;
  for (const member of members) {
    const addressed = conversationLeaderMention(`@${member.id} fixture-only`, members);
    assert.ok(addressed && !("error" in addressed));
    assert.equal(addressed.memberId, member.id);
  }
  const duplicate = [{ id: "a", name: "同名" }, { id: "b", name: "同名" }];
  assert.equal(conversationMentionToken(duplicate[0]!, duplicate), "@a");
  assert.deepEqual(conversationLeaderMention("@a fixture-only", duplicate), { memberId: "a", name: "同名", body: "fixture-only" });
});
