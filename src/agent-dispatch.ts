import { taskDispatchFence, trackTaskDispatch } from "./task-execution-fence.js";
import { isLocalDecisionModel } from "./decision-expert-identity.js";
import { fallbackProviderModel, sessionEmployeeFields } from "./session-model.js";
import type { ProcessManager } from "./process-manager.js";
import { defaultRoleForCli } from "./default-employee.js";
import { providerCliCommand } from "./session-provider.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { WandTask, WandTaskAgent } from "./task-types.js";
import { agentKey, type SiliconEmployee } from "./ai-team-types.js";
import type { SessionProvider, SessionSnapshot, WandConfig } from "./types.js";
import type { StructuredFailure } from "./structured-failure.js";

/** A local capability check rejected the input before a session or provider request existed. */
export class AgentDispatchPreflightError extends Error {
  readonly failure: StructuredFailure = { kind: "preflight", delivery: "rejected", retryable: true };
}

/** sendMessage rejected before its durable acceptance callback. */
export class AgentDispatchAcceptanceError extends Error {}

/** Completion is observed, but only onAccepted can release the dispatch. */
function waitForAcceptance(
  send: (onAccepted: () => void) => Promise<unknown>,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let accepted = false;
    const onAccepted = () => { accepted = true; resolve(); };
    const failed = (cause: unknown) => {
      if (accepted) console.error(`[AgentDispatch] ${label} execution failed after acceptance:`, cause);
      else reject(new AgentDispatchAcceptanceError("输入持久接受失败，未启动执行。", { cause }));
    };
    try {
      void send(onAccepted).then(() => {
        // A completion without the acceptance signal is not proof of delivery.
        if (!accepted) reject(new Error("输入接受状态未确认；不会自动重放。"));
      }, failed);
    } catch (cause) { failed(cause); }
  });
}

export interface AgentDispatchDeps {
  storage: WandStorage;
  config: WandConfig;
  structured: StructuredSessionManager | null;
  processes: ProcessManager | null;
}

export interface AgentDispatchResult {
  session: SessionSnapshot;
  cwd: string;
  workspaceId: string;
}

/** 任务卡的执行目录：工作任务的 worktree / 目录 → 所属项目目录 → 全局默认目录。 */
export function resolveTaskDispatchTarget(
  deps: Pick<AgentDispatchDeps, "storage" | "config">,
  task: WandTask,
): { cwd: string; workspaceId: string; workspaceTaskId: string } {
  const workspace = task.workspaceId ? deps.storage.getWorkspace(task.workspaceId) : null;
  if (task.workspaceId && !workspace) throw new Error("任务所属项目已被删除，请重新指定。");
  const group = task.workspaceTaskId ? deps.storage.getWorkspaceTask(task.workspaceTaskId) : null;
  if (!group) throw new Error("任务容器不存在，请恢复任务后再派发。");
  const cwd = group.worktree?.path || group.cwd || workspace?.cwd || deps.config.defaultCwd;
  return { cwd, workspaceId: group.workspaceId, workspaceTaskId: group.id };
}

/**
 * 为任务卡开一个新会话（structured 或 PTY，按 agent.kind），发送首条提示词，并把会话绑定回任务卡。
 * cwd 取任务的工作任务目录 / 所属项目目录；未指定项目时用全局默认目录。
 * 结构化会话的整轮 completion 不等待：进度与失败走正常会话事件。
 */
export function dispatchAgentForTask(deps: AgentDispatchDeps, input: Parameters<typeof dispatchAgentForTaskInternal>[1]): Promise<AgentDispatchResult> {
  return trackTaskDispatch(deps.storage, input.task.id, () => dispatchAgentForTaskInternal(deps, input));
}

