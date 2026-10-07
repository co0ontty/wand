import { deriveSubagentDispatchMeta } from "../../subagent-dispatch.js";

export interface AgentRunSourceMeta {
  taskId: string;
  agentType?: string;
  taskDescription?: string;
}

export interface AgentRunMessage {
  role?: string;
  content?: any[];
  [key: string]: any;
}

export interface AgentRunBlockRef {
  messageIndex: number;
  blockIndex: number;
  message: AgentRunMessage;
  block: any;
}

export interface AgentRunAgent {
  taskId: string;
  meta: AgentRunSourceMeta;
  dispatch: AgentRunBlockRef | null;
  firstSeen: AgentRunBlockRef;
  blocks: AgentRunBlockRef[];
  result: AgentRunBlockRef | null;
  /**
   * 异步派发的「回执」：表示任务已交给后台，不等于子 Agent 真的跑完并给出了结论。
   * 命中时结果块按回执渲染。两个字段都可能为空（真实 pi 回执就没有输出文件），
   * 此时渲染侧回落到正文，信息不丢。
   */
  receipt: AgentRunReceipt | null;
  runId: string;
}

export interface AgentRunReceipt {
  runId: string;
  outputPath: string;
}

export interface AgentRun {
  id: string;
  messageIndex: number;
  startBlockIndex: number;
  endBlockIndex: number;
  anchor: AgentRunBlockRef;
  agents: AgentRunAgent[];
}

export interface AgentRunIndex {
  agents: AgentRunAgent[];
  agentByTaskId: Map<string, AgentRunAgent>;
  ownerByBlockKey: Map<string, string>;
  runs: AgentRun[];
  runsByMessageIndex: Map<number, Map<number, AgentRun>>;
  /**
   * 最后一条「真人文本轮」的消息下标，与 Android `collectSubagentActivities`
   * 的 lastHumanTurn 同一语义（role=user、有非空 Text、且不是子 Agent 轨迹）。
   * 没有则为 -1（整段历史都算最新窗口）。
   */
  lastUserTextMessageIndex: number;
}

/**
 * 状态口径需要两个独立事实，不能像以前那样只给一个 isLive：
 * 只看「是不是最新那个 run」会让不在最新一轮、仍在跑的 Agent 被误标「已中断」。
 */
export interface AgentRunActivity {
  /** 会话仍在执行（status=running 且 structuredState.inFlight）。 */
  sessionRunning: boolean;
  /** 该 run 位于最后一条真人文本轮之后（仍在当前这一轮里）。 */
  inLatestWindow: boolean;
}

export type AgentRunStatus =
  | "failed"
  | "running"
  | "background"
  | "interrupted"
  | "pending"
  | "completed";

export interface AgentRunStatusSummary {
  status: AgentRunStatus;
  total: number;
  failed: number;
  running: number;
  background: number;
  interrupted: number;
  pending: number;
  completed: number;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 工具结果文本原样取出（保留换行）：结论体要用它渲染 markdown，
 * 早先把 `\n` 压成空格再走 renderMarkdown，标题/列表/代码块会全塌成一段。
 */
export function agentRunResultRawText(block: any): string {
  if (!block) return "";
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item && item.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as any).text === "string") {
    return String((content as any).text);
  }
  return "";
}

/**
 * 「派发回执」判据。形状来自 271 条真实 `Pi/subagent` toolResult 的全量聚类
 * （取证见 `.wand-team/run_46c0a39145b3/8-m_ca82f853.md`，形状表见
 * `docs/subagent-display.md` §6），不是照猜的合取式。分三层，顺序不可调换。
 *
 * 第一层：否决。状态查询与转录报告正文里同样含 `Run fan-out:` 和 `Output:`
 * （真实样本 130 + 12 条），只按「含什么关键字」判必然误判，所以先按首行前缀排除。
 */
