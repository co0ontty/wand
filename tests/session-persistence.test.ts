import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { ConversationTurn, SessionSnapshot, StructuredSessionState } from "../src/types.js";

class CountingStorage extends WandStorage {
  fullSaveCalls = 0;
  runtimeMetadataCalls = 0;
  outputCheckpointCalls = 0;
  messageCheckpointCalls = 0;

  override saveSession(snapshot: SessionSnapshot): void {
    this.fullSaveCalls += 1;
    super.saveSession(snapshot);
  }

  override updateSessionRuntimeMetadata(snapshot: SessionSnapshot): void {
    this.runtimeMetadataCalls += 1;
    super.updateSessionRuntimeMetadata(snapshot);
  }

  override checkpointSessionOutput(id: string, output: string): void {
    this.outputCheckpointCalls += 1;
    super.checkpointSessionOutput(id, output);
  }

  override checkpointSessionMessages(
    id: string,
    messages: ConversationTurn[],
    structuredState?: StructuredSessionState | null,
    output?: string,
  ): void {
    this.messageCheckpointCalls += 1;
    super.checkpointSessionMessages(id, messages, structuredState, output);
  }

  resetCounts(): void {
    this.fullSaveCalls = 0;
    this.runtimeMetadataCalls = 0;
    this.outputCheckpointCalls = 0;
    this.messageCheckpointCalls = 0;
  }
}

function createHarness(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-persistence-"));
  const storage = new CountingStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" },
  );
  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner: "claude-sdk",
  });
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, storage, session };
}

test("structured model, mode, effort, and topic updates only touch runtime metadata", (t) => {
  const { manager, storage, session } = createHarness(t);
  storage.resetCounts();

  manager.setSessionModel(session.id, "claude-sonnet-4-6");
  manager.setSessionThinkingEffort(session.id, "deep");
  manager.setSessionMode(session.id, "managed");
  manager.setSessionTopic(session.id, "Targeted", "No message rewrite");

  assert.equal(storage.runtimeMetadataCalls, 4);
  assert.equal(storage.fullSaveCalls, 0);
  assert.equal(storage.messageCheckpointCalls, 0);
  assert.equal(storage.outputCheckpointCalls, 0);
});

test("streaming checkpoints are bounded, trailing, and authoritative on dispose", async (t) => {
  const { manager, storage, session } = createHarness(t);
  const blocks = Array.from({ length: 10_000 }, (_, index) => ({
    type: "text" as const,
    text: `block-${index}`,
  }));
  const messages: ConversationTurn[] = [{ role: "assistant", content: blocks }];
  const internal = manager as unknown as {
    sessions: Map<string, SessionSnapshot>;
    saveStreamingSnapshot(snapshot: SessionSnapshot): void;
  };
  let latest: SessionSnapshot = {
    ...session,
    status: "running",
    output: "chunk-0",
    messages,
    structuredState: {
      ...(session.structuredState as StructuredSessionState),
      inFlight: true,
      activeRequestId: "stream-request",
    },
  };
  internal.sessions.set(session.id, latest);
  storage.resetCounts();

  // The first dirty event is a leading checkpoint. Hundreds of subsequent
  // events — despite carrying a 10k-block snapshot — collapse into one trailing
  // checkpoint instead of serializing once per event.
  internal.saveStreamingSnapshot(latest);
  for (let index = 1; index <= 500; index += 1) {
    latest = { ...latest, output: `chunk-${index}` };
    internal.sessions.set(session.id, latest);
    internal.saveStreamingSnapshot(latest);
  }
  assert.equal(storage.messageCheckpointCalls, 1);
  assert.equal(storage.fullSaveCalls, 0);

  await delay(1_100);

  assert.equal(storage.messageCheckpointCalls, 2, "latest dirty snapshot should flush within one throttle window");
  assert.equal(storage.getSession(session.id)?.output, "chunk-500");

  manager.dispose();
  const durable = storage.getSession(session.id);
  assert.equal(storage.fullSaveCalls, 1);
  assert.equal(durable?.status, "idle");
  assert.equal(durable?.structuredState?.inFlight, false);
  assert.equal(durable?.output, "chunk-500");
  assert.equal(durable?.messages?.[0]?.content.length, 10_000);
});
