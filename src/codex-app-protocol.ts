import { asRecord } from "./structured-content.js";
import { CodexProtocolReducer, type CodexTurnState } from "./structured-codex-protocol.js";
import type { SessionSnapshot } from "./types.js";

/** App Server projection shared by live observation and persistent-host replay. */
export class CodexAppProtocolReducer {
  private readonly reducer: CodexProtocolReducer;
  private readonly items = new Map<string, Record<string, any>>();
  private readonly textPrefixes = new Map<string, string>();
  constructor(session: SessionSnapshot) { this.reducer = new CodexProtocolReducer(session); }
  get state(): CodexTurnState { return this.reducer.state; }
  get primaryError() { return this.reducer.primaryError; }
  get errors() { return this.reducer.errors; }

  apply(value: unknown): boolean {
    const record = asRecord(value);
    if (!record) return false;
    if (record.type === "wand_input_ready") {
      this.state.inputMessageId = String(record.id);
      return true;
    }
    if (record.type === "wand_input_committed") {
      this.state.blocks = [];
      this.state.result = "";
      this.state.usage = undefined;
      this.state.codexBlockIndex?.clear();
      for (const [id, item] of this.items) {
        if (item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning") {
          this.textPrefixes.set(id, this.itemText(item));
        }
      }
      this.state.inputMessageId = String(asRecord(record.message)?.id);
      return true;
    }
    if (record.type === "wand_codex_question") {
      if (typeof record.id !== "string" || this.state.blocks.some(block => block.type === "tool_use" && block.id === record.id)) return false;
      const questions = Array.isArray(record.questions) ? record.questions : [];
      this.state.blocks.push({ type: "tool_use", id: String(record.id), name: "AskUserQuestion",
        input: { questions: questions.map((q: any) => ({ id: q.id, header: q.header, question: q.question,
          multiSelect: false, options: q.options ?? [], isOther: q.isOther })) } });
      return true;
    }
    if (record.type === "wand_codex_question_resolved") {
      if (!this.state.blocks.some(block => block.type === "tool_use" && block.id === record.id)) return false;
      if (!this.state.blocks.some(block => block.type === "tool_result" && block.tool_use_id === record.id)) {
        this.state.blocks.push({ type: "tool_result", tool_use_id: String(record.id), content: "问题已处理或已失效。" });
      }
      return true;
    }
    if (record.type !== "wand_codex_event") return this.reducer.apply(record);
    const event = asRecord(record.event);
    const params: Record<string, any> = asRecord(event?.params) ?? {};
    const method = event?.method;
    if (method === "turn/completed") {
      if (params.turn?.status === "failed") this.reducer.apply({ type: "turn.failed", error: params.turn.error });
      else if (params.turn?.status === "interrupted") this.reducer.apply({ type: "turn.failed", error: { message: "Codex 回合已中断。" } });
      return true;
    }
    if (method === "error" && !params.willRetry) {
      this.reducer.apply({ type: "turn.failed", error: params.error });
      return true;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage?.last;
      return this.reducer.apply({ type: "turn.completed", usage: usage ? {
        input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens, reasoning_output_tokens: usage.reasoningOutputTokens,
      } : undefined });
    }
    if (method === "turn/plan/updated") {
      return this.reducer.apply({ type: "item.updated", item: { id: `plan:${params.turnId}`, type: "function_call",
        name: "update_plan", arguments: { plan: params.plan, explanation: params.explanation } } });
    }
    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item);
      if (!item || typeof item.id !== "string") return false;
      this.items.set(item.id, item);
      return this.project(item, method === "item/completed");
    }
    if (typeof method === "string" && (method.endsWith("/delta") || method.endsWith("Delta"))) {
      const id = params.itemId;
      let item = this.items.get(id);
      if (!item && method === "item/agentMessage/delta") {
        item = { id, type: "agentMessage", text: "" }; this.items.set(id, item);
      }
      if (!item) return false;
      if (method === "item/agentMessage/delta" || method === "item/plan/delta") item.text = (item.text ?? "") + params.delta;
      else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") item.text = (item.text ?? "") + params.delta;
      else if (method === "item/commandExecution/outputDelta") item.aggregatedOutput = (item.aggregatedOutput ?? "") + params.delta;
      else return false;
      return this.project(item, false);
    }
    return false;
  }

  private project(item: Record<string, any>, completed: boolean): boolean {
    let mapped: Record<string, unknown>;
    const status = item.status === "inProgress" ? "in_progress" : item.status;
    switch (item.type) {
      case "agentMessage":
      case "reasoning":
      case "plan": {
        const text = this.itemText(item);
        const prefix = this.textPrefixes.get(item.id);
        mapped = { ...item, type: item.type === "reasoning" ? "reasoning" : "agent_message",
          text: prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text };
        break;
      }
      case "commandExecution": mapped = { ...item, type: "command_execution", status,
        aggregated_output: item.aggregatedOutput, exit_code: item.exitCode }; break;
      case "fileChange": {
        if (!completed) return false;
        const changes = Object.fromEntries((item.changes ?? []).map((change: any) => [change.path,
          { type: change.kind?.type, move_path: change.kind?.move_path, unified_diff: change.diff }]));
        mapped = { id: item.id, type: "patch_apply_end", changes, status, success: status === "completed" };
        break;
      }
      case "mcpToolCall": mapped = { ...item, type: "mcp_tool_call", status }; break;
      case "webSearch": mapped = { ...item, type: "web_search", status }; break;
      // app-server 的 functionCallOutput 是独立展示项；没有对应的 tool_use 时按结果卡展示，
      // 也不能丢（自定义工具的输出只走这一条）。
      case "functionCallOutput": mapped = { ...item, type: "function_call_output", call_id: item.id, output: item.output }; break;
      case "collabAgentToolCall": mapped = { ...item, type: "collab_tool_call", status,
        sender_thread_id: item.senderThreadId, receiver_thread_ids: item.receiverThreadIds, agents_states: item.agentsStates }; break;
      case "subAgentActivity": mapped = { ...item, type: "sub_agent_activity" }; break;
      case "imageView": mapped = { ...item, type: "image_view", file_path: item.path }; break;
      case "imageGeneration": mapped = { ...item, type: "image_generation", status }; break;
      case "enteredReviewMode": mapped = { ...item, type: "review_mode", phase: "entered" }; break;
      case "exitedReviewMode": mapped = { ...item, type: "review_mode", phase: "exited" }; break;
      case "contextCompaction": mapped = { ...item, type: "context_compaction" }; break;
      // `sleep` 是 clock.sleep 的纯展示项（只有 durationMs），没有可保留的语义，不立卡。
      case "sleep": return false;
      case "dynamicToolCall": mapped = { ...item, type: "function_call", name: item.tool }; break;
      default: return false;
    }
    return this.reducer.apply({ type: completed ? "item.completed" : "item.updated", item: mapped });
  }

  private itemText(item: Record<string, any>): string {
    return item.text || (item.type === "reasoning" ? [...(item.summary ?? []), ...(item.content ?? [])].join("\n") : "");
  }
}
