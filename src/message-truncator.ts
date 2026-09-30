/** Keep tool payloads out of all chat snapshots and fetch them only when opened. */

import { createHash } from "node:crypto";
import { contentHasStructuredImage } from "./structured-content.js";
import type { CardExpandDefaults, ContentBlock, ConversationTurn, ToolResultBlock, ToolUseBlock } from "./types.js";

const TRUNCATION_THRESHOLD = 200;
const SUMMARY_LENGTH = 100;


/**
 * 默认窗口大小：init/resync/快照/REST 默认只下发最近这么多条 turn，更早的由客户端
 * 滚动到顶时按需分页拉取。移动端 WebSocket 单帧上限（iOS 默认 1 MiB）下，长会话一次
 * 全量下发会撑爆帧导致反复断连——窗口化是根治手段，64MB 提帧只是兜底。
 */
const MESSAGE_WINDOW_SIZE = 40;

/**
 * 块级窗口的默认预算：显式启用时 init/REST 只下发最近这么多个「内容块」（跨 turn 累计，
 * 必要时切掉最旧那条 turn 的头部），更早的块由客户端滚动到顶时按需分页拉取。
 * turn 级窗口（MESSAGE_WINDOW_SIZE）对「单条 turn 携带上百块」的长任务无能为力——
 * 一条流式 assistant turn 可膨胀到 1MB+，整条下发会撑爆移动端 WS 帧、拖慢打开。
 * 块级窗口是对这种会话的根治手段。客户端显式带 blockBudget 时启用（Web/iOS），
 * 未携带的原生客户端仍走 turn 级路径。
 */
const MESSAGE_BLOCK_WINDOW = 60;

export interface WindowedMessages {
  /** 已截断 + 窗口化后的 turn 列表（最近 windowSize 条）。 */
  messages: ConversationTurn[];
  /** messages[0] 在完整历史里的绝对下标（0 表示已含最早一条）。 */
  messageOffset: number;
  /** 完整历史的 turn 总数（客户端据此判断是否还有更早的可加载）。 */
  messageTotal: number;
}

export interface BlockWindowedMessages extends WindowedMessages {
  /** messages[0] 被切掉的头部块数（0 表示该 turn 完整；>0 表示其更早的块需翻页）。 */
  leadingBlockOffset: number;
  /** turn messageOffset 的完整块数（客户端据此判断该 turn 是否已全部加载）。 */
  leadingBlockTotal: number;
  /**
   * 被切掉的头部里「用户可感知」的块数：默认收起的工具 / 思考块不计入（它们在客户端
   * 合并成一条折叠条，不该被当成一条更早消息）。客户端据此显示「还有 N 条」。
   */
  leadingVisibleCount: number;
}

/**
 * 首次下发（首屏）的载荷上限：截断后的聊天 JSON 体积。整段历史在这个体积内就不做窗口化 ——
 * 一条提示词 + 一段长回复的会话不该因为几十个默认收起的工具块就出现「更早消息」。
 * 超出的会话才按下面的预算从尾部切：客户端先翻这条 turn 的头部块，再按 turn 往前翻。
 */
export const MESSAGE_FIRST_PAINT_BYTES = 1024 * 1024;

/**
 * 吸附回退的额外载荷上限：折叠段往回吃掉的体积超过它就改为跳过整段，
 * 而不是把整段拉进首屏（窗口的目标是压住首屏载荷，吸附不能反过来把它撑大）。
 */
const MAX_BLOCK_SNAP_BACK_BYTES = 128 * 1024;

/** 每个块在客户端是否「默认收起」（思考块 + 默认收起的工具卡片，与传输截断同一口径）。 */
export function collapsedBlockFlags(
  content: ContentBlock[],
  cardDefaults: CardExpandDefaults,
): boolean[] {
  const toolNameById = new Map<string, string>();
  for (const block of content) {
    if (block.type === "tool_use") toolNameById.set((block as ToolUseBlock).id, (block as ToolUseBlock).name);
  }
  return content.map((block) => {
    switch (block.type) {
      case "thinking":
        return cardDefaults.thinking !== true;
      case "tool_use":
        return isToolDefaultCollapsed((block as ToolUseBlock).name, cardDefaults);
      case "tool_result":
        return isToolDefaultCollapsed(toolNameById.get((block as ToolResultBlock).tool_use_id) ?? "", cardDefaults);
      default:
        return false;
    }
  });
}

/**
 * 单块在传输层的大致字节数（与 truncateMessagesForTransport 的截断口径一致，
 * 否则「体积预算」会把已经截断的大块算得过重）。
 */
