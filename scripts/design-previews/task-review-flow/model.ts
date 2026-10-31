// Isolated design model, not the production task protocol.
export type Stage = "backlog" | "todo" | "doing" | "review" | "ready" | "archived";
export type Action = "submit" | "pass" | "fail" | "archive" | "return";
export interface DemoTask {
  id: string;
  title: string;
  stage: Stage;
  evidence: string;
  gap: string;
  aiPassed: boolean;
  humanAccepted: boolean;
  history: string[];
}
export const columns: { stage: Stage; label: string; hint: string }[] = [
  { stage: "backlog", label: "待立项", hint: "尚未批准执行" },
  { stage: "todo", label: "等待认领", hint: "等待明确派发" },
  { stage: "doing", label: "执行中", hint: "实施或修复验收缺口" },
  { stage: "review", label: "待验收", hint: "由 AI 核验交付与证据" },
  { stage: "ready", label: "待归档", hint: "AI 已通过，等你确认" },
];
export const samples: DemoTask[] = [
  { id: "DEMO-01", title: "统一任务状态与验收链路", stage: "doing", evidence: "", gap: "", aiPassed: false, humanAccepted: false, history: ["执行中：此卡为示例，不对应真实任务。"] },
  { id: "DEMO-02", title: "交付已提交，等待 AI 验收", stage: "review", evidence: "示例产物：验收报告、构建版本与交互录屏。", gap: "", aiPassed: false, humanAccepted: false, history: ["执行者已提交交付；尚无 AI 验收结论。"] },
  { id: "DEMO-03", title: "AI 验收通过，等待人工确认", stage: "ready", evidence: "示例证据：桌面与窄屏测试通过，报告已汇总。", gap: "", aiPassed: true, humanAccepted: false, history: ["AI 验收通过：证据齐全；未代替用户接受。"] },
];
export function transition(task: DemoTask, action: Action, evidence: string, gap: string): DemoTask {
  const proof = evidence.trim(), reason = gap.trim();
  let stage = task.stage, aiPassed = task.aiPassed, humanAccepted = task.humanAccepted, note = "";
  switch (action) {
    case "submit":
      if (stage !== "doing") throw new Error("只有执行中的任务才能提交 AI 验收。");
      if (!proof) throw new Error("请填写交付证据；会话结束不等于交付完成。");
      if (reason) throw new Error("尚有未解决缺口，请先处理再提交。");
      stage = "review"; aiPassed = false; humanAccepted = false; note = "执行者提交交付 → 待验收（AI）；不自动启动模型。"; break;
    case "pass":
      if (stage !== "review") throw new Error("只有待验收任务才能记录 AI 验收通过。");
      if (!proof || reason) throw new Error("通过需要完整证据，且不能遗留未验证项或缺口。");
      stage = "ready"; aiPassed = true; humanAccepted = false; note = "AI 验收通过 → 待归档；等待人工确认。"; break;
    case "fail":
      if (stage !== "review") throw new Error("只有待验收任务才能记录不通过。");
      if (!reason) throw new Error("请写明不通过或无法验证的原因。");
      stage = "doing"; aiPassed = false; humanAccepted = false; note = `AI 验收不通过 → 执行中：${reason}（不自动派发修复）`; break;
    case "archive":
      if (stage !== "ready" || !aiPassed || !proof || reason) throw new Error("需要 AI 明确通过且无缺口，再由人确认归档。");
      stage = "archived"; humanAccepted = true; note = "用户明确接受并归档；不删除任务或会话。"; break;
    case "return":
      if (stage !== "ready") throw new Error("只有待归档任务才能被人工退回。");
      if (!reason) throw new Error("请填写人工退回原因。");
      stage = "doing"; aiPassed = false; humanAccepted = false; note = `人工退回 → 执行中：${reason}（旧结论留在历史）`; break;
  }
  return { ...task, stage, evidence: proof, gap: reason, aiPassed, humanAccepted, history: [...task.history, note] };
}