async function dispatchAgentForTaskInternal(
  deps: AgentDispatchDeps,
  input: { task: WandTask; agent: WandTaskAgent; prompt: string; automationId: string; systemPrompt?: string;
    origin?: import("./task-types.js").TaskCommentOrigin;
    employee?: SiliconEmployee; employeeCandidateIndex?: number;
    sessionCreated?: (session: SessionSnapshot) => void;
    teamRequestStarted?: (sessionId: string, requestId: string) => void },
): Promise<AgentDispatchResult> {
  const { storage, config, structured, processes } = deps;
  const { agent } = input;
  const fence = taskDispatchFence(storage, input.task.id);
  const assertCurrent = () => {
    const current = taskDispatchFence(storage, input.task.id);
    if (current.blocked || current.epoch !== fence.epoch) throw new AgentDispatchPreflightError("用户正在修改任务状态，旧派发已取消。");
  };
  assertCurrent();
  if (input.employee) {
    if (agent.kind !== "structured") throw new Error("绑定员工只支持结构化会话。");
    const candidate = input.employee.agents[input.employeeCandidateIndex ?? 0];
    if (!candidate || agentKey(candidate) !== agentKey(agent)) {
      throw new Error("员工执行候选与启动快照不一致。");
    }
  }
  const role = input.employee ?? (!input.systemPrompt?.trim()
    && input.automationId.startsWith("wand-task:") ? defaultRoleForCli(storage, agent.provider) : null);
  const systemPrompt = input.systemPrompt?.trim() || role?.prompt || undefined;
  if (agent.kind === "structured" && !structured) throw new Error("当前服务未启用结构化会话，无法派发 Agent。");
  if (agent.kind === "pty" && !processes) throw new Error("当前服务未启用终端会话，无法派发 Agent。");
  const group = resolveTaskDispatchTarget(deps, input.task);
  const cwd = group.cwd;
  const provider = agent.provider as SessionProvider;
  const model = agent.model === "default" ? "" : agent.model;
  const resolvedModel = model || fallbackProviderModel(config, provider);
  if (isLocalDecisionModel(resolvedModel)) {
    throw new AgentDispatchPreflightError("LAYA 仅支持有界决策，不能执行聊天或任务；该候选尚未接受输入。");
  }
  // This resolution is a pure pre-session capability check: rejection here cannot have delivered input.
  let sdkEngine: Awaited<ReturnType<StructuredSessionManager["resolveNewSessionPiEngine"]>> | null = null;
  if (agent.kind === "structured" && agent.engine === "sdk") {
    try { sdkEngine = await structured!.resolveNewSessionPiEngine("sdk"); }
    catch (cause) { throw new AgentDispatchPreflightError("当前 Wand Agent 引擎不可用；未创建会话或发送输入，请核对执行工具配置。", { cause }); }
  }
  assertCurrent();
  const session = agent.kind === "pty"
    ? await processes!.start(providerCliCommand(provider), cwd, agent.mode, input.prompt, {
        provider,
        model: resolvedModel,
        thinkingEffort: agent.thinkingEffort,
        sessionSource: "automation",
        automationId: input.automationId,
        systemPrompt,
        ...sessionEmployeeFields(role),
        workspaceId: group.workspaceId,
        workspaceTaskId: group.workspaceTaskId,
      })
    : structured!.createSession({
        cwd,
        mode: agent.mode,
        provider,
        model: resolvedModel,
        thinkingEffort: agent.thinkingEffort,
        // 直接派发 Wand Agent（不进员工候选链）：先裁决进程内引擎是否可用，
        // 不可用就让这次派发明确失败，不静默退回 CLI 冒充。
        ...(sdkEngine
          ? { engine: sdkEngine.engine }
          : {}),
        worktreeEnabled: false,
        sessionSource: "automation",
        automationId: input.automationId,
        systemPrompt,
        ...sessionEmployeeFields(role),
        employeeCandidates: input.employee?.agents,
        employeeCandidateIndex: input.employeeCandidateIndex,
        workspaceId: group.workspaceId,
        workspaceTaskId: group.workspaceTaskId,
      });
  try { assertCurrent(); } catch (cause) {
    if (agent.kind === "pty") processes!.stop(session.id); else structured!.stop(session.id);
    throw cause;
  }
  storage.bindWandTaskSession(input.task.id, session.id);
  input.sessionCreated?.(session);
  if (agent.kind !== "pty") {
    const origin = input.origin ?? { kind: "task_dispatch" as const, triggerName: null, taskId: input.task.id, taskIdentifier: input.task.identifier, commentId: "", entrySessionId: null };
    await waitForAcceptance(onAccepted => structured!.sendMessage(session.id, input.prompt, {
      teamRequestStarted: input.teamRequestStarted, origin, onAccepted,
    }), input.automationId);
  }
  return { session, cwd, workspaceId: group.workspaceId };
}

/**
 * 给已有会话追加一条消息。结构化会话走 sendMessage（不等整轮结束）；
 * PTY 按输入契约先写文本、再单独写 "\r"，不用 text + "\n" 代替回车。
 */
export async function sendToAgentSession(
  deps: Pick<AgentDispatchDeps, "structured" | "processes"> & { sessions: SessionRegistry },
  sessionId: string,
  text: string,
  teamRequestStarted?: (sessionId: string, requestId: string) => void,
): Promise<void> {
  if (deps.sessions.ownerOf(sessionId) === "structured") {
    await waitForAcceptance(onAccepted => deps.structured!.sendMessage(sessionId, text, {
      teamRequestStarted, onAccepted,
    }), `message to ${sessionId}`);
    return;
  }
  if (!deps.processes) throw new Error("当前服务未启用终端会话。");
  await deps.processes.sendInputConfirmed(sessionId, text, "terminal");
  await deps.processes.sendInputConfirmed(sessionId, "\r", "terminal", "enter_text");
}

/** 与 /api/sessions/:id/stop 同样按会话归属分派到对应 manager。 */
export function stopAgentSession(
  deps: Pick<AgentDispatchDeps, "structured" | "processes"> & { sessions: SessionRegistry },
  sessionId: string,
): void {
  if (deps.sessions.ownerOf(sessionId) === "structured") {
    deps.structured?.stop(sessionId);
    return;
  }
  deps.processes?.stop(sessionId);
}