function blockTransportBytes(
  block: ContentBlock,
  cardDefaults: CardExpandDefaults,
  toolNameById: Map<string, string>,
): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "thinking":
      return block.thinking.length;
    case "tool_use": {
      const use = block as ToolUseBlock;
      let bytes = use.id.length + use.name.length + 32;
      if (use.input) bytes += JSON.stringify(use.input)?.length ?? 0;
      if (use.description) bytes += use.description.length;
      if (use.semantic) bytes += JSON.stringify(use.semantic).length;
      if (use.activity) bytes += JSON.stringify(use.activity).length;
      return bytes;
    }
    case "tool_result": {
      const result = block as ToolResultBlock;
      const raw = getContentString(result.content);
      const collapsed = isToolDefaultCollapsed(toolNameById.get(result.tool_use_id) ?? "", cardDefaults);
      const truncated = collapsed && !result.is_error &&
        !contentHasStructuredImage(result.content) && raw.length > TRUNCATION_THRESHOLD;
      return truncated ? SUMMARY_LENGTH + 4 : raw.length;
    }
    default:
      return 0;
  }
}

/**
 * 一段内容在传输层的估算体积。`limit` 用来提前收尾：一旦确认超过它就不再往下算
 * （预算判定只需要知道「超了」，不需要精确值）。
 */
export function contentTransportBytes(
  content: ContentBlock[],
  cardDefaults: CardExpandDefaults,
  limit: number = Number.POSITIVE_INFINITY,
): number {
  const toolNameById = new Map<string, string>();
  for (const block of content) {
    if (block.type === "tool_use") toolNameById.set((block as ToolUseBlock).id, (block as ToolUseBlock).name);
  }
  let total = 0;
  for (const block of content) {
    total += blockTransportBytes(block, cardDefaults, toolNameById) + 32;
    if (total > limit) return total;
  }
  return total;
}

/**
 * 整段历史（或一条 turn）在可见条数 / 载荷两个预算内是否放得下。
 * 任一预算被突破就立即返回 false，不把整段内容算完。
 */
function fitsBudgets(
  turns: ConversationTurn[],
  cardDefaults: CardExpandDefaults,
  visibleBudget: number,
  byteBudget: number,
): boolean {
  let visible = 0;
  let bytes = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const content = turns[i].content;
    visible += visibleBlockCount(content, cardDefaults, content.length);
    if (visible > visibleBudget) return false;
    bytes += contentTransportBytes(content, cardDefaults, byteBudget - bytes);
    if (bytes > byteBudget) return false;
  }
  return true;
}

/**
 * 从尾部往前取到两个预算用完为止，返回该起点：
 * 默认收起的工具 / 思考块不占可见条数预算（它们在客户端合并成一条折叠条），只算体积。
 */
function cutStartByBudget(
  content: ContentBlock[],
  cardDefaults: CardExpandDefaults,
  visibleBudget: number,
  byteBudget: number,
): number {
  if (content.length === 0) return 0;
  const collapsed = collapsedBlockFlags(content, cardDefaults);
  const toolNameById = new Map<string, string>();
  for (const block of content) {
    if (block.type === "tool_use") toolNameById.set((block as ToolUseBlock).id, (block as ToolUseBlock).name);
  }
  let visible = 0;
  let bytes = 0;
  let cut = content.length;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const nextVisible = visible + (collapsed[i] ? 0 : 1);
    const nextBytes = bytes + blockTransportBytes(content[i], cardDefaults, toolNameById) + 32;
    if (nextVisible > visibleBudget || nextBytes > byteBudget) break;
    visible = nextVisible;
    bytes = nextBytes;
    cut = i;
  }
  // 至少保留最后一块：单个巨块超预算时也得给客户端一点内容。
  return cut >= content.length ? content.length - 1 : cut;
}

/** 段内最靠左的坐标：从 index 往回吃掉同一段折叠块。 */
function collapsedRunStart(collapsed: boolean[], index: number): number {
  let start = index;
  while (start > 0 && collapsed[start - 1]) start -= 1;
  return start;
}

/** 段内最靠右的坐标：从 index 往后吃掉同一段折叠块。 */
function collapsedRunEnd(collapsed: boolean[], index: number): number {
  let end = index;
  while (end < collapsed.length && collapsed[end]) end += 1;
  return end;
}

