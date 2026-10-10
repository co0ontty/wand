import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import { ProcessManager } from "../src/process-manager.js";
import type { SessionTopicRequest } from "../src/session-topic.js";
import { WandStorage } from "../src/storage.js";
import type { TerminalHost } from "../src/terminal-host.js";
import type { ProcessEvent } from "../src/types.js";

function harness(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pty-topic-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const writes: string[] = [];
  const host: TerminalHost = {
    persistent: false,
    attach: () => null,
    async createOrAttach(request) {
      return {
        process: { sessionId: request.sessionId, incarnationId: request.sessionId, pid: 999_999_999,
          write: (data) => { writes.push(data); }, resize() {}, kill() {},
          onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) },
        state: { sessionId: request.sessionId, incarnationId: request.sessionId, pid: 999_999_999,
          status: "running", exitCode: null, cols: request.cols, rows: request.rows, seq: 0,
          output: "", chunks: [], terminalSnapshot: null, launchMarkerToken: null },
        replay: [], isNew: true,
      };
    },
    forget() {}, disconnect() {},
  };
  const manager = new ProcessManager({ ...defaultConfig(), defaultCwd: root, startupCommands: [] },
    storage, path.join(root, ".wand"), host);
  const requests: SessionTopicRequest[] = [];
  // Intercept the coordinator boundary so a regression cannot launch a real model.
  Object.assign(manager, { topicCoordinator: { request: (_id: string, request: SessionTopicRequest) => {
    requests.push(request);
  }, clear() {} } });
  const events: ProcessEvent[] = [];
  manager.on("process", (event) => events.push(event));
  t.after(async () => {
    await whenIterationPromptsSettled();
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, storage, manager, requests, writes, events };
}

test("blank terminals keep their titles and command records across every input path", async (t) => {
  const { root, storage, manager, requests, writes, events } = harness(t);
  const initial = "printf initial_shell_command";
  const session = await manager.start("/bin/zsh", root, "default", initial, { interactiveShell: true });
  assert.equal(manager.get(session.id)?.title, undefined);
  manager.setSessionTopic(session.id, "我的终端", "手动说明");
  manager.sendInput(session.id, "printf composer_shell_command", "terminal", "enter_text");
  manager.sendInput(session.id, "\r", "terminal");
  await manager.sendInputConfirmed(session.id, "printf chat_shell_command", "chat");
  for (const chunk of ["printf ", "raw_shell_command", "\r"]) {
    manager.sendInput(session.id, chunk, "terminal");
  }
  await whenIterationPromptsSettled();
  assert.deepEqual(requests, []);
  assert.equal(events.some((event) => (event.data as { titleGenerating?: boolean })?.titleGenerating), false);
  assert.equal(manager.get(session.id)?.title, "我的终端");
  assert.equal(storage.getSession(session.id)?.description, "手动说明");
  assert.equal(storage.latestIterationPromptForSession(session.id)?.detail, "printf raw_shell_command");
  assert.ok(writes.join("").includes("raw_shell_command\r"));
});

test("Agent PTY input still gets a provisional title and requests model summarization", async (t) => {
  const { root, manager, requests } = harness(t);
  const session = await manager.start("pi", root, "default", undefined, {
    provider: "pi", automationId: "topic-regression-test",
  });
  const input = "分析项目构建失败原因并修复";
  manager.sendInput(session.id, input, "terminal", "enter_text");
  assert.equal(manager.get(session.id)?.title, input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, input);
});
