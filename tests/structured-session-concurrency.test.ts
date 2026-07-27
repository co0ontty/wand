import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { SessionProvider, SessionRunner, SessionSnapshot } from "../src/types.js";

class DeferredSdkQuery {
  interruptCalls = 0;
  private done = false;
  private wake: (() => void) | null = null;

  async interrupt(): Promise<void> {
    this.interruptCalls++;
  }

  finish(): void {
    this.done = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<never> {
    while (!this.done) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

class AskUserSdkQuery {
  interruptCalls = 0;
  private done = false;
  private releaseInterrupt: (() => void) | null = null;

  async interrupt(): Promise<void> {
    this.interruptCalls++;
    if (this.done) return;
    await new Promise<void>((resolve) => {
      this.releaseInterrupt = () => {
        this.done = true;
        resolve();
      };
    });
  }

  release(): void {
    this.done = true;
    this.releaseInterrupt?.();
    this.releaseInterrupt = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: "assistant",
      session_id: "11111111-1111-4111-8111-111111111111",
      parent_tool_use_id: null,
      message: {
        id: "assistant-ask",
        content: [{
          type: "tool_use",
          id: "ask-1",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Choose", options: ["one", "two"] }] },
        }],
      },
    };
    while (!this.done) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function createSdkHarness(t: TestContext, configuredRunner: "cli" | "sdk" = "sdk") {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-generation-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const queries: DeferredSdkQuery[] = [];
  const sdkQueryFactory = (() => {
    const query = new DeferredSdkQuery();
    queries.push(query);
    return query;
  }) as unknown as ConstructorParameters<typeof StructuredSessionManager>[3];
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: configuredRunner },
    null,
    sdkQueryFactory,
  );
  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner: "claude-sdk",
  });
  manager.setSessionTopic(session.id, "test", "test");