/**
 * 把块级窗口 / 翻页的起点吸附到「语义干净」的位置：
 *
 * 1. 起点落在默认收起的折叠段中间 → 回到该段起点（整段入窗）。半截工具段在客户端
 *    会渲染成一个少了前几个调用的折叠条，用户看着就是「更早消息缺了一块」。
 * 2. 起点是配对的 tool_result（它的 tool_use 被切在前面）→ 回到 tool_use，否则客户端
 *    顶部会冒出一张「无头结果」卡。
 * 3. 需要往回吃掉的体积超过 MAX_BLOCK_SNAP_BACK_BYTES（或本页范围内吃不下）时不再
 *    往回吸附，改为跳到该段之后（整段都是默认收起的内容，跳过去不会藏掉可见内容）。
 *
 * 返回吸附后的起点；起点越界时回退到 0（整条 turn 入窗，保证窗口不为空）。
 */
export function alignedBlockStart(
  content: ContentBlock[],
  cardDefaults: CardExpandDefaults,
  rawStart: number,
  forwardLimit: number = content.length,
): number {
  const total = content.length;
  const start = Math.min(Math.max(rawStart, 0), total);
  if (start <= 0 || total === 0) return 0;
  const collapsed = collapsedBlockFlags(content, cardDefaults);
  const useIndexById = new Map<string, number>();
  content.forEach((block, index) => {
    if (block.type === "tool_use") useIndexById.set((block as ToolUseBlock).id, index);
  });

  let cursor = start;
  for (let guard = 0; guard <= total; guard += 1) {
    let next = collapsed[cursor] ? collapsedRunStart(collapsed, cursor) : cursor;
    const head = content[next];
    if (head?.type === "tool_result") {
      const useIndex = useIndexById.get((head as ToolResultBlock).tool_use_id);
      if (useIndex !== undefined && useIndex < next) next = useIndex;
    }
    if (next === cursor) break;
    cursor = next;
  }
  const snapBackBytes = contentTransportBytes(content.slice(cursor, start), cardDefaults);
  if (snapBackBytes <= MAX_BLOCK_SNAP_BACK_BYTES) return cursor;

  // 折叠段太长：不再往回吃，跳到该段之后，保证首屏载荷不因吸附膨胀。
  const skipped = collapsed[cursor] ? collapsedRunEnd(collapsed, cursor) : cursor;
  if (skipped >= total) return 0;
  // 跳不到更晚的位置（只可能还是往回吃）或超过本页末尾时保持原切点。
  if (skipped <= start || skipped >= forwardLimit) return start;
  return skipped;
}

/** [0, end) 里用户可感知的块数（默认收起的工具 / 思考块不计入）。 */
export function visibleBlockCount(
  content: ContentBlock[],
  cardDefaults: CardExpandDefaults,
  end: number,
): number {
  const limit = Math.min(Math.max(end, 0), content.length);
  const collapsed = collapsedBlockFlags(content, cardDefaults);
  let count = 0;
  for (let i = 0; i < limit; i += 1) {
    if (!collapsed[i]) count += 1;
  }
  return count;
}

/**
 * 块级窗口：默认取整段历史（只要它在预算内），超出的才从最新 turn 往回累计，
 * 能整条放下就整条放，放不下的那条（最旧的入窗 turn）只取其尾部若干块，
 * 并通过 leadingBlockOffset 告知客户端「这条 turn 还有更早的块」。
 *
 * 预算口径：`blockBudget` 数的是**用户可感知的条数**（默认收起的工具 / 思考块不计入），
 * 另外叠加一层载荷上限 —— 否则一段长工具调用会把预算吃光，把用户自己的提示词挤出首屏，
 * 一条提示词的会话也会莫名出现「更早消息」。
 */
