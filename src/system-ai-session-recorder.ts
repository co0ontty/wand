import { createHash, randomUUID } from "node:crypto";
import { redactSystemAiText } from "./system-ai-redaction.js";
export { redactSystemAiText } from "./system-ai-redaction.js";
import type { SiliconEmployee } from "./employee-types.js";
import { CONVERSATION_OWNER, employeeConversationId, type ConversationSessionUpdate } from "./conversation-types.js";
import { conversationSessionPreview } from "./conversation-session-preview.js";
import { defaultStructuredRunner } from "./structured-provider-common.js";
import { providerCliCommand } from "./provider-catalog.js";
import { buildStructuredOutputPayload } from "./structured-session-manager-replay.js";
import type { SessionLogger } from "./session-logger.js";
import type { WandStorage } from "./storage.js";
import type { AiCliCandidate, AiTextRequest, ConversationTurn, ProcessEvent, SessionSnapshot } from "./types.js";
import { AiCallTraceError, SYSTEM_AI_CALL_PREFIX, SYSTEM_AI_PURPOSES, SYSTEM_AI_READ_ONLY, isSystemAiCall, isRetainableSystemAiCall,
  type AiCallTrace, type AiCallTraceFactory, type SystemAiPurpose } from "./system-ai-call.js";

const INPUT_LIMIT = 24_000;
const OUTPUT_LIMIT = 32_000;
const MESSAGE_LIMIT = 256;
const recorders = new WeakMap<WandStorage, SystemAiSessionRecorder>();

function logText(value: string, limit: number): string {
  const text = redactSystemAiText(value);
  return text.length > limit ? text.slice(0, limit) + `\n（日志已限长，原始 ${text.length} 字符）` : text;
}
function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? "（无返回值）"; } catch { return "（结果不可序列化）"; }
}
function failureCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.name : "UNKNOWN";
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "AI_CALL_FAILED";
}
function turn(text: string, notice = false): ConversationTurn {
  const now = new Date().toISOString();
  return { role: "assistant", content: [{ type: "text", text }], notice, createdAt: now, completedAt: now };
}

export class SystemAiSessionRecorder {
  private closed = false;
  private readonly active = new Set<string>();
  private logger?: SessionLogger;
  private emit?: (event: ProcessEvent) => void;
  private notifyConversation?: (update: ConversationSessionUpdate) => void;
  constructor(private readonly storage: WandStorage) { storage.onClose(() => { this.closed = true; }); }

  attach(options: { logger?: SessionLogger; emit?: (event: ProcessEvent) => void; notifyConversation?: (update: ConversationSessionUpdate) => void }): void {
    this.logger = options.logger ?? this.logger;
    this.emit = options.emit ?? this.emit;
    this.notifyConversation = options.notifyConversation ?? this.notifyConversation;
    // Logger must be attached before startup retention, so file history is removed too.
    if (options.logger) this.enforceAllRetention();
  }

  /** A server-owned one-shot has no detached runner to adopt after a restart. Never replay it. */
  recoverInterrupted(): void {
    for (const slim of this.storage.loadSessionsSlim()) {
      if (!isSystemAiCall(slim) || slim.status !== "running" || this.active.has(slim.id)) continue;
      const session = this.storage.getSession(slim.id);
      if (!session) continue;
      const now = new Date().toISOString();
      this.persist({ ...session, status: "failed", exitCode: 1, endedAt: now,
        messages: [...(session.messages ?? []), turn("服务重启，本次系统调用结果未知；未自动重试。")],
        ...(session.structuredState ? { structuredState: { ...session.structuredState, inFlight: false,
          activeRequestId: null, turnStartedAt: null, lastActivityAt: null, lastError: "服务重启，系统调用结果未知。" } } : {}),
      }, false);
    }
  }

  private enforceAllRetention(): void {
    for (const employee of this.storage.listSiliconEmployees({ includeArchived: true })) this.enforceRetention(employee.id);
  }

  enforceRetention(employeeId: string): void {
    if (this.closed) return;
    const keep = this.storage.getSiliconEmployeeDefinition(employeeId)?.systemSessionLimit;
    if (keep == null) return;
    for (const id of this.storage.excessSystemAiSessionIds(employeeId, keep)) {
      // Synchronous recheck + delete: no await where another completion could invalidate selection.
      const current = this.storage.getSessionSlim(id);
      if (!isRetainableSystemAiCall(current) || current?.employeeId !== employeeId || this.active.has(id) || !current.endedAt
        || !["exited", "failed", "stopped"].includes(current.status)) continue;
      this.remove(id);
    }
  }

  forEmployee(employee: SiliconEmployee, sourceSessionId?: string): AiCallTraceFactory {
    const stored = this.storage.getSiliconEmployee(employee.id);
    if (!stored || stored.systemKey !== employee.systemKey) throw new AiCallTraceError();
    // Freeze attribution, not the employee's private knowledge or current UI display name.
    const actor = { id: employee.id, name: employee.name, avatar: employee.avatar, prompt: employee.prompt };
    return { start: (purpose, request, cwd) => this.start(actor, purpose, request, cwd, sourceSessionId) };
  }