  t.after(() => {
    for (const query of queries) query.finish();
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, queries, session };
}

test("Claude SDK receives the per-message skill allowlist", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-skills-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const queries: DeferredSdkQuery[] = [];
  const requests: Array<{ options?: { skills?: string[] } }> = [];
  const sdkQueryFactory = ((request: { options?: { skills?: string[] } }) => {
    requests.push(request);
    const query = new DeferredSdkQuery();
    queries.push(query);
    return query;
  }) as unknown as ConstructorParameters<typeof StructuredSessionManager>[3];
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" },
    null,
    sdkQueryFactory,
  );
  const session = manager.createSession({ cwd: root, mode: "assist", provider: "claude", runner: "claude-sdk" });
  manager.setSessionTopic(session.id, "test", "test");
  t.after(() => {
    for (const query of queries) query.finish();
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const run = manager.sendMessage(session.id, "review this", { skills: ["review", "testing"] });
  await waitFor(() => requests.length === 1, "SDK query did not start");
  assert.deepEqual(requests[0].options?.skills, ["review", "testing"]);

  manager.stop(session.id);
  queries[0].finish();
  await run;
});

test("session runner overrides the opposite global Claude runner", async (t) => {
  const { manager, queries, session } = createSdkHarness(t, "cli");
  assert.equal(session.runner, "claude-sdk");

  const run = manager.sendMessage(session.id, "use the session runner");
  await waitFor(() => queries.length === 1, "explicit SDK session did not use the SDK runner");

  manager.stop(session.id);
  queries[0].finish();
  await run;
});

test("session creation validates provider-runner combinations and applies defaults", (t) => {
  const { manager } = createSdkHarness(t, "sdk");
  const base = { cwd: os.tmpdir(), mode: "assist" as const };

  assert.equal(manager.createSession({ ...base, provider: "claude" }).runner, "claude-sdk");
  assert.equal(manager.createSession({ ...base, provider: "claude", runner: "claude-cli-print" }).runner, "claude-cli-print");
  assert.equal(manager.createSession({ ...base, provider: "codex" }).runner, "codex-cli-exec");
  assert.equal(manager.createSession({ ...base, provider: "opencode" }).runner, "opencode-cli-run");
  assert.equal(manager.createSession({ ...base, provider: "grok" }).runner, "grok-cli-headless");
  assert.equal(manager.createSession({ ...base, provider: "qoder" }).runner, "qoder-cli-print");

  const runners: SessionRunner[] = [
    "claude-cli",
    "claude-cli-print",
    "claude-sdk",
    "codex-cli-exec",
    "opencode-cli-run",
    "grok-cli-headless",
    "qoder-cli-print",
    "pty",
  ];
  const allowed: Record<SessionProvider, SessionRunner[]> = {
    claude: ["claude-cli-print", "claude-sdk"],
    codex: ["codex-cli-exec"],
    opencode: ["opencode-cli-run"],
    grok: ["grok-cli-headless"],
    qoder: ["qoder-cli-print"],
  };
  for (const provider of ["claude", "codex", "opencode", "grok", "qoder"] as const) {
    for (const runner of runners) {
      if (allowed[provider].includes(runner)) continue;
      assert.throws(
        () => manager.createSession({ ...base, provider, runner }),
        /不支持 provider/,
        `${provider} should reject ${runner}`,
      );
    }
  }
});

test("an interrupted runner stays in-flight until its owning completion releases it", async (t) => {
  const { manager, queries, session } = createSdkHarness(t);
  let killCalls = 0;
  const fakeExecution = {
    interrupt: () => {
      killCalls++;
    },
  };
  const internal = manager as unknown as {
    sessions: Map<string, SessionSnapshot>;
    pendingRunnerExecutions: Map<string, unknown>;
  };
  internal.sessions.set(session.id, {
    ...session,
    status: "running",
    structuredState: {
      ...(session.structuredState as NonNullable<SessionSnapshot["structuredState"]>),
      inFlight: true,
      activeRequestId: "request-before-close",
    },
  });
  internal.pendingRunnerExecutions.set(session.id, fakeExecution);

  const queued = await manager.sendMessage(session.id, "wait for close");
  assert.deepEqual(queued.queuedMessages, ["wait for close"]);
  assert.equal(queries.length, 0, "a second runner started before the child closed");
  assert.equal(queued.structuredState?.activeRequestId, "request-before-close");

  manager.stop(session.id);
  assert.equal(killCalls, 1);
});

test("an AskUserQuestion answer queued before SDK close advances as a tool result", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-ask-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const askQuery = new AskUserSdkQuery();
  const followupQuery = new DeferredSdkQuery();
  let queryCount = 0;
  const sdkQueryFactory = (() => {
    queryCount++;
    return queryCount === 1 ? askQuery : followupQuery;
  }) as unknown as ConstructorParameters<typeof StructuredSessionManager>[3];
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" },
    null,
    sdkQueryFactory,
  );
  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner: "claude-sdk",
  });
  manager.setSessionTopic(session.id, "test", "test");
  t.after(() => {
    askQuery.release();
    followupQuery.finish();
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const firstRun = manager.sendMessage(session.id, "start");
  await waitFor(() => askQuery.interruptCalls === 1, "AskUserQuestion did not interrupt the SDK turn");

  const queued = await manager.sendMessage(session.id, "two");
  assert.deepEqual(queued.queuedMessages, ["two"]);
  askQuery.release();
  await firstRun;

  await waitFor(() => queryCount === 2, "queued AskUserQuestion answer did not advance");
  const answering = manager.get(session.id);
  assert.equal(answering?.structuredState?.inFlight, true);
  assert.deepEqual(answering?.queuedMessages, []);
  const answerTurn = answering?.messages?.slice().reverse().find((turn) => turn.role === "user");
  assert.deepEqual(answerTurn?.content[0], {
    type: "tool_result",
    tool_use_id: "ask-1",
    content: "two",
    is_error: false,
  });

  manager.stop(session.id);
  followupQuery.finish();
});

test("Claude CLI AskUserQuestion SIGTERM finishes as a waiting turn, not a failure", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-cli-ask-"));
  const binDir = path.join(root, "bin");
  const claudePath = path.join(binDir, "claude");
  const originalPath = process.env.PATH;
  mkdirSync(binDir);
  writeFileSync(claudePath, `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"assistant","session_id":"22222222-2222-4222-8222-222222222222","message":{"id":"assistant-ask","content":[{"type":"tool_use","id":"ask-cli-1","name":"AskUserQuestion","input":{"questions":[{"question":"Choose","options":["one","two"]}]}}]}}'
exec sleep 30
`, "utf8");
  chmodSync(claudePath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: "cli", inheritEnv: true },
  );
  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner: "claude-cli-print",
  });
  manager.setSessionTopic(session.id, "test", "test");
  t.after(() => {
    manager.dispose();
    storage.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  const waiting = await manager.sendMessage(session.id, "ask me");
  assert.equal(waiting.status, "running");
  assert.equal(waiting.structuredState?.inFlight, false);
  assert.equal(waiting.structuredState?.lastError, null);
  assert.ok(waiting.messages?.at(-1)?.content.some(
    (block) => block.type === "tool_use" && block.name === "AskUserQuestion",
  ));
});