export function blockWindowMessagesForTransport(
  all: ConversationTurn[] | undefined,
  cardDefaults: CardExpandDefaults,
  blockBudget: number = MESSAGE_BLOCK_WINDOW,
  byteBudget: number = MESSAGE_FIRST_PAINT_BYTES,
): BlockWindowedMessages {
  const turns = all ?? [];
  const total = turns.length;
  if (total === 0) {
    return {
      messages: [],
      messageOffset: 0,
      messageTotal: 0,
      leadingBlockOffset: 0,
      leadingBlockTotal: 0,
      leadingVisibleCount: 0,
    };
  }
  const visibleBudget = Math.max(1, blockBudget);

  // 整段历史放得下就不做窗口化：短会话（一条提示词 + 一段长回复）不该出现「更早消息」。
  if (fitsBudgets(turns, cardDefaults, visibleBudget, byteBudget)) {
    const last = turns[total - 1];
    return {
      messages: truncateMessagesForTransport(turns, cardDefaults),
      messageOffset: 0,
      messageTotal: total,
      leadingBlockOffset: 0,
      leadingBlockTotal: last.content.length,
      leadingVisibleCount: 0,
    };
  }

  let startTurn = total - 1;
  let leadingBlockOffset = 0;
  let accVisible = 0;
  let accBytes = 0;
  for (let i = total - 1; i >= 0; i -= 1) {
    const content = turns[i].content;
    const visible = visibleBlockCount(content, cardDefaults, content.length);
    const bytes = contentTransportBytes(content, cardDefaults, byteBudget - accBytes);
    if (accVisible + visible <= visibleBudget && accBytes + bytes <= byteBudget) {
      accVisible += visible;
      accBytes += bytes;
      startTurn = i;
      leadingBlockOffset = 0;
      continue;
    }
    // 放不下：按剩余预算切进这条 turn 的尾部；预算已耗尽则到此为止。
    const remainVisible = visibleBudget - accVisible;
    const remainBytes = byteBudget - accBytes;
    if (i !== total - 1 && (remainVisible <= 0 || remainBytes <= 0)) break;
    startTurn = i;
    leadingBlockOffset = cutStartByBudget(
      content,
      cardDefaults,
      Math.max(remainVisible, 1),
      Math.max(remainBytes, 1),
    );
    break;
  }

  // 最旧入窗 turn 的切点吸附到干净边界：不切开折叠的工具段，也不留下无头 tool_result。
  const headContent = turns[startTurn].content;
  const startOffset = leadingBlockOffset > 0
    ? alignedBlockStart(headContent, cardDefaults, leadingBlockOffset)
    : 0;

  const windowedTurns: ConversationTurn[] = [];
  for (let i = startTurn; i < total; i++) {
    if (i === startTurn && startOffset > 0) {
      windowedTurns.push({ ...turns[i], content: turns[i].content.slice(startOffset) });
    } else {
      windowedTurns.push(turns[i]);
    }
  }

  return {
    messages: truncateMessagesForTransport(windowedTurns, cardDefaults),
    messageOffset: startTurn,
    messageTotal: total,
    leadingBlockOffset: startOffset,
    leadingBlockTotal: headContent.length,
    leadingVisibleCount: visibleBlockCount(headContent, cardDefaults, startOffset),
  };
}

/**
 * 块级翻页：取某条 turn 的 content[start, end) 这一段（已做 transport 截断）。
 * 客户端滚动到顶、且当前最旧 turn 仍有更早块时调用，end = 客户端当前 leadingBlockOffset。
 */
export function sliceTurnBlocksForTransport(
  turn: ConversationTurn,
  start: number,
  end: number,
  cardDefaults: CardExpandDefaults,
): ContentBlock[] {
  const blocks = turn.content.slice(start, end);
  if (blocks.length === 0) return [];
  return truncateMessagesForTransport([{ ...turn, content: blocks }], cardDefaults)[0].content;
}

/**
 * 取完整历史的「最近 windowSize 条」并对其做 transport 截断，附带 offset/total 元数据。
 * 客户端持有的永远是一段连续的「后缀」（最近的若干条），更早的按 offset 往前翻页。
 */
export function windowMessagesForTransport(
  all: ConversationTurn[] | undefined,
  cardDefaults: CardExpandDefaults,
  windowSize: number = MESSAGE_WINDOW_SIZE,
): WindowedMessages {
  const total = all?.length ?? 0;
  const offset = Math.max(0, total - windowSize);
  const slice = all ? all.slice(offset) : [];
  return {
    messages: truncateMessagesForTransport(slice, cardDefaults),
    messageOffset: offset,
    messageTotal: total,
  };
}

/** Tool name → cardDefaults field mapping */
function isToolDefaultCollapsed(toolName: string, defaults: CardExpandDefaults): boolean {
  switch (toolName) {
    case "Read": case "Glob": case "Grep": case "WebFetch": case "WebSearch": case "TodoRead":
      return defaults.inlineTools !== true;
    case "Bash":
      return defaults.terminal !== true;
    case "Edit": case "Write": case "MultiEdit":
      return defaults.editCards !== true;
    default:
      return false;
  }
}

function inputString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function toolActivity(use: ToolUseBlock, hasImage: boolean): NonNullable<ToolUseBlock["activity"]> {
  if (use.activity) {
    const kind = use.activity.kind;
    return {
      kind,
      label: activityLabel(kind),
      ...(use.activity.fileKey ? { fileKey: use.activity.fileKey } : {}),
      ...(hasImage || use.activity.hasImage ? { hasImage: true } : {}),
    };
  }
  const name = use.name.toLowerCase();
  const input = use.input ?? {};
  const path = inputString(input, "file_path", "path", "filename", "file", "notebook_path");
  const kind = /^(edit|write|multiedit|notebookedit|apply_patch|file_change|file_edit)$/.test(name)
    ? "edit_file"
    : /^(read|glob|grep|webfetch|websearch|todoread|search|read_file)$/.test(name)
      ? "read_file"
      : /^(bash|exec|exec_command|command_execution|shell_command|terminal|run_command)$/.test(name)
        ? "run_command"
        : "other";
  const fileKey = path && (kind === "edit_file" || kind === "read_file")
    ? createHash("sha256").update(path.replace(/\\/g, "/")).digest("hex").slice(0, 20)
    : undefined;
  const imagePath = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#].*)?$/i.test(path);
  return {
    kind,
    label: activityLabel(kind),
    ...(fileKey ? { fileKey } : {}),
    ...(hasImage || imagePath ? { hasImage: true } : {}),
  };
}