  remove(sessionId: string): void {
    const current = this.storage.getSessionSlim(sessionId);
    if (!current || !isSystemAiCall(current)) return;
    if (current.status === "running" || this.active.has(sessionId)) throw Object.assign(new Error("系统调用仍在执行，完成后才能删除日志。"), { statusCode: 409 });
    this.storage.transaction(() => {
      this.storage.unlinkEmployeeSession(sessionId);
      this.storage.deleteSession(sessionId);
    });
    this.logger?.deleteSession(sessionId);
  }

  appendOutcome(sessionId: string, label: string, value: unknown): void {
    if (this.closed) return;
    const current = this.storage.getSession(sessionId);
    if (!current || !isSystemAiCall(current)) return;
    this.persist({ ...current, messages: [...(current.messages ?? []), turn(`## ${label}\n\n${logText(resultText(value), OUTPUT_LIMIT)}`)] }, false);
  }

  private persist(snapshot: SessionSnapshot, create: boolean): void {
    if (this.closed) return;
    try {
      // Deletion is authoritative: late completion must never recreate a removed record or DM.
      if (!create && !this.storage.getSessionSlim(snapshot.id)) return;
      const conversationId = employeeConversationId(snapshot.employeeId!);
      if (create && this.storage.conversationListState(conversationId).deleting) throw new AiCallTraceError();
      this.storage.saveSession(snapshot);
      if (!this.storage.conversationListState(conversationId).deleting) {
        const instance = this.storage.getConversation(conversationId) ?? {
          id: conversationId, owner: CONVERSATION_OWNER, kind: "dm" as const, peerEmployeeId: snapshot.employeeId!,
          name: snapshot.employeeName!, nameSource: "auto" as const, sourceTemplateId: null, team: null,
          memberVersion: 1, joinedVersions: {}, sessionId: null, communicationSessionId: null,
          createdAt: snapshot.startedAt, updatedAt: snapshot.endedAt ?? snapshot.startedAt,
        };
        // Canonical link stores no second transcript and never pretends the system sent a user DM.
        this.storage.linkEmployeeSession(instance, snapshot);
        this.notifyConversation?.({ conversationId, sessionId: snapshot.id, preview: conversationSessionPreview(snapshot) });
      }
      this.logger?.saveMessages(snapshot.id, snapshot.messages ?? []);
      this.logger?.saveMetadata(snapshot.id, { kind: "system-ai-call", employeeId: snapshot.employeeId,
        operation: snapshot.title, provider: snapshot.provider, model: snapshot.selectedModel,
        status: snapshot.status, startedAt: snapshot.startedAt, endedAt: snapshot.endedAt });
      this.emit?.({ type: create ? "started" : "output",
        sessionId: snapshot.id, data: { ...(buildStructuredOutputPayload(snapshot) as Record<string, unknown>),
          automationId: snapshot.automationId, sessionSource: snapshot.sessionSource,
          status: snapshot.status, exitCode: snapshot.exitCode, endedAt: snapshot.endedAt,
        } });
    } catch (error) { if (error instanceof AiCallTraceError) throw error; throw new AiCallTraceError(); }
  }