const RECEIPT_DENY_HEAD =
  /^(Status target:|Transcript target:|Steering queued|Revived async subagent|Background task completed)/;

/** 第二层：认形状。pi 的两种异步派发回执首行都是 fan-out 预算行。 */
const RECEIPT_PI_HEAD = /^Run fan-out:\s*\d+\/\d+ used\b/;
const RECEIPT_PI_SINGLE = /^Async:\s*(\S[^\n]*)$/;
const RECEIPT_PI_WORKFLOW = /^Async workflow\b([^\n]*)$/;
/** qoder 的启动 ack 没有 fan-out 行，id 在 `agentId:` 且不是 uuid。 */
const RECEIPT_QODER_HEAD = /^Async agent launched successfully\./;
const RECEIPT_QODER_AGENT_ID = /^agentId:\s*([^\s(]+)/m;
/** 取行内最后一个方括号段：类型名自己带 `[general]` 时不能只取第一个。 */
const RECEIPT_BRACKET_ID = /\[([0-9a-fA-F-]{8,64})\]/g;
/**
 * `Output:` / `output_file:` **只用于字段提取，绝不作为判据条件**：
 * 真实 pi 派发回执根本没有 `Output:` 行（只有 `details.asyncDir` 目录），
 * 把它当必要条件会让真实语料里的 pi 派发回执**一条都不命中**。
 */
const RECEIPT_OUTPUT_FIELD = /^Output:\s*(\S+)/m;
const RECEIPT_QODER_OUTPUT_FIELD = /^output_file:\s*(\S+)/m;
/**
 * 第三层：兜底。provider 文案会变，白名单必然漏新形状；漏的时候宁可判中性
 * 「后台运行中」也不能标绿「最终结论」——后者是用户认定过的 bug，前者只是不够精确。
 * 正文一律照常渲染，不丢。
 */
const RECEIPT_BACKGROUND_PHRASES = [
  "detached and running in the background",
  "is working in the background",
  "will be notified automatically when it completes",
];

function lastBracketId(line: string): string {
  var found = "";
  var match: RegExpExecArray | null;
  RECEIPT_BRACKET_ID.lastIndex = 0;
  while ((match = RECEIPT_BRACKET_ID.exec(line)) !== null) found = match[1];
  return found;
}

/**
 * 识别「已交给后台、结果尚未回来」的派发回执。命中时结果块按回执渲染，
 * 不进「最终结论」、不标绿、不把 provider 的指令文案当 markdown 正文渲染。
 */
export function parseAsyncDispatchReceipt(text: string): AgentRunReceipt | null {
  const value = String(text || "").trim();
  if (!value) return null;
  if (RECEIPT_DENY_HEAD.test(value)) return null;

  const lines = value.split("\n");
  if (RECEIPT_PI_HEAD.test(lines[0])) {
    // 派发行通常在预算行之后，但中间可能插一整段 Preflight 计划表：真实语料里
    // 57 条紧跟第二行、9 条在第 6 行、最远一条在第 14 行（10 lanes 的表）。
    // 所以扫预算行之后的前 24 行，而不是硬写「第二行」——只认行首，正文里提到不算。
    for (let i = 1; i < Math.min(lines.length, 25); i++) {
      const line = String(lines[i] || "").trim();
      const shape = RECEIPT_PI_SINGLE.exec(line) || RECEIPT_PI_WORKFLOW.exec(line);
      if (shape) {
        return {
          runId: lastBracketId(shape[1]),
          outputPath: (RECEIPT_OUTPUT_FIELD.exec(value) || [])[1] || "",
        };
      }
    }
  }
  if (RECEIPT_QODER_HEAD.test(lines[0])) {
    const agentId = RECEIPT_QODER_AGENT_ID.exec(value);
    const output = RECEIPT_QODER_OUTPUT_FIELD.exec(value);
    return { runId: agentId ? agentId[1] : "", outputPath: output ? output[1] : "" };
  }
  const lowered = value.toLowerCase();
  if (RECEIPT_BACKGROUND_PHRASES.some((phrase) => lowered.includes(phrase))) {
    // 认不出形状，但正文明确说它已进后台：字段留空，由渲染侧回落到正文。
    return { runId: "", outputPath: "" };
  }
  return null;
}

/** 压平 + 去掉行内 markdown 记号，只用于单行摘要；正文不走这里。 */
export function flattenAgentRunInline(text: string): string {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateInlineText(value: string, max: number): string {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/**
 * 标题取名：任务描述优先（能区分每个 Agent 在干什么），其次才是 agentType。
 * 反过来（agentType 当标题）会让并行批次的 rail 每一行都写着 general-purpose。
 */
export function agentRunAgentTitle(agent: AgentRunAgent | null | undefined, fallback: string): string {
  const description = textValue(agent?.meta?.taskDescription);
  if (description) return description;
  const agentType = textValue(agent?.meta?.agentType);
  if (agentType) return agentType;
  return fallback;
}

/** 身份色种子：taskId 优先（同一批次并行 Agent 的 agentType 往往相同，取色会撞成一色）。 */
export function agentRunAccentSeed(agent: AgentRunAgent | null | undefined): string {
  return String(agent?.taskId || agent?.meta?.agentType || "agent-run");
}

/**
 * 派发判据：与 Web 服务端共用 `src/subagent-dispatch.ts` 同一份实现。
 * pi 的 `subagent` 以「有没有 `action`」区分管理/控制与真派发，所以
 * `subagent({ workflow: "…", async: true })` 这类工作流派发同样进「子 Agent」面板。
 * 这里只留薄包装，不再自己判参数形状。
 */
export function deriveSubagentMeta(block: any): AgentRunSourceMeta | null {
  return deriveSubagentDispatchMeta(block);
}

export function agentRunBlockKey(messageIndex: number, blockIndex: number): string {
  return String(messageIndex) + ":" + String(blockIndex);
}

function isDispatchBlock(block: any, meta: AgentRunSourceMeta | null): boolean {
  return !!meta && block && block.type === "tool_use" && String(block.id || "") === meta.taskId;
}

function isFinalResultBlock(block: any, taskId: string): boolean {
  return !!block && block.type === "tool_result" && String(block.tool_use_id || "") === taskId;
}

function isNeutralRunBlock(block: any): boolean {
  if (!block) return true;
  if (block.__processing === true) return true;
  if (block.type === "text") return !String(block.text || "").trim();
  if (block.type === "thinking") return !String(block.thinking || "").trim();
  if (block.type === "tool_result") return true;
  return false;
}

function compareRefs(a: AgentRunBlockRef, b: AgentRunBlockRef): number {
  return a.messageIndex - b.messageIndex || a.blockIndex - b.blockIndex;
}

function activityOf(live: AgentRunActivity): AgentRunActivity {
  return {
    sessionRunning: !!live?.sessionRunning,
    inLatestWindow: !!live?.inLatestWindow,
  };
}

/**
 * 单个子 Agent 的状态。三条事实缺一不可：有没有最终 result、会话还在不在跑、
 * 这个 run 是不是落在最新一轮里。只看「有没有 result」会把分页截断、
 * 结果尚未回填的历史任务读成「已中断」，与 Android 同一份历史显示不一致。
 */
function agentStatus(agent: AgentRunAgent, activity: AgentRunActivity): AgentRunStatus {
  if (agent.result) {
    if (agent.receipt) return "background";
    return agent.result.block && agent.result.block.is_error === true ? "failed" : "completed";
  }
  if (!activity.inLatestWindow) return "pending";
  return activity.sessionRunning ? "running" : "interrupted";
}

export function getAgentRunStatusSummary(
  run: AgentRun,
  live: AgentRunActivity,
): AgentRunStatusSummary {
  var activity = activityOf(live);
  var summary: AgentRunStatusSummary = {
    status: "completed",
    total: run.agents.length,
    failed: 0,
    running: 0,
    background: 0,
    interrupted: 0,
    pending: 0,
    completed: 0,
  };
  for (var i = 0; i < run.agents.length; i++) {
    summary[agentStatus(run.agents[i], activity)]++;
  }
  if (summary.failed > 0) summary.status = "failed";
  else if (summary.running > 0) summary.status = "running";
  else if (summary.background > 0) summary.status = "background";
  else if (summary.interrupted > 0) summary.status = "interrupted";
  else if (summary.pending > 0) summary.status = "pending";
  else summary.status = "completed";
  return summary;
}

/**
 * 「后台已结束」不是第七种状态，而是 background 在会话已停时的说法：
 * 回执证明不了后台到底跑完没有，所以不给绿色「已完成」，只中性说明已脱离本次会话。
 */
export function agentRunStatusLabelKey(status: AgentRunStatus, live: AgentRunActivity): string {
  var activity = activityOf(live);
  if (status === "background") {
    return activity.sessionRunning ? "agentRun.status.background" : "agentRun.status.backgroundDone";
  }
  return "agentRun.status." + status;
}

export function shouldAgentRunStartExpanded(status: AgentRunStatus, persisted: boolean | null): boolean {
  if (persisted !== null) return persisted;
  return status === "failed" || status === "running" || status === "background";
}

/**
 * run 是否落在最新一轮：任一成员块出现在最后一条真人文本轮之后。
 * 分页窗口截断的历史 run 因此不再参与 running / interrupted 判定。
 */
export function agentRunInLatestWindow(run: AgentRun, lastUserTextMessageIndex: number): boolean {
  if (lastUserTextMessageIndex < 0) return true;
  var refs: Array<AgentRunBlockRef | null | undefined> = [];
  for (var i = 0; i < run.agents.length; i++) {
    var agent = run.agents[i];
    refs.push(agent.dispatch, agent.result, agent.firstSeen);
    for (var j = 0; j < agent.blocks.length; j++) refs.push(agent.blocks[j]);
  }
  return refs.some(function (ref) { return !!ref && ref.messageIndex > lastUserTextMessageIndex; });
}

function blockRenderSignature(block: any): string {
  if (!block || typeof block !== "object") return "";
  var contentLength = 0;
  if (typeof block.text === "string") contentLength += block.text.length;
  if (typeof block.thinking === "string") contentLength += block.thinking.length;
  if (Array.isArray(block.content)) contentLength += JSON.stringify(block.content).length;
  return [
    String(block.type || ""),
    String(block.id || block.tool_use_id || ""),
    String(block.name || ""),
    String(contentLength),
    block.execution ? JSON.stringify(block.execution) : "",
    block.is_error === true ? "1" : "0",
  ].join(",");
}

export function buildAgentRunRenderSignature(index: AgentRunIndex): string {
  if (!index || !index.runs.length) return "";
  return index.runs.map(function(run) {
    return run.id + "|" + run.agents.map(function(agent) {
      var refs = (agent.dispatch ? [agent.dispatch] : []).concat(agent.blocks, agent.result ? [agent.result] : []);
      return agent.taskId + ":" + refs.map(function(ref) {
        return ref.messageIndex + "." + ref.blockIndex + "." + blockRenderSignature(ref.block);
      }).join("/");
    }).join("||");
  }).join("###");
}

/**
 * 最后一条「真人文本轮」的下标，语义与 Android collectSubagentActivities 的
 * lastHumanTurn 一致：role=user、有非空 text、且这个 text 不是子 Agent 轨迹。
 * 子 Agent 的结果也是以 user 消息回传的，不排掉会把窗口越推越后。
 */
function lastUserTextIndex(messages: AgentRunMessage[]): number {
  var lastIndex = -1;
  for (var mi = 0; mi < messages.length; mi++) {
    var message = messages[mi] || {};
    if (message.role !== "user") continue;
    var content = Array.isArray(message.content) ? message.content : [];
    var isHumanText = content.some(function (block: any) {
      return !!block && block.type === "text" &&
        String(block.text || "").trim() !== "" &&
        !deriveSubagentMeta(block);
    });
    if (isHumanText) lastIndex = mi;
  }
  return lastIndex;
}

export function collectAgentRuns(messages: AgentRunMessage[]): AgentRunIndex {
  var agentByTaskId = new Map<string, AgentRunAgent>();
  var dispatchTaskByBlockKey = new Map<string, string>();
  var ownerByBlockKey = new Map<string, string>();
  var taskByToolUseId = new Map<string, string>();

  function ensureAgent(meta: AgentRunSourceMeta, ref: AgentRunBlockRef): AgentRunAgent {
    var existing = agentByTaskId.get(meta.taskId);
    if (!existing) {
      existing = {
        taskId: meta.taskId,
        meta: { ...meta },
        dispatch: null,
        firstSeen: ref,
        blocks: [],
        result: null,
        receipt: null,
        runId: "",
      };
      agentByTaskId.set(meta.taskId, existing);
    } else if (!existing.meta.agentType && meta.agentType) {
      existing.meta.agentType = meta.agentType;
    }
    if (!existing.meta.taskDescription && meta.taskDescription) {
      existing.meta.taskDescription = meta.taskDescription;
    }
    if (compareRefs(ref, existing.firstSeen) < 0) existing.firstSeen = ref;
    return existing;
  }

  for (var mi = 0; mi < messages.length; mi++) {
    var message = messages[mi] || {};
    var content = Array.isArray(message.content) ? message.content : [];
    for (var bi = 0; bi < content.length; bi++) {
      var block = content[bi];
      var meta = deriveSubagentMeta(block);
      if (!meta) continue;
      var ref = { messageIndex: mi, blockIndex: bi, message: message, block: block };
      var agent = ensureAgent(meta, ref);
      if (isDispatchBlock(block, meta) && !agent.dispatch) {
        agent.dispatch = ref;
        dispatchTaskByBlockKey.set(agentRunBlockKey(mi, bi), agent.taskId);
      }
    }
  }

  for (var mi2 = 0; mi2 < messages.length; mi2++) {
    var message2 = messages[mi2] || {};
    var content2 = Array.isArray(message2.content) ? message2.content : [];
    for (var bi2 = 0; bi2 < content2.length; bi2++) {
      var block2 = content2[bi2];
      var ref2 = { messageIndex: mi2, blockIndex: bi2, message: message2, block: block2 };
      var key2 = agentRunBlockKey(mi2, bi2);
      var meta2 = deriveSubagentMeta(block2);
      var taskId = meta2 ? meta2.taskId : "";
      if (!taskId && block2 && block2.type === "tool_result") {
        var childToolUseId = String(block2.tool_use_id || "");
        var resultOwner = agentByTaskId.get(childToolUseId);
        if (resultOwner) taskId = resultOwner.taskId;
        else if (taskByToolUseId.has(childToolUseId)) taskId = taskByToolUseId.get(childToolUseId) || "";
      }
      if (!taskId) continue;
      var agent2 = meta2 ? ensureAgent(meta2, ref2) : agentByTaskId.get(taskId);
      if (!agent2) continue;
      if (block2 && block2.type === "tool_use" && block2.id) {
        taskByToolUseId.set(String(block2.id), agent2.taskId);
      }
      if (isDispatchBlock(block2, agent2.meta)) {
        ownerByBlockKey.set(key2, taskId);
        continue;
      }
      ownerByBlockKey.set(key2, taskId);
      if (isFinalResultBlock(block2, taskId)) {
        if (!agent2.result || compareRefs(ref2, agent2.result) > 0) {
          agent2.result = ref2;
          // 失败的结果不是「已交给后台」，判据不参与，保持「失败原因」展示。
          agent2.receipt = block2.is_error === true
            ? null
            : parseAsyncDispatchReceipt(agentRunResultRawText(block2));
        }
      } else {
        agent2.blocks.push(ref2);
      }
    }
  }

  var runs: AgentRun[] = [];
  var runByTaskId = new Map<string, AgentRun>();

  for (var mi3 = 0; mi3 < messages.length; mi3++) {
    var message3 = messages[mi3] || {};
    var content3 = Array.isArray(message3.content) ? message3.content : [];
    var active: AgentRun | null = null;
    for (var bi3 = 0; bi3 < content3.length; bi3++) {
      var key3 = agentRunBlockKey(mi3, bi3);
      var dispatchTaskId = dispatchTaskByBlockKey.get(key3);
      if (dispatchTaskId) {
        var dispatchAgent = agentByTaskId.get(dispatchTaskId);
        if (!dispatchAgent) continue;
        if (!active) {
          var ref3 = { messageIndex: mi3, blockIndex: bi3, message: message3, block: content3[bi3] };
          active = {
            id: "agent-run:" + mi3 + ":" + bi3 + ":" + dispatchTaskId,
            messageIndex: mi3,
            startBlockIndex: bi3,
            endBlockIndex: bi3,
            anchor: ref3,
            agents: [],
          };
          runs.push(active);
        }
        if (!active.agents.some(function(item) { return item.taskId === dispatchAgent.taskId; })) {
          active.agents.push(dispatchAgent);
          runByTaskId.set(dispatchAgent.taskId, active);
        }
        active.endBlockIndex = bi3;
        continue;
      }
      if (!active) continue;
      var owner = ownerByBlockKey.get(key3);
      if (owner) {
        var belongsToActive = active.agents.some(function(item) { return item.taskId === owner; });
        if (belongsToActive) active.endBlockIndex = bi3;
        continue;
      }
      if (isNeutralRunBlock(content3[bi3])) {
        active.endBlockIndex = bi3;
        continue;
      }
      active = null;
    }
  }

  var ungrouped = [];
  agentByTaskId.forEach(function(agent) {
    if (!agent.runId && !runByTaskId.has(agent.taskId)) ungrouped.push(agent);
  });
  ungrouped.sort(function(a, b) { return compareRefs(a.firstSeen, b.firstSeen); });
  for (var ui = 0; ui < ungrouped.length; ui++) {
    var agent3 = ungrouped[ui];
    var anchor3 = agent3.dispatch || agent3.firstSeen;
    var run3: AgentRun = {
      id: "agent-run:" + anchor3.messageIndex + ":" + anchor3.blockIndex + ":" + agent3.taskId,
      messageIndex: anchor3.messageIndex,
      startBlockIndex: anchor3.blockIndex,
      endBlockIndex: anchor3.blockIndex,
      anchor: anchor3,
      agents: [agent3],
    };
    runs.push(run3);
    runByTaskId.set(agent3.taskId, run3);
  }

  runs.forEach(function(run) {
    run.agents.forEach(function(agent) { agent.runId = run.id; });
  });

  var runsByMessageIndex = new Map<number, Map<number, AgentRun>>();
  runs.forEach(function(run) {
    var messageRuns = runsByMessageIndex.get(run.messageIndex);
    if (!messageRuns) {
      messageRuns = new Map<number, AgentRun>();
      runsByMessageIndex.set(run.messageIndex, messageRuns);
    }
    messageRuns.set(run.startBlockIndex, run);
  });

  return {
    agents: Array.from(agentByTaskId.values()),
    agentByTaskId: agentByTaskId,
    ownerByBlockKey: ownerByBlockKey,
    runs: runs,
    runsByMessageIndex: runsByMessageIndex,
    lastUserTextMessageIndex: lastUserTextIndex(messages),
  };
}