function activityLabel(kind: NonNullable<ToolUseBlock["activity"]>["kind"]): string {
  switch (kind) {
    case "edit_file": return "修改文件";
    case "read_file": return "查看文件";
    case "run_command": return "运行命令";
    default: return "使用工具";
  }
}

const INDEPENDENT_TOOL_NAMES = new Set([
  "AskUserQuestion", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList",
  "Pi/todo", "Task", "Agent", "Pi/subagent",
]);

function toolInputShowsImage(input: Record<string, unknown>): boolean {
  const path = inputString(input, "file_path", "path", "url");
  return /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:[?#].*)?$/i.test(path);
}

/**
 * Project ordinary activity tools to a lean transport shape, regardless of
 * result size or streaming/error state. Interactive questions, task lists,
 * subagents and image cards retain their independent visible contracts.
 */
export function compactToolMessagesForTransport(
  messages: ConversationTurn[],
  knownToolNames?: ReadonlyMap<string, string>,
): ConversationTurn[] {
  const toolNameMap = new Map<string, string>(knownToolNames);
  const imageToolIds = new Set<string>();
  const independentToolIds = new Set<string>();
  for (const turn of messages) {
    for (const block of turn.content) {
      if (block.type === "tool_use") {
        toolNameMap.set((block as ToolUseBlock).id, (block as ToolUseBlock).name);
        if (INDEPENDENT_TOOL_NAMES.has(block.name) || block.semantic || block.__subagent
          || toolInputShowsImage(block.input ?? {})) independentToolIds.add(block.id);
      } else if (block.type === "tool_result" && contentHasStructuredImage(block.content)) {
        imageToolIds.add(block.tool_use_id);
      }
    }
  }
  return messages.map((turn) => {
    const truncatedContent: ContentBlock[] = turn.content.map((block): ContentBlock => {
      if (block.type === "tool_use") {
        if (independentToolIds.has(block.id) || imageToolIds.has(block.id)) return block;
        return {
          ...block,
          description: undefined,
          input: {},
          activity: toolActivity(block, imageToolIds.has(block.id)),
          __subagent: block.__subagent ? {
            ...block.__subagent,
            taskDescription: undefined,
          } : undefined,
        };
      }
      if (block.type === "tool_result" && toolNameMap.has(block.tool_use_id)
        && !INDEPENDENT_TOOL_NAMES.has(toolNameMap.get(block.tool_use_id)!)
        && !independentToolIds.has(block.tool_use_id)
        && !imageToolIds.has(block.tool_use_id)
        && !block.__subagent) {
        return { ...block, content: "", _truncated: true };
      }
      return block;
    });
    return { ...turn, content: truncatedContent };
  });
}

function getContentString(content: ToolResultBlock["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** Existing transport behavior for clients that have not opted into compact tool cards. */
export function truncateMessagesForTransport(
  messages: ConversationTurn[],
  cardDefaults: CardExpandDefaults,
  streamingTurnIndex = -1,
): ConversationTurn[] {
  return messages.map((turn, turnIndex) => {
    if (turnIndex === streamingTurnIndex) return turn;
    const toolNameMap = new Map<string, string>();
    for (const block of turn.content) {
      if (block.type === "tool_use") toolNameMap.set(block.id, block.name);
    }
    let changed = false;
    const truncatedContent: ContentBlock[] = turn.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (block.is_error) return block;
      const toolName = toolNameMap.get(block.tool_use_id) ?? "";
      if (!isToolDefaultCollapsed(toolName, cardDefaults)) return block;
      if (contentHasStructuredImage(block.content)) return block;
      const contentStr = getContentString(block.content);
      if (contentStr.length <= TRUNCATION_THRESHOLD) return block;
      changed = true;
      return { ...block, content: `${contentStr.slice(0, SUMMARY_LENGTH)}…`, _truncated: true };
    });
    return changed ? { ...turn, content: truncatedContent } : turn;
  });
}
