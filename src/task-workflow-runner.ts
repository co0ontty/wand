import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./shell-quote.js";
import type { WandStorage } from "./storage.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerExecution, StructuredRunnerObserver } from "./structured-runner.js";

/** Runtime-only exact-task grant, independent of owner login and knowledge authorization. */
export function startTaskWorkflowRunner(storage: WandStorage, runner: StructuredRunnerAdapter, context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
  const env = { ...context.env };
  delete env.WAND_TASK_DB; delete env.WAND_TASK_TOKEN;
  if (context.session.automationId?.startsWith("dingtalk:")) return runner.start({ ...context, env }, observer);
  const scope = storage.knowledgeSessionScope(context.session.id);
  const grant = (context.session.employeeId ?? null) === (scope?.employeeId ?? null) ? storage.issueTaskWorkflowAccess(context.session.id) : null;
  if (!grant) return runner.start({ ...context, env }, observer);
  const js = fileURLToPath(new URL("./cli.js", import.meta.url));
  const command = existsSync(js) ? `${shellQuote(process.execPath)} ${shellQuote(js)}` : `${shellQuote(process.execPath)} --import tsx ${shellQuote(js.replace(/\.js$/, ".ts"))}`;
  const instruction = [
    `当前任务回填范围仅为 ${grant.taskId}，交付版本 ${grant.revision}（ID/版本不是凭据）。`,
    `先用 wand task:context ${grant.taskId} 读取最新 updatedAt、目标、证据和状态。确实完成交付时使用 submit；被明确派发验收时，根据实际证据用 pass 或 fail。未验证项按 fail 写明 blocker，不得因会话结束或自己声称完成而通过。`,
    `回填命令：${command} task:workflow ${grant.taskId} --stdin。stdin 为 JSON {"action":"submit|pass|fail","requestId":"同一意图固定UUID","expectedUpdatedAt":"读取到的任务.updatedAt","evidence":"实际证据","blocker":"失败或无法验证的原因，通过时为空"}。`,
    "该能力不能人工确认、归档、跨任务写入或派发。版本冲突先保留草稿并重新读取核对；未知回执不得换 requestId 重做。权限失效等待新的执行，不回退到所有者身份。提交后需独立新一轮验收，不在同一执行自提交自验收。验收结论必须实际回填，不能仅留在回复里。",
  ].join("\n\n");
  const cleanup = (): void => { try { storage.revokeTaskWorkflowAccess(grant.token); } catch { /* storage may be shutting down */ } };
  try {
    const execution = runner.start({ ...context, env: { ...env, WAND_TASK_DB: storage.databasePath(), WAND_TASK_TOKEN: grant.token }, session: { ...context.session,
      runtimeSystemPrompt: [context.session.runtimeSystemPrompt, instruction].filter(Boolean).join("\n\n") } }, observer);
    return { ...execution, completion: execution.completion.finally(cleanup), interrupt: () => { cleanup(); execution.interrupt(); } };
  } catch (error) { cleanup(); throw error; }
}
