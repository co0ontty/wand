import type { ConversationTurn } from "../../types.js";

/** Presentation evidence only. Todo content remains owned by the transcript. Never persisted. */
export interface TodoTurnEvidence {
  sourceKey: string;
  requestId: string;
  outcome?: "done" | "failed" | "stopped";
}
export interface TodoTurnSession {
  id: string;
  messages?: readonly ConversationTurn[];
  messageOffset?: number;
  leadingBlockOffset?: number;
  status?: string;
  archived?: boolean;
  permissionBlocked?: boolean;
  pendingEscalation?: unknown;
  ptyBusy?: boolean;
  structuredState?: { inFlight?: boolean; activeRequestId?: string | null } | null;
}
export interface TodoTurnSource {
  key: string;
  startIndex: number;
  /** Latest accepted input, including a tool-result answer within the same logical user turn. */
  requestId: string | null;
  waitingQuestion: boolean;
}

/** Pure tool results continue a logical turn. Queued placeholders and subagent records are not user inputs. */
export function findTodoTurnSource(session: TodoTurnSession): TodoTurnSource | null {
  const messages = session.messages ?? [];
  let latestRequest: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const turn = messages[i];
    if (turn.role !== "user" || turn.notice) continue;
    const blocks = turn.content ?? [];
    if (blocks.some(block => (block as any).__queued)) continue;
    if (latestRequest === null && turn.requestId) latestRequest = turn.requestId;
    if (blocks.length && blocks.every(block => block.type === "tool_result")) continue;
    // A truncated/unknown user boundary must not borrow an older round's Todo.
    const identity = turn.requestId || turn.messageId || turn.createdAt;
    if (!identity || i === 0 && (session.leadingBlockOffset ?? 0) > 0
      || !blocks.some(block => block.type === "text" && !!block.text.trim() || (block as any).type === "image")) return null;
    const activeRequest = session.structuredState?.inFlight ? session.structuredState.activeRequestId : null;
    if (activeRequest && activeRequest !== latestRequest) return null;
    const results = new Set<string>();
    const questions: string[] = [];
    for (const message of messages.slice(i + 1)) {
      for (const block of message.content ?? []) {
        if ((block as any).__subagent) continue;
        if (block.type === "tool_result") results.add(block.tool_use_id);
        if (block.type === "tool_use" && (block.semantic?.kind === "question_request" || block.name === "AskUserQuestion")) questions.push(block.id);
      }
    }
    return {
      key: JSON.stringify([session.id, (session.messageOffset ?? 0) + i, identity]),
      startIndex: i + 1,
      requestId: latestRequest,
      waitingQuestion: questions.some(id => !results.has(id)),
    };
  }
  return null;
}

/** Called by the existing snapshot owner, after its authoritative window reconciliation. */
export function observeTodoTurn(
  previous: TodoTurnEvidence | undefined,
  session: TodoTurnSession,
  event?: { type: string; data?: any },
): TodoTurnEvidence | undefined {
  const source = findTodoTurnSource(session);
  if (!source) return undefined;
  let evidence = previous?.sourceKey === source.key && previous.requestId === source.requestId ? previous : undefined;
  if (!event) return evidence;
  if (event.type === "init") evidence = undefined; // Reconnect/subscription cannot reconstruct missed terminal reasons.
  const request = event.data?.structuredState?.activeRequestId;
  if (event.data?.structuredState?.inFlight === true && typeof request === "string" && request === source.requestId) {
    return { sourceKey: source.key, requestId: request };
  }
  const outcome = event.data?.turnOutcome;
  if (evidence && ["done", "failed", "stopped"].includes(outcome)
    && Array.isArray(event.data?.messages) && session.structuredState?.inFlight !== true
    && (!event.data.terminalRequestId || event.data.terminalRequestId === evidence.requestId)) {
    return { ...evidence, outcome };
  }
  return evidence;
}

export type TodoExecutionKind = "running" | "stopped" | "waiting" | "permission" | "failed" | "ended" | "unknown";
export interface TodoExecutionPresentation {
  sourceKey: string;
  kind: TodoExecutionKind;
  label: string;
  note: string;
}
export function todoExecutionPresentation(
  session: TodoTurnSession, source: TodoTurnSource, evidence?: TodoTurnEvidence, connected = true,
): TodoExecutionPresentation {
  let kind: TodoExecutionKind = "unknown";
  const active = session.structuredState ? session.structuredState.inFlight === true : session.ptyBusy === true;
  const outcome = evidence?.sourceKey === source.key && evidence.requestId === source.requestId ? evidence.outcome : undefined;
  if (connected && !session.archived) {
    if (outcome && !active) kind = outcome === "done" ? "ended" : outcome;
    else if (outcome && active) kind = "unknown";
    else if (session.status === "failed") kind = "failed";
    else if (session.status === "stopped") kind = "stopped";
    else if (session.permissionBlocked || session.pendingEscalation) kind = "permission";
    else if (!active && session.status === "running" && source.waitingQuestion) kind = "waiting";
    else if (active && session.status === "running") kind = "running";
  }
  const copy: Record<TodoExecutionKind, [string, string]> = {
    running: ["运行中", "进度来自本轮工具记录；清单完成不代表执行已结束。"],
    stopped: ["已停止", "本轮已停止。以下是停止前最后记录，不提供续跑操作。"],
    waiting: ["等待输入", "以下进度只读；请在本轮原提问卡回答，不在这里恢复执行。"],
    permission: ["等待授权", "以下进度只读；请在原授权入口处理。"],
    failed: ["执行失败", "以下是失败前最后记录，不自动重试或补全清单。"],
    ended: ["本轮已结束", "以下是本轮最后记录；未完成项不自动补全，执行结束不代表业务任务验收通过。"],
    unknown: ["最近记录", "执行状态未确认；未完成项不代表仍在运行。"],
  };
  return { sourceKey: source.key, kind, label: copy[kind][0], note: copy[kind][1] };
}