  private start(actor: { id: string; name: string; avatar: string; prompt: string }, purpose: SystemAiPurpose,
    request: AiTextRequest, cwd: string, sourceSessionId?: string): AiCallTrace {
    const id = randomUUID(), now = new Date().toISOString();
    const label = SYSTEM_AI_PURPOSES[purpose];
    const system = actor.prompt && request.system.startsWith(actor.prompt) ? request.system.slice(actor.prompt.length).trim() : request.system;
    const sensitiveInput = purpose.startsWith("git-") || purpose === "user-memory";
    const input = sensitiveInput
      ? `该输入可能包含源码差异或私人习惯语料，仅保存范围校验信息。\n字符数：${request.prompt.length}\nSHA256：${createHash("sha256").update(request.prompt).digest("hex")}`
      : logText(request.prompt, INPUT_LIMIT);
    let snapshot: SessionSnapshot = {
      id, sessionKind: "structured", sessionSource: "automation", automationId: `${SYSTEM_AI_CALL_PREFIX}${purpose}:${id}`,
      employeeId: actor.id, employeeName: actor.name, employeeAvatar: actor.avatar,
      command: "system-ai", cwd, mode: "default", status: "running", exitCode: null,
      startedAt: now, endedAt: null, output: "", archived: false, archivedAt: null, claudeSessionId: null, worktreeEnabled: false,
      title: `系统调用 · ${label}`, description: `${actor.name} · ${label} · 只读调用记录`,
      completionRevision: 0, viewedCompletionRevision: 0,
      messages: [{ role: "user", author: { id: "system", name: "系统" }, createdAt: now,
        content: [{ type: "text", text: `# ${label}\n\n${SYSTEM_AI_READ_ONLY}\n\n${sourceSessionId ? `关联会话：${sourceSessionId}\n\n` : ""}## 调用规则\n\n${logText(system, INPUT_LIMIT)}\n\n## 输入\n\n${input}` }] }],
    };
    this.active.add(id);
    try { this.persist(snapshot, true); } catch (error) { this.active.delete(id); throw error; }
    let finished = false, omitted = 0, attempts = 0, usageAvailable = false;
    const append = (text: string, force = false): void => {
      if (finished) return;
      const messages = snapshot.messages ?? [];
      if (messages.length >= MESSAGE_LIMIT && !force) {
        omitted++;
        const last = messages.at(-1);
        const notice = turn(`候选明细达到日志上限，另外 ${omitted} 条已折叠；最终结果仍保留。`, true);
        snapshot = { ...snapshot, messages: last?.notice ? [...messages.slice(0, -1), notice] : [...messages, notice] };
      } else snapshot = { ...snapshot, messages: [...messages, turn(logText(text, OUTPUT_LIMIT))] };
      this.persist(snapshot, false);
    };
    const finish = (status: "exited" | "failed" | "stopped", message?: string): void => {
      if (finished) return;
      if (message) append(message, true);
      finished = true;
      this.active.delete(id);
      snapshot = { ...snapshot, status, endedAt: new Date().toISOString(), exitCode: status === "exited" ? 0 : 1,
        ...(snapshot.structuredState ? { structuredState: { ...snapshot.structuredState, inFlight: false,
          activeRequestId: null, turnStartedAt: null, lastActivityAt: null, lastError: status === "exited" ? null : message ?? "系统调用失败。" } } : {}),
      };
      this.persist(snapshot, false);
      // Retention is housekeeping, not model refusal: never turn its failure into a paid retry.
      try { this.enforceRetention(actor.id); }
      catch { console.error("[SystemAi] history retention failed; retry on next completion or startup"); }
    };
    const candidateName = (candidate: AiCliCandidate): string => `${candidate.provider} / ${candidate.engine === "sdk" ? "Wand Agent SDK" : "CLI"} / ${candidate.model ?? "默认模型"}`;
    return {
      sessionId: id,
      candidateStarted: candidate => {
        attempts++;
        const runner = defaultStructuredRunner(candidate.provider);
        snapshot = { ...snapshot, provider: candidate.provider, runner, selectedModel: candidate.model ? logText(candidate.model, 256) : null,
          thinkingEffort: candidate.thinkingEffort ?? "off", command: providerCliCommand(candidate.provider),
          structuredState: { provider: candidate.provider, runner, model: candidate.model ? logText(candidate.model, 256) : undefined,
            engine: candidate.engine === "sdk" ? "core" : "cli", inFlight: true, activeRequestId: id,
            turnStartedAt: now, lastActivityAt: new Date().toISOString(), lastError: null } };
        append(`候选 ${attempts}：开始尝试 ${candidateName(candidate)}。`);
      },
      localStarted: model => {
        attempts++;
        snapshot = { ...snapshot, provider: undefined, runner: undefined, structuredState: undefined,
          selectedModel: logText(model, 256), command: "local-decision" };
        append(`候选 ${attempts}：开始本地决策 worker（${model}），不是 CLI 或 Wand Agent SDK。`);
      },
      candidateSkipped: (candidate, reason) => append(`未执行候选 ${candidateName(candidate)}：${reason}`),
      candidateFailed: (candidate, error, phase) => append(`候选 ${candidateName(candidate)} ${phase === "availability" ? "准备" : phase === "result" ? "结果校验" : "调用"}失败（${failureCode(error)}）。\n\n原始错误（凭据已脱敏）：\n${logText(error instanceof Error ? error.message : resultText(error), 8_000)}`),
      candidateSucceeded: (raw, parsed) => {
        append(`## 模型输出（已通过调用方校验）\n\n${raw}`, true);
        if (typeof parsed !== "string" || parsed !== raw) append(`## 解析后的业务结果\n\n${resultText(parsed)}`, true);
      },
      usageReported: usage => {
        usageAvailable = true;
        snapshot = { ...snapshot, selectedModel: logText(usage.model, 256) };
        append(`SDK 实际模型：${usage.model}；适配器统计输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens（不是账单审计）。`);
      },
      applicationResult: value => append(`## 实际业务执行结果\n\n${resultText(value)}`, true),
      complete: () => finish("exited", `${attempts ? `调用完成；尝试了 ${attempts} 个候选。` : "系统操作已结束；本记录未直接请求模型。"}具体业务是否应用以单独记录的实际业务结果为准。${attempts && !usageAvailable ? "未采集到实际叶子/上游用量，不估算费用。" : ""}`),
      fail: (error, cancelled = false) => finish(cancelled ? "stopped" : "failed", `${cancelled ? "调用已取消，结果不再应用" : "调用失败"}（${failureCode(error)}）；未自动扩大模型/费用范围。\n\n原始错误（凭据已脱敏）：\n${logText(error instanceof Error ? error.message : resultText(error), 8_000)}`),
    };
  }
}

export function systemAiSessions(storage: WandStorage): SystemAiSessionRecorder {
  let recorder = recorders.get(storage);
  if (!recorder) { recorder = new SystemAiSessionRecorder(storage); recorders.set(storage, recorder); }
  return recorder;
}
