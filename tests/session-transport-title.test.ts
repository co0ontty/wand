import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSessionDisplayTitle,
  toSessionDetailDTO,
  toSessionListItemDTO,
} from "../src/session-transport.js";
import type { SessionSnapshot } from "../src/types.js";

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "session-title",
    command: "claude",
    cwd: "/repo/wand",
    mode: "assist",
    status: "running",
    exitCode: null,
    startedAt: "2026-07-18T00:00:00.000Z",
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
}

test("server resolves one canonical title for every client", () => {
  const source = snapshot({
    title: "  统一\n标题  ",
    description: "模型描述",
    summary: "首条消息",
    currentTaskTitle: "正在执行的临时任务",
  });

  assert.equal(resolveSessionDisplayTitle(source), "统一 标题");
  assert.equal(toSessionListItemDTO(source).title, "统一 标题");
});

test("server owns title fallback instead of using transient task state", () => {
  assert.equal(resolveSessionDisplayTitle(snapshot({
    description: "共同总结多轮要求",
    summary: "首条消息",
    currentTaskTitle: "临时任务",
  })), "共同总结多轮要求");
  assert.equal(resolveSessionDisplayTitle(snapshot({
    cwd: "C:\\work\\wand\\",
    currentTaskTitle: "临时任务",
  })), "wand");
  assert.equal(resolveSessionDisplayTitle(snapshot({ cwd: "/" })), "会话");
});

test("session DTOs expose workspace binding, queue skills, and title-generating state", () => {
  const source = snapshot({
    workspaceId: "ws-1",
    workspaceTaskId: "task-9",
    queuedMessages: ["follow up"],
    queuedMessageSkills: [["review"]],
    titleGenerating: true,
    claudeSessionId: "native-thread-1",
    ptyOutputSeq: 42,
    ptyLaunchMarkerToken: "secret-marker",
  });

  const list = toSessionListItemDTO(source);
  const detail = toSessionDetailDTO(source);

  for (const dto of [list, detail]) {
    assert.equal(dto.workspaceId, "ws-1");
    assert.equal(dto.workspaceTaskId, "task-9");
    assert.deepEqual(dto.queuedMessages, ["follow up"]);
    assert.deepEqual(dto.queuedMessageSkills, [["review"]]);
    assert.equal(dto.titleGenerating, true);
    assert.equal(dto.claudeSessionId, "native-thread-1");
    assert.equal(dto.providerSessionId, "native-thread-1");
    assert.equal("ptyOutputSeq" in dto, false);
    assert.equal("ptyLaunchMarkerToken" in dto, false);
  }

  const encoded = JSON.parse(JSON.stringify(list)) as Record<string, unknown>;
  assert.equal(encoded.workspaceId, "ws-1");
  assert.equal(encoded.workspaceTaskId, "task-9");
  assert.deepEqual(encoded.queuedMessageSkills, [["review"]]);
  assert.equal(encoded.titleGenerating, true);
  assert.equal("ptyOutputSeq" in encoded, false);
  assert.equal("ptyLaunchMarkerToken" in encoded, false);
});

test("session DTOs omit unset workspace and queue fields from JSON", () => {
  const encoded = JSON.parse(JSON.stringify(toSessionListItemDTO(snapshot()))) as Record<string, unknown>;
  assert.equal("workspaceId" in encoded, false);
  assert.equal("workspaceTaskId" in encoded, false);
  assert.equal("queuedMessageSkills" in encoded, false);
  assert.equal("titleGenerating" in encoded, false);
});
