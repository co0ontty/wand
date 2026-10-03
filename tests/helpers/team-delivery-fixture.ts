import type { AiTeamRunDetail } from "../../src/ai-team-types.js";

/** Synthetic delivery records, not acceptance data from an installed service. */
export function teamDeliveryFixture(taskId = "task-a", runId = "run-a"): AiTeamRunDetail {
  const at = "2026-10-03T10:00:00.000Z";
  return {
    run: { id: runId, taskId, teamId: "team-a", team: { id: "team-a", name: "协作团队",
      description: "", instructions: "", members: [], requirePlanApproval: false, maxSteps: 30,
      createdAt: at, updatedAt: at }, objective: "既有任务说明", cwd: "/synthetic",
      status: "waiting_user", statusDetail: "完整负责人状态只在原槽显示", stepsUsed: 2,
      stepLimit: 30, formatRetries: 0, planApproved: true, chatSessionId: "relay-a",
      pendingNotes: [], createdAt: at, updatedAt: at },
    steps: [], chatTurns: [], memberStates: {},
    delivery: { runId, updatedAt: at, headline: "等待回复", conclusion: null,
      files: [0, 1].map((seq) => ({ stepId: `step-${seq}`, seq, memberId: "m-a", memberName: "实现者",
        title: "已交付步骤", file: { stepId: `step-${seq}`, path: `/synthetic/report-${seq}.md`,
          name: `report-${seq}.md`, size: 100,
          ...(seq === 0 ? { preview: { title: "真实冻结摘要", excerpt: "仅显示服务器提供的摘录" } } : {}) } })),
      totalFiles: 23,
      handoffs: [{ stepId: "step-next", seq: 3, title: "后续检查", memberId: "m-b", memberName: "评审者",
        status: "queued", sessionId: null, waitingFor: ["实现步骤"] }], totalHandoffs: 8,
      attention: { kind: "reply", message: "负责人请求补充信息" } },
  };
}
