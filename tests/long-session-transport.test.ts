import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { WebSocket, type WebSocketServer } from "ws";

import { blockWindowMessagesForTransport } from "../src/message-truncator.js";
import { SESSION_TRANSPORT_OUTPUT_LIMIT, toSessionDetailDTO } from "../src/session-transport.js";
import type { ConversationTurn, ProcessEvent, SessionSnapshot } from "../src/types.js";
import { WsBroadcastManager } from "../src/ws-broadcast.js";

function longSnapshot(messages: ConversationTurn[], output: string): SessionSnapshot {
  return {
    id: "long-session",
    sessionKind: "structured",
    provider: "claude",
    runner: "claude-cli-print",
    command: "claude",
    cwd: "/repo",
    mode: "assist",
    status: "running",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    output,
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    messages,
  };
}

test("10k-block DTO remains bounded with multi-megabyte output", () => {
  const messages: ConversationTurn[] = [{
    role: "assistant",
    content: Array.from({ length: 10_000 }, (_, index) => ({ type: "text", text: `block-${index}` })),
  }];
  const output = "x".repeat(5 * 1024 * 1024);
  const started = performance.now();
  const windowed = blockWindowMessagesForTransport(messages, {}, 2_000);
  const dto = toSessionDetailDTO(longSnapshot(messages, output), {
    messages: windowed.messages,
    messageOffset: windowed.messageOffset,
    messageTotal: windowed.messageTotal,
    leadingBlockOffset: windowed.leadingBlockOffset,
    leadingBlockTotal: windowed.leadingBlockTotal,
  });
  const encoded = JSON.stringify(dto);
  const elapsedMs = performance.now() - started;

  assert.equal(dto.messages?.[0]?.content.length, 2_000);
  assert.equal(dto.leadingBlockOffset, 8_000);
  assert.equal(dto.output.length, SESSION_TRANSPORT_OUTPUT_LIMIT);
  assert.equal(dto.outputOffset, output.length - SESSION_TRANSPORT_OUTPUT_LIMIT);
  assert.equal(dto.outputTruncated, true);
  assert.ok(Buffer.byteLength(encoded) < 600_000, "transport frame should remain well below one MiB");
  assert.ok(elapsedMs < 1_500, `10k-block transport conversion took ${elapsedMs.toFixed(1)}ms`);
});

test("multiple slow WebSocket clients receive independently bounded long-session frames", () => {
  const manager = new WsBroadcastManager({} as WebSocketServer) as unknown as {
    clients: Set<Record<string, unknown>>;
    broadcast(event: ProcessEvent): void;
  };
  const frames: string[][] = [];
  for (let index = 0; index < 3; index += 1) {
    const sent: string[] = [];
    frames.push(sent);
    manager.clients.add({
      ws: {
        readyState: WebSocket.OPEN,
        send(message: string, _callback?: (error?: Error) => void) { sent.push(String(message)); },
      },
      sendQueue: [],
      sendInProgress: false,
      backpressurePaused: false,
      lastOutputBySession: new Map(),
      outputSeqBySession: new Map(),
      pendingResyncSessions: new Set(),
      blockBudget: 200,
      lastSeenAt: Date.now(),
    });
  }
  const messages: ConversationTurn[] = [{
    role: "assistant",
    content: Array.from({ length: 10_000 }, (_, index) => ({ type: "text", text: `event-${index}` })),
  }];
  const started = performance.now();
  manager.broadcast({
    type: "output",
    sessionId: "long-session",
    data: { output: "y".repeat(4 * 1024 * 1024), messages, incremental: false },
  });
  const elapsedMs = performance.now() - started;

  for (const sent of frames) {
    assert.equal(sent.length, 1);
    assert.ok(Buffer.byteLength(sent[0]) < 300_000);
    const payload = JSON.parse(sent[0]) as { data: { messages: ConversationTurn[]; output: string; outputTruncated: boolean } };
    assert.equal(payload.data.messages[0].content.length, 200);
    assert.equal(payload.data.output.length, SESSION_TRANSPORT_OUTPUT_LIMIT);
    assert.equal(payload.data.outputTruncated, true);
  }
  assert.ok(elapsedMs < 1_500, `three-client WS fan-out took ${elapsedMs.toFixed(1)}ms`);
});
