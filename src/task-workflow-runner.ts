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
    `先用 wand task:context ${grant.taskId} 读取最新目标、父任务、完整评论、updatedAt 和状态。最新用户决定替代旧标准；已明确失效的需求不能被旧验收重新恢复。`,
    "你必须把自己的任务完整执行完：实现、逐项自测、修复、自测直到全部标准满足。自测失败、构建失败或一轮对话结束不能作为交差理由，不得降低标准、跳过检查或把原目标的缺口另拆任务。普通进展可用 progress 回填，但仍须继续完成。只有无法在当前授权和条件下自行解决的明确外部阻塞才用 block 暂停；写清已尝试的办法、具体阻塞和所需最小条件，不能把普通修复困难当作外部阻塞。",
    "全部目标和自测通过后用 submit 提交；必须提供 selfTest 数组，每项包含 criterion（完成标准）和 evidence（实际通过结果与可核查证据位置）。按受影响范围完成真实流程和必要构建部署，源码或模拟检查不能冒充运行验收。证据需注明本轮交付版本/环境并保留可复核位置。",
    "被明确派发独立验收时，逐项复核全部完成标准；真实功能缺口用 fail，一次写全已发现的问题；确实通过用 pass，系统自动完成归档，不需要用户再次确认。验收环境、必要权限等无法自行解决时用 block 保留待验收，不将无法验证冒充功能失败。不得验收自己的交付。",
    `回填命令：${command} task:workflow ${grant.taskId} --stdin。stdin 为 JSON {"action":"progress|block|submit|pass|fail","requestId":"同一意图固定UUID","expectedUpdatedAt":"读取到的任务.updatedAt","evidence":"实际证据和已尝试办法","blocker":"修复缺口或外部条件，通过时为空","selfTest":[{"criterion":"完成标准","evidence":"实际自测通过证据"}]}。selfTest 仅 submit 必填。`,
    "必须核对成功回执；未确认写入不得声称交付。能力不能人工确认、任意归档、跨任务写入或派发。版本冲突先保留输入并重新读取核对；未知回执不得换 requestId 重做。权限失效不回退到所有者身份。提交后交给独立新一轮验收，不在同一执行自提交自验收。",
  ].join("\n\n");
  const cleanup = (): void => { try { storage.revokeTaskWorkflowAccess(grant.token); } catch { /* storage may be shutting down */ } };
  try {
    const execution = runner.start({ ...context, env: { ...env, WAND_TASK_DB: storage.databasePath(), WAND_TASK_TOKEN: grant.token }, session: { ...context.session,
      runtimeSystemPrompt: [context.session.runtimeSystemPrompt, instruction].filter(Boolean).join("\n\n") } }, observer);
    return { ...execution, completion: execution.completion.finally(cleanup), interrupt: () => { cleanup(); execution.interrupt(); } };
  } catch (error) { cleanup(); throw error; }
}
