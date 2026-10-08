import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { dispatchAgentForTask } from "../src/agent-dispatch.js";
import { defaultConfig } from "../src/config.js";
import { CoreHarnessUnavailableError } from "../src/harness-engine.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { SessionSnapshot } from "../src/types.js";

/**
 * Pi 与 Wand Agent 是同一个 provider 的两条执行路径：
 *   - Pi（cli）：起 `pi --mode json --print` 进程；
 *   - Wand Agent（sdk → 进程内 core）：Wand 进程里用 SDK 跑 agent loop。
 * 显式选了哪条就必须跑哪条，不能静默换口。
 */

function makeManager(t: test.TestContext, options: { withCoreRunner?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-engine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());
  const config = defaultConfig();
  const manager = new StructuredSessionManager(
    storage,
    config,
    null,
    options.withCoreRunner ? { core: {} as never } : {},
  );
  t.after(() => manager.dispose());
  return { manager, storage, root };
}

test("新建会话显式选了 Wand Agent 就用进程内引擎，选了 Pi 就用 CLI", (t) => {
  const { manager, root } = makeManager(t, { withCoreRunner: true });

  const sdk = manager.createSession({
    cwd: root, mode: "managed", provider: "pi", engine: "core",
  });
  assert.equal(sdk.structuredState?.engine, "core", "显式 SDK 会话落库为 core");
  assert.equal(sdk.provider, "pi", "Wand Agent 仍然用 pi provider");

  const cli = manager.createSession({
    cwd: root, mode: "managed", provider: "pi", engine: "cli",
  });
  assert.equal(cli.structuredState?.engine, "cli", "显式 Pi CLI 会话落库为 cli");
});

test("引擎只属于 pi：其他 provider 不接受显式引擎", (t) => {
  const { manager, root } = makeManager(t, { withCoreRunner: true });
  const claude = manager.createSession({
    cwd: root, mode: "managed", provider: "claude", engine: "core",
  });
  assert.equal(claude.structuredState?.engine, undefined, "claude 会话不带引擎标记");
});

test("Wand Agent 不可用时明确报错，不静默退回 CLI 冒充", (t) => {
  // 没有注入 core runner，也没有预热过 core 能力：显式要求 sdk 必须失败。
  const { manager } = makeManager(t);
  assert.throws(() => manager.resolveNewSessionPiEngine("sdk"), CoreHarnessUnavailableError);
  assert.deepEqual(manager.resolveNewSessionPiEngine("cli"), { engine: "cli", reason: "Pi 主功能固定使用 CLI JSON" });
  assert.deepEqual(manager.resolveNewSessionPiEngine(undefined), { engine: "cli", reason: "Pi 主功能固定使用 CLI JSON" });
});

test("Pi 设置面板报告的引擎与会话落库的引擎一致", (t) => {
  const { manager, root } = makeManager(t, { withCoreRunner: true });
  const sdk = manager.createSession({ cwd: root, mode: "managed", provider: "pi", engine: "core" });
  const cli = manager.createSession({ cwd: root, mode: "managed", provider: "pi", engine: "cli" });
  assert.equal(manager.getPiSettings(sdk.id).resolution.engine, "core");
  assert.equal(manager.getPiSettings(cli.id).resolution.engine, "cli");
  // SDK 会话不静默继承 CLI 专属的会话级资源选择。
  assert.throws(() => manager.setPiSettings(sdk.id, { autoResources: true }), /Wand Agent/);
});

test("任务直接派发 Wand Agent：先裁决引擎再建会话，不要求绑定员工", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());
  const created: Array<Record<string, unknown>> = [];
  const structured = {
    resolveNewSessionPiEngine(engine: string) {
      return { engine: engine === "sdk" ? "core" : "cli", reason: "" };
    },
    createSession(options: Record<string, unknown>) {
      created.push(options);
      const session: SessionSnapshot = {
        id: "sdk-session", sessionKind: "structured", sessionSource: "automation",
        provider: "pi", runner: "pi-cli-json", command: "pi --mode json --print",
        cwd: root, mode: "managed", status: "running", exitCode: null,
        startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, output: "", archived: false,
        archivedAt: null, claudeSessionId: null,
      };
      storage.saveSession(session);
      return session;
    },
    sendMessage() { return Promise.resolve(); },
  } as unknown as StructuredSessionManager;
  const task = storage.createWandTask({ title: "跑一次 Wand Agent", description: "验证 SDK 派发" });
  const config = defaultConfig();
  await dispatchAgentForTask(
    { storage, config, structured, processes: null },
    {
      task: storage.getWandTask(task.id)!,
      agent: { provider: "pi", model: "default", thinkingEffort: "off", mode: "managed", kind: "structured", engine: "sdk" },
      prompt: "开始",
      automationId: `wand-task:${task.id}`,
    },
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].engine, "core", "派发时把裁决结果交给会话创建，而不是让服务端自己猜");
  assert.equal(created[0].provider, "pi");
});