test("queued SDK messages retain their selected skills through queue operations", async (t) => {
  const { manager, queries, session } = createSdkHarness(t);
  const run = manager.sendMessage(session.id, "first");
  await waitFor(() => queries.length === 1, "first SDK query did not start");

  await manager.sendMessage(session.id, "second", { skills: ["review"] });
  await manager.sendMessage(session.id, "third", { skills: ["testing"] });
  assert.deepEqual(manager.get(session.id)?.queuedMessageSkills, [["review"], ["testing"]]);

  manager.reorderQueuedMessages(session.id, [1, 0]);
  assert.deepEqual(manager.get(session.id)?.queuedMessageSkills, [["testing"], ["review"]]);

  manager.deleteQueuedMessage(session.id, 0);
  assert.deepEqual(manager.get(session.id)?.queuedMessages, ["second"]);
  assert.deepEqual(manager.get(session.id)?.queuedMessageSkills, [["review"]]);

  manager.stop(session.id);
  queries[0].finish();
  await run;
});

test("SDK in-flight queries queue a second message instead of starting concurrently", async (t) => {
  const { manager, queries, session } = createSdkHarness(t);

  const firstRun = manager.sendMessage(session.id, "first");
  await waitFor(() => queries.length === 1, "first SDK query did not start");
  const firstRequestId = manager.get(session.id)?.structuredState?.activeRequestId;

  const queued = await manager.sendMessage(session.id, "second");
  assert.equal(queries.length, 1);
  assert.deepEqual(queued.queuedMessages, ["second"]);
  assert.equal(queued.structuredState?.activeRequestId, firstRequestId);
  assert.equal(queued.structuredState?.inFlight, true);

  manager.stop(session.id);
  queries[0].finish();
  await firstRun;
});

test("a stopped SDK query cannot overwrite or release a newer query", async (t) => {
  const { manager, queries, session } = createSdkHarness(t);

  const firstRun = manager.sendMessage(session.id, "first");
  await waitFor(() => queries.length === 1, "first SDK query did not start");
  manager.stop(session.id);

  const secondRun = manager.sendMessage(session.id, "second");
  await waitFor(() => queries.length === 2, "second SDK query did not start");
  const secondRequestId = manager.get(session.id)?.structuredState?.activeRequestId;
  assert.ok(secondRequestId);

  // Let the stopped turn unwind only after the replacement owns the maps.
  queries[0].finish();
  await firstRun;

  const afterOldClose = manager.get(session.id);
  assert.equal(afterOldClose?.structuredState?.activeRequestId, secondRequestId);
  assert.equal(afterOldClose?.structuredState?.inFlight, true);

  const queued = await manager.sendMessage(session.id, "third");
  assert.equal(queries.length, 2, "old cleanup removed the replacement query handle");
  assert.deepEqual(queued.queuedMessages, ["third"]);

  manager.stop(session.id);
  queries[1].finish();
  await secondRun;
});

test("structured escalation resolution validates pending request and preserves resolution", (t) => {
  const { manager, session } = createSdkHarness(t);
  const internal = manager as unknown as { sessions: Map<string, SessionSnapshot> };

  assert.throws(
    () => manager.resolveEscalation(session.id, "missing", "approve_once"),
    /没有待处理/,
  );

  internal.sessions.set(session.id, {
    ...session,
    permissionBlocked: true,
    pendingEscalation: {
      requestId: "request-1",
      scope: "run_command",
      runner: "json",
      source: "tool_permission_request",
      reason: "run tests",
    },
  });

  assert.throws(
    () => manager.resolveEscalation(session.id, "stale-request", "approve_once"),
    /已失效/,
  );
  assert.throws(
    () => manager.resolveEscalation(session.id, "request-1", "approve_everything"),
    /resolution 必须/,
  );
  assert.equal(manager.get(session.id)?.pendingEscalation?.requestId, "request-1");
  assert.equal(manager.get(session.id)?.approvalStats?.total, 0);

  const approved = manager.resolveEscalation(session.id, "request-1", "approve_turn");
  assert.equal(approved.pendingEscalation, null);
  assert.equal(approved.permissionBlocked, false);
  assert.deepEqual(approved.lastEscalationResult, {
    requestId: "request-1",
    resolution: "approve_turn",
    reason: "user_approved",
  });
  assert.equal(approved.approvalStats?.command, 1);
  assert.equal(approved.approvalStats?.total, 1);
});
