import assert from "node:assert/strict";
import test from "node:test";
import { collectAttentionItems, teamRunErrorDetail } from "../src/attention.js";

const run = {
  id: "run_1",
  status: "waiting_user",
  statusDetail: "负责人出错：积分已耗尽，调用失败",
  taskTitle: "新功能",
  teamName: "开发三人组",
  chatSessionId: "chat_1",
  updatedAt: "2026-09-26T12:00:00.000Z",
};

test("homepage attention keeps unresolved errors and drops questions", () => {
  assert.equal(teamRunErrorDetail("waiting_user", "已达到步数上限"), null);
  assert.equal(teamRunErrorDetail("waiting_user", "要不要改用方案 A？"), null);
  assert.equal(teamRunErrorDetail("awaiting_approval", "请批准计划"), null);
  assert.match(teamRunErrorDetail("failed", "") ?? "", /团队运行失败/);

  const items = collectAttentionItems({
    runs: [
      run,
      { ...run, id: "run_limit", statusDetail: "已达到步数上限", updatedAt: "2026-09-26T12:02:00.000Z" },
      { ...run, id: "run_live", status: "running", statusDetail: "", chatSessionId: "chat_live", updatedAt: "2026-09-26T12:03:00.000Z" },
    ],
    sessions: [
      {
        id: "leader_old",
        title: "设计 AI 团队",
        status: "failed",
        lastError: "积分已耗尽，调用失败",
        automationId: "ai-team:run_live",
        updatedAt: "2026-09-26T12:04:00.000Z",
      },
      {
        id: "chat_1",
        title: "群聊",
        status: "idle",
        lastError: "负责人出错：积分已耗尽，调用失败",
        automationId: "ai-team-chat:run_1",
        updatedAt: "2026-09-26T12:01:00.000Z",
      },
      {
        id: "done",
        title: "已经好了",
        status: "idle",
        lastError: "",
        updatedAt: "2026-09-26T12:05:00.000Z",
      },
      {
        id: "old",
        title: "归档失败",
        archived: true,
        status: "failed",
        lastError: "旧错误",
        updatedAt: "2026-09-26T12:06:00.000Z",
      },
    ],
  });

  assert.deepEqual(items.map((item) => item.id), ["session:leader_old", "team:run_1"]);
  assert.equal(items[0]?.sessionId, "chat_live");
  assert.equal(items[1]?.sessionId, "chat_1");
  assert.match(items[0]?.detail ?? "", /积分已耗尽/);
});
