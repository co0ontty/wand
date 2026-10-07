import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContentBlock, ToolUseBlock, ToolResultBlock, ConversationTurn } from "./types.js";
import type { PiExecutionNode, PiExecutionSnapshot, PiExecutionState, PiExecutionResponse } from "./pi-execution-types.js";

const MAX_NODES = 80;
const MAX_TRACE = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/i;
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const text = (v: unknown, max = 256): string | undefined => typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;
const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const array = (v: unknown): any[] => Array.isArray(v) ? v : [];

export function isPiExecutionTool(name: string): boolean {
  return ["subagent", "workflow"].includes(name.replace(/^Pi\//, ""));
}

function state(v: unknown): PiExecutionState {
  const aliases: Record<string, PiExecutionState> = { complete: "completed", done: "completed", error: "failed", queued: "pending", started: "running" };
  const s = String(v ?? "");
  return aliases[s] ?? (["pending", "running", "background", "completed", "failed", "paused", "stopped", "detached", "rejected", "skipped", "partial"].includes(s) ? s as PiExecutionState : "unknown");
}

/** Only execution fields cross the host boundary; never forward arbitrary extension details. */
export function projectPiExecution(raw: unknown, source: PiExecutionSnapshot["source"], fallbackState: PiExecutionState): PiExecutionSnapshot | null {
  const d = record(raw);
  const children = record(d.workflowChildren);
  if (!Object.keys(d).length || !(d.mode || d.workflowChildren || d.workflowGraph || Array.isArray(d.agents) || Array.isArray(d.progress))) return null;
  const workflow = record(d.workflow);
  const steps = array(d.steps);
  const trace = array(workflow.trace);
  const rows: PiExecutionNode[] = [];
  function add(rawRow: unknown, id: string, parentId?: string): void {
    const r = record(rawRow);
    const activity = record(r.activity);
    const node: PiExecutionNode = {
      id: text(id) ?? String(rows.length), label: text(r.label ?? r.sessionName ?? r.agent ?? r.childId ?? r.key) ?? id,
      kind: text(r.kind) ?? "agent", state: state(r.state ?? r.status),
    };
    if (parentId) node.parentId = parentId;
    for (const [key, value] of Object.entries({ phase: r.phase, agent: r.agent, model: r.model, runId: r.runId,
      task: r.task ?? r.description ?? r.prompt, currentTool: activity.currentTool ?? r.currentTool,
      error: r.error, output: r.resultPreview ?? r.recentOutput })) {
      const valueText = text(value, ["task", "error", "output"].includes(key) ? 2000 : 256);
      if (valueText) (node as any)[key] = valueText;
    }
    for (const key of ["durationMs", "tokens", "toolCount"] as const) {
      const value = number(activity[key] ?? r[key]);
      if (value !== undefined) node[key] = value;
    }
    rows.push(node);
  }
  function graphNodes(nodes: any[], parentId?: string, depth = 0): void {
    if (depth > 8) return;
    for (const r of nodes.slice(0, 256)) {
      const id = text(r?.id) ?? `node-${rows.length}`;
      add(r, id, parentId);
      graphNodes(array(r?.children), id, depth + 1);
    }
  }
  if (array(d.workflowGraph?.nodes).length) graphNodes(d.workflowGraph.nodes);
  else if (Array.isArray(children.children)) {
    for (const child of children.children.slice(0, 256)) {
      const step = steps.find(s => s.workflowKey === child.childId) ?? {};
      const entry = [...trace].reverse().find(t => t.operation === "run" && t.key === child.childId) ?? {};
      add({ ...entry, ...step, ...child }, String(child.childId));
    }
  } else {
    const sourceRows = Array.isArray(d.agents) ? d.agents : steps.length ? steps : array(d.progress).length ? d.progress : array(d.results);
    sourceRows.slice(0, 256).forEach((r: Record<string, unknown>, i: number) => add({ ...r,
      state: r.state ?? r.status ?? (r.detached ? "detached" : r.interrupted ? "paused" : typeof r.exitCode === "number" ? (r.exitCode === 0 ? "completed" : "failed") : undefined),
    }, String(r.workflowKey ?? r.id ?? `step-${i}`)));
  }
  const totalNodes = Math.max(rows.length, array(children.children).length, steps.length, array(d.agents).length);
  return {
    version: 1, source, mode: text(d.mode) ?? "workflow", name: text(d.name),
    runId: text(d.runId ?? children.workflowRunId ?? d.asyncId),
    state: state(children.workflowState ?? d.state ?? (d.asyncId ? "background" : fallbackState)),
    inventoryComplete: typeof children.inventoryComplete === "boolean" ? children.inventoryComplete : source === "tool-result" && !d.asyncId,
    updatedAt: number(d.lastUpdate ?? d.updatedAt), nodes: rows.slice(0, MAX_NODES),
    trace: trace.slice(-MAX_TRACE).map(t => ({ key: text(t.key) ?? "", operation: text(t.operation) ?? "", state: text(t.state) ?? "unknown",
      phase: text(t.phase), durationMs: number(t.durationMs), error: text(t.error, 1000) })),
    omittedNodes: Math.max(0, totalNodes - MAX_NODES), omittedTrace: Math.max(0, trace.length - MAX_TRACE),
  };
}

/** Partial updates update the invocation, never create a final tool_result or imply delivery. */
export function capturePiExecutionEvent(blocks: ContentBlock[], event: Record<string, unknown>): void {
  if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
  const use = blocks.find((b): b is ToolUseBlock => b.type === "tool_use" && b.id === event.toolCallId);
  if (!use || !isPiExecutionTool(use.name) || use.input.action) return;
  const result = record(event.type === "tool_execution_update" ? event.partialResult : event.result);
  const details = record(result.details);
  const source = event.type === "tool_execution_update" ? "tool-progress" : "tool-result";
  const snapshot = projectPiExecution(details, source, event.isError ? "failed" : source === "tool-progress" ? "running" : "completed");
  if (snapshot) use.execution = snapshot;
  const runId = text(details.asyncId);
  const directory = text(details.asyncDir, 4096);
  if (runId && UUID.test(runId) && directory && path.isAbsolute(directory) && path.basename(directory) === runId) {
    use.piExecutionRef = { runId, directory };
  }
}

function resultText(result: ToolResultBlock | undefined): string {
  return typeof result?.content === "string" ? result.content : array(result?.content).map(p => text(p?.text, 8000) ?? "").join("\n");
}

function legacyReceiptRunId(result: ToolResultBlock | undefined): string | undefined {
  if (result?.is_error) return;
  const lines = resultText(result).trim().split("\n");
  if (!/^Run fan-out:\s*\d+\/\d+ used\b/.test(lines[0] ?? "")) return;
  for (const line of lines.slice(1, 25)) {
    if (!/^Async(?: workflow\b|:)/.test(line.trim())) continue;
    const id = [...line.matchAll(/\[([0-9a-f-]{36,64})\]/gi)].at(-1)?.[1];
    if (id && UUID.test(id)) return id;
  }
}

async function readStatus(directory: string, runId: string, toolId: string): Promise<unknown> {
  // References come from this session's extension result, never an HTTP path parameter.
  const handle = await open(path.join(directory, "status.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("执行状态超出读取上限");
    const raw = JSON.parse(await handle.readFile("utf8"));
    if ((raw.runId ?? raw.id) !== runId || (raw.toolCallId && raw.toolCallId !== toolId)) throw new Error("执行身份不匹配");
    return raw;
  } finally { await handle.close(); }
}

/** Inspect only a run referenced by this session. Old receipts use the package's fixed temp roots. */
export async function inspectPiExecution(messages: ConversationTurn[], toolId: string): Promise<PiExecutionResponse | null> {
  let use: ToolUseBlock | undefined;
  let result: ToolResultBlock | undefined;
  let dispatchTurn: ConversationTurn | undefined;
  for (const turn of messages) for (const b of turn.content) {
    if (b.type === "tool_use" && b.id === toolId) { use = b; dispatchTurn = turn; }
    if (b.type === "tool_result" && b.tool_use_id === toolId) result = b;
  }
  if (!use || !isPiExecutionTool(use.name) || use.input.action) return null;
  let snapshot = use.execution ?? null;
  let notice: string | undefined;
  const runId = use.piExecutionRef?.runId ?? legacyReceiptRunId(result);
  if (runId) {
    let directories = use.piExecutionRef ? [use.piExecutionRef.directory] : [];
    if (!directories.length) {
      const entries = await readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []);
      directories = entries.filter(e => e.isDirectory() && /^pi-subagents-[\w-]+$/.test(e.name)).slice(0, 64)
        .map(e => path.join(os.tmpdir(), e.name, "async-subagent-runs", runId));
    }
    let found = false;
    for (const directory of directories) {
      try {
        const raw = await readStatus(directory, runId, toolId);
        snapshot = projectPiExecution(raw, "status-file", "unknown"); found = !!snapshot;
        if (found) break;
      } catch { /* Retention, old versions and temporary writes leave the captured snapshot available. */ }
    }
    if (!found) notice = "后台状态文件不可读取或已清理；以下保留最后一次工具快照，不代表当前运行状态。";
  }
  if (!snapshot) notice = "这次调用没有可读取的结构数据；保留派发参数，无法确认子任务或完成状态。";
  const inlineScript = typeof use.input.script === "string" ? use.input.script : undefined;
  const replyScript = use.input.workflow === true || use.input.workflow === "true"
    ? dispatchTurn?.content.filter(b => b.type === "text").map(b => b.text).join("\n").match(/```(?:js|javascript) workflow\s*\n([\s\S]*?)\n```/)?.[1] : undefined;
  return { toolId, toolName: use.name, input: use.input, script: (inlineScript ?? replyScript)?.slice(0, 64_000), snapshot, notice };
}
