import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSessionDisplayTitle,
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
