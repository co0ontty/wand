import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { defaultConfig } from "../src/config.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import { SessionTopicCoordinator } from "../src/session-topic.js";
import { WandStorage } from "../src/storage.js";
import type { StructuredRunnerAdapter } from "../src/structured-runner.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-scheduled-topic-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const prompts: string[] = [];
  const titleInputs: string[][] = [];
  // Both execution and title generation are explicit in-memory doubles, with no model or CLI invocation.
  const runner: StructuredRunnerAdapter = {
    start(context) {
      prompts.push(context.prompt);
      return { args: [], pid: null, spawnedAt: new Date().toISOString(), interrupt() {},
        completion: Promise.resolve({ state: { blocks: [{ type: "text", text: "明确测试替身执行完成" }],
          result: "明确测试替身执行完成", sessionId: null }, exitCode: 0, signal: null, stderr: "", primaryError: null,
          inputAccepted: true }) };
    },
  };
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root,
    harness: { engine: "cli", agentDir: path.join(root, "unused-agent") } }, null, { claudeCli: runner });
  const coordinator = new SessionTopicCoordinator(async messages => {
    titleInputs.push([...messages]);
    return { title: "系统总结的另一标题", description: "明确标题模型替身", source: "model" };
  });
  Object.assign(manager, { topicCoordinator: coordinator });
  t.after(async () => {
    manager.dispose();
    await whenIterationPromptsSettled();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, storage, root, prompts, titleInputs };
}

const prompt = "这是需要整理的原始帖子，与计划标题不同。\n\n请完整阅读后给出明确摘要，并保留重要细节。";

test("scheduled employee sessions retain the plan title and skip the system title model for long prompts", async t => {
  const h = fixture(t);
  const session = h.manager.createSession({ cwd: h.root, provider: "claude", mode: "full-access", title: "每日帖子摘要",
    sessionSource: "automation", automationId: "conversation-message:scheduled:schedrun_topic-test", employeeId: "e_topic_test" });
  const finished = await h.manager.sendMessage(session.id, prompt);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished.status, "idle");
  assert.deepEqual(h.prompts, [prompt]);
  assert.equal(h.titleInputs.length, 0);
  assert.equal(h.manager.get(session.id)?.title, "每日帖子摘要");
  assert.equal(h.storage.getSession(session.id)?.title, "每日帖子摘要");
  assert.equal(h.manager.get(session.id)?.messages?.find(turn => turn.role === "user")?.content[0]?.type, "text");
});

test("ordinary employee DMs still generate session topics from long prompts", async t => {
  const h = fixture(t);
  const session = h.manager.createSession({ cwd: h.root, provider: "claude", mode: "full-access", title: "原有会话标题",
    sessionSource: "interactive", automationId: "conversation-message:ordinary-dm-request", employeeId: "e_topic_test" });
  await h.manager.sendMessage(session.id, prompt);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.prompts, [prompt]);
  assert.deepEqual(h.titleInputs, [[prompt]]);
  assert.equal(h.manager.get(session.id)?.title, "系统总结的另一标题");
});
