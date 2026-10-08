import { getDefaultModelForProvider } from "./config.js";
import { defaultModelGroupSelector } from "./model-groups.js";
import type { ProcessManager } from "./process-manager.js";
import { defaultRoleForCli } from "./default-employee.js";
import { providerCliCommand } from "./session-provider.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { WandTask, WandTaskAgent } from "./task-types.js";
import { agentKey, type SiliconEmployee } from "./ai-team-types.js";
import type { SessionProvider, SessionSnapshot, WandConfig } from "./types.js";

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
export async function dispatchAgentForTask(
  deps: AgentDispatchDeps,
  input: { task: WandTask; agent: WandTaskAgent; prompt: string; automationId: string; systemPrompt?: string;
    employee?: SiliconEmployee; employeeCandidateIndex?: number;
    teamRequestStarted?: (sessionId: string, requestId: string) => void },
): Promise<AgentDispatchResult> {
  const { storage, config, structured, processes } = deps;
  const { agent } = input;
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
  const resolvedModel = model || defaultModelGroupSelector(config.modelGroups, provider, getDefaultModelForProvider(config, provider)) || getDefaultModelForProvider(config, provider) || undefined;
  const session = agent.kind === "pty"
    ? await processes!.start(providerCliCommand(provider), cwd, agent.mode, input.prompt, {
        provider,
        model: resolvedModel,
        thinkingEffort: agent.thinkingEffort,
        sessionSource: "automation",
        automationId: input.automationId,
        systemPrompt,
        employeeId: role?.id,
        employeeName: role?.name,
        employeeAvatar: role?.avatar,
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
        ...(agent.engine === "sdk"
          ? { engine: structured!.resolveNewSessionPiEngine("sdk").engine }
          : {}),
        worktreeEnabled: false,
        sessionSource: "automation",
        automationId: input.automationId,
        systemPrompt,
        employeeId: role?.id,
        employeeName: role?.name,
        employeeAvatar: role?.avatar,
        employeeCandidates: input.employee?.agents,
        employeeCandidateIndex: input.employeeCandidateIndex,
        workspaceId: group.workspaceId,
        workspaceTaskId: group.workspaceTaskId,
      });
  storage.bindWandTaskSession(input.task.id, session.id);
  if (agent.kind !== "pty") {
    const completion = input.teamRequestStarted
      ? structured!.sendMessage(session.id, input.prompt, { teamRequestStarted: input.teamRequestStarted })
      : structured!.sendMessage(session.id, input.prompt);
    completion.catch((error) => console.error(`[AgentDispatch] ${input.automationId} failed:`, error));
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
    const completion = teamRequestStarted
      ? deps.structured!.sendMessage(sessionId, text, { teamRequestStarted })
      : deps.structured!.sendMessage(sessionId, text);
    completion.catch((error) => console.error(`[AgentDispatch] message to ${sessionId} failed:`, error));
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
