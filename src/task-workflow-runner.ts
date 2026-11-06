import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./shell-quote.js";
import { DEFAULT_EMPLOYEE_ID } from "./employee-types.js";
import type { WandStorage } from "./storage.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerExecution, StructuredRunnerObserver } from "./structured-runner.js";

/** The default employee owns implementation even outside a task-board dispatch.
 * This is a per-turn instruction, not a retry loop or an authorization grant.
 * Keep it out of the saved role so existing sessions receive it without replacing user edits.
 */
export const DEFAULT_EMPLOYEE_COMPLETION_CONTRACT = [
  "主执行责任：用户要求你实施、修复或完成工作时，你负责从需求到验证的完整闭环。先按本轮有效需求确定可核查的完成标准，再自行实现、检查、定位失败、修复和复验；纯咨询或明确只读审查仍遵守原范围。",
  "逐项区分已验证通过、自测失败、尚未验证、明确外部阻塞和用户暂缓的工作。自测失败、已有部分提交、阶段报告或一轮对话结束都不代表任务完成。只要还有当前授权内可安全推进的目标，就继续处理；一个步骤受阻不能替代对其余独立步骤的检查。普通技术困难应调整诊断或方案，不重复空转、不降低标准，也不把原目标的缺口另拆给别人。",
  "独立审查用于复核，不转移主执行责任。交给审查前先完成自己的全部适用自测；收到具体缺口后仍由你核实、修复并重新验证，不反复以“验收不通过”作为执行结论，不把让别人继续验收或返工作为完成。自己的自测不冒充独立验收或用户确认，最新用户决定替代旧标准。",
  "沿用原任务或本轮指定的项目记录持久保存完成标准、已做修改、逐项证据、未完成项及下一步。恢复时先读取并核对实际状态，再接续未完成项，不重新实现已确认完成的部分，不把 idle、报告已写或工具退出码当作业务成功。未知送达先核实，不自动重放。",
  "只有当前授权和条件下无法自行解除的外部阻塞、必要用户决定或权限缺口才暂停受影响步骤；说明已尝试的办法、具体条件、最小所需帮助及解除后的恢复步骤，并继续其他不依赖它的工作。用户要求暂停或停止时立即遵守。不得绕过拒绝、扩大权限、擅自部署、切换模型或另派员工；本约定不增加任何操作授权。全部适用标准确有证据通过后再提交交付，未完成就明确保留未完成，不承诺提示词或重试必然解决问题。",
].join("\n\n");

/** Runtime-only exact-task grant, independent of owner login and knowledge authorization. */
export function startTaskWorkflowRunner(storage: WandStorage, runner: StructuredRunnerAdapter, context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
  const env = { ...context.env };
  delete env.WAND_TASK_DB; delete env.WAND_TASK_TOKEN;
  if (context.session.automationId?.startsWith("dingtalk:")) return runner.start({ ...context, env }, observer);
  if (context.session.employeeId === DEFAULT_EMPLOYEE_ID) context = { ...context, session: { ...context.session,
    runtimeSystemPrompt: [context.session.runtimeSystemPrompt, DEFAULT_EMPLOYEE_COMPLETION_CONTRACT].filter(Boolean).join("\n\n") } };
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
