import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { StructuredRunnerAdapter } from "../src/structured-runner.js";

test("relay sessions hand user input to their handler and never start a CLI turn", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-relay-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  let started = 0;
  const runner: StructuredRunnerAdapter = {
    start() {
      started += 1;
      throw new Error("relay sessions must not spawn");
    },
  };
  const manager = new StructuredSessionManager(
    storage, { ...defaultConfig(), defaultCwd: root }, null, { pi: runner },
  );
  t.after(() => manager.dispose());
  const received: string[] = [];
  manager.registerRelay("ai-team-chat:", (sessionId, text) => {
    received.push(text);
    manager.appendRelayTurns(sessionId, [{
      role: "assistant", author: { id: "m_lead", name: "负责人", leader: true },
      content: [{ type: "text", text: `收到：${text}` }],
    }]);
  });
  const chat = manager.createRelaySession({
    cwd: root, mode: "full-access", provider: "pi", automationId: "ai-team-chat:run_1", title: "团队 · 任务",
  });
  assert.equal(chat.title, "团队 · 任务");

  const after = await manager.sendMessage(chat.id, "开始吧");
  assert.equal(started, 0);
  assert.deepEqual(received, ["开始吧"]);
  assert.equal(after.status, "idle");
  assert.deepEqual(after.messages?.map((turn) => [turn.role, turn.author?.name ?? "", turn.content[0]]), [
    ["user", "", { type: "text", text: "开始吧" }],
    ["assistant", "负责人", { type: "text", text: "收到：开始吧" }],
  ]);
  // 作者信息随消息落盘，重启后群聊照样按成员显示。
  assert.equal(storage.getSession(chat.id)?.messages?.[1]?.author?.name, "负责人");
});

test("a relay handler failure is shown in the chat instead of being thrown away", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-relay-fail-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null);
  t.after(() => manager.dispose());
  manager.registerRelay("ai-team-chat:", () => {
    throw new Error("团队已被删除");
  });
  const chat = manager.createRelaySession({
    cwd: root, mode: "full-access", provider: "claude", automationId: "ai-team-chat:run_2", title: "群聊",
  });
  const after = await manager.sendMessage(chat.id, "继续");
  const last = after.messages?.at(-1);
  assert.equal(last?.notice, true);
  assert.deepEqual(last?.content, [{ type: "text", text: "没能转达：团队已被删除" }]);
});
