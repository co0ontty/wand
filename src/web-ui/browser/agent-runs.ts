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
  runId: string;
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
}

export type AgentRunStatus = "failed" | "running" | "interrupted" | "completed";

export interface AgentRunStatusSummary {
  status: AgentRunStatus;
  total: number;
  failed: number;
  running: number;
  interrupted: number;
  completed: number;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inputRecord(block: any): Record<string, unknown> {
  return block && block.input && typeof block.input === "object" ? block.input : {};
}

export function deriveSubagentMeta(block: any): AgentRunSourceMeta | null {
  if (!block) return null;
  var stamped = block.__subagent;
  if (stamped && textValue(stamped.taskId)) {
    return {
      taskId: stamped.taskId,
      ...(textValue(stamped.agentType) ? { agentType: textValue(stamped.agentType) } : {}),
      ...(textValue(stamped.taskDescription) ? { taskDescription: textValue(stamped.taskDescription) } : {}),
    };
  }
  if (block.type !== "tool_use" && block.type !== "tool_result") return null;
  if (block.type !== "tool_use") return null;

  var input = inputRecord(block);
  if (block.name === "Pi/subagent") {
    var piAgent = textValue(input.agent);
    var piTask = textValue(input.task);
    if (!piAgent && !piTask) return null;
    return {
      taskId: String(block.id || ""),
      ...(piAgent ? { agentType: piAgent } : {}),
      ...(piTask ? { taskDescription: piTask } : {}),
    };
  }
  var agentType = textValue(input.subagent_type);
  if (block.name !== "Task" && block.name !== "Agent" && !agentType) return null;
  if (!textValue(block.id)) return null;
  return {
    taskId: block.id,
    ...(agentType ? { agentType } : {}),
    ...(textValue(input.description) ? { taskDescription: textValue(input.description) } : {}),
  };
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

function agentStatus(agent: AgentRunAgent, isLive: boolean): AgentRunStatus {
  if (agent.result) return agent.result.block && agent.result.block.is_error === true ? "failed" : "completed";
  return isLive ? "running" : "interrupted";
}

export function getAgentRunStatusSummary(run: AgentRun, isLive: boolean): AgentRunStatusSummary {
  var summary: AgentRunStatusSummary = {
    status: "completed",
    total: run.agents.length,
    failed: 0,
    running: 0,
    interrupted: 0,
    completed: 0,
  };
  for (var i = 0; i < run.agents.length; i++) {
    var status = agentStatus(run.agents[i], isLive);
    summary[status]++;
  }
  if (summary.failed > 0) summary.status = "failed";
  else if (summary.running > 0) summary.status = "running";
  else if (summary.interrupted > 0) summary.status = "interrupted";
  else summary.status = "completed";
  return summary;
}

export function shouldAgentRunStartExpanded(status: AgentRunStatus, persisted: boolean | null): boolean {
  if (persisted !== null) return persisted;
  return status === "failed" || status === "running";
}

export function getLatestAgentRunId(index: AgentRunIndex | null | undefined): string {
  if (!index || !index.runs.length) return "";
  var latest = index.runs[0];
  for (var i = 1; i < index.runs.length; i++) {
    var run = index.runs[i];
    if (run.messageIndex > latest.messageIndex ||
        (run.messageIndex === latest.messageIndex && run.startBlockIndex >= latest.startBlockIndex)) {
      latest = run;
    }
  }
  return latest.id;
}

export function agentRunTouchesMessage(run: AgentRun, messageIndex: number): boolean {
  if (!run || typeof messageIndex !== "number" || messageIndex < 0) return false;
  for (var i = 0; i < run.agents.length; i++) {
    var agent = run.agents[i];
    var refs = [agent.dispatch, agent.firstSeen, agent.result].concat(agent.blocks);
    for (var j = 0; j < refs.length; j++) {
      if (refs[j] && refs[j].messageIndex === messageIndex) return true;
    }
  }
  return false;
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
    block.is_error === true ? "1" : "0",
  ].join(",");
}

export function buildAgentRunRenderSignature(index: AgentRunIndex): string {
  if (!index || !index.runs.length) return "";
  return index.runs.map(function(run) {
    return run.id + "|" + run.agents.map(function(agent) {
      var refs = agent.blocks.concat(agent.result ? [agent.result] : []);
      return agent.taskId + ":" + refs.map(function(ref) {
        return ref.messageIndex + "." + ref.blockIndex + "." + blockRenderSignature(ref.block);
      }).join("/");
    }).join("||");
  }).join("###");
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
        if (!agent2.result || compareRefs(ref2, agent2.result) > 0) agent2.result = ref2;
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
  };
}
