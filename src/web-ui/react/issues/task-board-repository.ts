import type {
  WandTask,
  WandTaskAgent,
  WandTaskDetail,
  WandTaskListed as WandTaskListedDto,
  WandTaskPriority,
  WandTaskStatus,
  WandTaskComment,
  TaskExecutionSubject,
} from "../../../task-types";
import type { ConversationTurn } from "../../../types.js";
import { normalizeIssueAgentDefaults, type IssueWorkspace } from "./task-board-agent";
import { HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { taskMutationCompleted } from "../task-changes";

function mutateTask<T>(url: string, init: RequestInit): Promise<T> {
  return requestJson<T>(url, init).then(taskMutationCompleted);
}

let agentDefaultsWrite = Promise.resolve();
const dispatchRequests = new Map<string, string>();


/** GET /api/wand-tasks 返回的任务：附带头部所需的工作空间、里程碑与已绑定会话。 */
export interface WandTaskListed extends WandTaskListedDto {
  canArchive?: boolean;
  assignedExecutor?: { id: string; name: string; avatar?: string } | null;
  workspace: { id: string; name: string; cwd: string } | null;
  /** 服务端已解出的里程碑（含名称），卡片可以直接显示。 */
  milestone: { id: string; name: string } | null;
  sessions: IssueSessionSummary[];
}

export interface IssueSessionSummary {
  employeeId?: string;
  employeeName?: string;
  employeeAvatar?: string;
  id: string;
  provider: string;
  sessionKind: string;
  title: string;
  status: string;
  cwd: string;
  model: string;
  thinkingEffort: string;
  /** 会话实际跑的执行模式；旧会话可能为空。 */
  mode?: string;
  /** 执行引擎：`sdk` = Wand Agent（进程内），`cli`（或缺失）= Pi CLI。 */
  engine?: "cli" | "sdk";
  /** Present only for sessions created by a task-comment employee dispatch. */
  taskCommentId?: string;
}

export interface IssueDispatchResult {
  ok: boolean;
  taskId: string;
  session: {
    id: string;
    provider: string;
    model: string | null;
    thinkingEffort: string;
    mode?: string;
    cwd: string;
  } | null;
  subject?: TaskExecutionSubject;
  teamRun?: { run: { id: string } };
}

export const taskBoardRepository = {
  list(workspaceId?: string): Promise<WandTaskListed[]> {
    return requestJson(`/api/wand-tasks${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`);
  },
  workspaces(): Promise<IssueWorkspace[]> {
    return requestJson("/api/workspaces");
  },
  /** 服务端模型目录；派发下拉需要按 provider 过滤可选模型。 */
  models(): Promise<unknown> {
    return requestJson("/api/models");
  },
  create(input: {
    workspaceId: string | null;
    /** 可选：留空时由服务端按描述自动生成标题。 */
    title: string;
    description: string;
    status: WandTaskStatus;
    priority: WandTaskPriority;
    labels: string[];
    dueDate?: string | null;
    /** 里程碑 id；null / 省略表示不归入里程碑。 */
    milestoneId?: string | null;
    /** 将任务归入同项目未归档主任务，不启动执行。 */
    parentTaskId?: string | null;
    agent?: WandTaskAgent | null;
    executionSubject?: TaskExecutionSubject | null;
    /** Only an explicit choice changes the defaults for future tasks. */
    rememberAgentDefaults?: boolean;
  }): Promise<WandTaskListed> {
    return mutateTask("/api/wand-tasks", jsonBody(input));
  },
  /** 单条任务：新建后用来确认后台自动标题是否已经生成。 */
  get(id: string): Promise<WandTaskListed> {
    return requestJson(`/api/wand-tasks/${encodeURIComponent(id)}`);
  },
  comments(id: string, options: { before?: string | null; limit?: number; signal?: AbortSignal } = {}): Promise<{ comments: WandTaskComment[]; totalCount: number; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (options.before) query.set("before", options.before);
    if (options.limit) query.set("limit", String(options.limit));
    return requestJson<{ comments: WandTaskComment[]; totalCount: number; nextCursor: string | null }>(`/api/wand-tasks/${encodeURIComponent(id)}/comments${query.size ? `?${query}` : ""}`, { signal: options.signal, cache: "no-store" })
      .catch(error => { if (error instanceof HttpResponseError && error.status === 404) return { comments: [], totalCount: 0, nextCursor: null }; throw error; });
  },
  commentStatuses(id: string, commentIds: string[], options: { signal?: AbortSignal } = {}): Promise<{ comments: Array<{ id: string; dispatch: WandTaskComment["dispatch"] }> }> {
    if (!commentIds.length) return Promise.resolve({ comments: [] });
    const query = new URLSearchParams({ ids: [...new Set(commentIds)].join(",") });
    return requestJson(`/api/wand-tasks/${encodeURIComponent(id)}/comments/status?${query}`, { signal: options.signal, cache: "no-store" });
  },
  commentSource(id: string, commentId: string, options: { signal?: AbortSignal } = {}): Promise<{ comment: Pick<WandTaskComment, "id" | "taskId" | "authorName" | "body" | "createdAt" | "sourceCommentId"> | null }> {
    return requestJson(`/api/wand-tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/source`, { signal: options.signal, cache: "no-store" });
  },
  commentResultBlocks(id: string, commentId: string, turnOffset: number, offset: number, options: { limit?: number; signal?: AbortSignal } = {}): Promise<{ turnOffset: number; blockOffset: number; blockTotal: number; blocks: Array<{ blockIndex: number; block: ConversationTurn["content"][number]; truncated: boolean }> }> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(options.limit ?? 32) });
    return requestJson(`/api/wand-tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/result/blocks/${turnOffset}?${query}`, { signal: options.signal, cache: "no-store" });
  },
  async commentResultTurnBlocks(id: string, commentId: string, turnOffset: number, options: { signal?: AbortSignal } = {}): Promise<{ content: ConversationTurn["content"]; truncatedBlocks: number[] }> {
    const blocks: Array<{ blockIndex: number; block: ConversationTurn["content"][number]; truncated: boolean }> = [];
    const maxBytes = 16 * 1024 * 1024;
    let offset = 0, total = 0, pages = 0, bytes = 0;
    do {
      if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      if (++pages > 4096 || bytes > maxBytes) throw new Error("结果内容块超出读取预算。");
      const page = await taskBoardRepository.commentResultBlocks(id, commentId, turnOffset, offset, { limit: 32, signal: options.signal });
      if (page.turnOffset !== turnOffset || !Number.isSafeInteger(page.blockOffset) || !Number.isSafeInteger(page.blockTotal)
        || page.blockOffset !== offset || page.blockTotal < 0 || page.blockTotal > 100_000
        || !Array.isArray(page.blocks) || page.blocks.some((entry, index) => entry.blockIndex !== offset + index)) {
        throw new Error("结果内容块分页位置无效。");
      }
      if (offset === 0) total = page.blockTotal;
      if (page.blockTotal !== total || page.blocks.length === 0 && offset < total) throw new Error("结果内容块分页未前进。");
      for (const entry of page.blocks) bytes += new TextEncoder().encode(JSON.stringify(entry.block)).byteLength;
      if (bytes > maxBytes) throw new Error("结果内容块超出读取预算。");
      blocks.push(...page.blocks);
      offset += page.blocks.length;
      if (offset > total) throw new Error("结果内容块分页越界。");
    } while (offset < total);
    return { content: blocks.map(entry => entry.block), truncatedBlocks: blocks.filter(entry => entry.truncated).map(entry => entry.blockIndex) };
  },

  commentResult(id: string, commentId: string, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<{ available: boolean; reason?: string; sessionId?: string; outcome?: "done" | "failed" | "stopped"; messages?: Array<ConversationTurn & { blockOffset?: number; blockTotal?: number }>; truncatedBlocks?: Array<{ turnOffset: number; blockIndex: number }>; offset?: number; total?: number }> {
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.offset) query.set("offset", String(options.offset));
    return requestJson(`/api/wand-tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/result${query.size ? `?${query}` : ""}`, { signal: options.signal, cache: "no-store" });
  },
  async commentResultBlock(id: string, commentId: string, turnOffset: number, blockIndex: number, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const base = `/api/wand-tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/result/block/${turnOffset}/${blockIndex}`;
    const chunks: Uint8Array[] = [];
    const maxBytes = 16 * 1024 * 1024;
    let offset = 0, total = 0, pages = 0;
    do {
      if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      if (++pages > 4096 || offset > maxBytes) throw new Error("结果 block 超出读取预算。");
      const query = new URLSearchParams({ offset: String(offset), limit: "16" });
      const page = await requestJson<{ blockJsonBase64: string; offset: number; total: number }>(`${base}?${query}`, { signal: options.signal, cache: "no-store" });
      const bytes = Uint8Array.from(atob(page.blockJsonBase64), character => character.charCodeAt(0));
      if (!Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.total) || page.offset !== offset || page.total < 0 || page.total > maxBytes || bytes.length > 64 * 1024 || !bytes.length && offset < page.total) throw new Error("结果 block 分页未前进或超出读取预算。");
      chunks.push(bytes); offset = page.offset + bytes.length; total = page.total;
      if (offset > maxBytes || total > maxBytes || offset > total) throw new Error("结果 block 超出读取预算。");
    } while (offset < total);
    const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let cursor = 0; for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length; }
    return JSON.parse(new TextDecoder().decode(output));
  },
  async commentResultTool(id: string, commentId: string, toolId: string, options: { signal?: AbortSignal } = {}): Promise<{ input: Record<string, unknown>; content: unknown; is_error: boolean; pending: boolean }> {
    type Page = { input?: Record<string, unknown>; inputJsonBase64: string; inputOffset: number; inputTotal: number;
      contentJsonBase64: string; offset: number; total: number; is_error: boolean; pending: boolean };
    const base = `/api/wand-tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/result/tool-content/${encodeURIComponent(toolId)}`;
    const fetchPage = (offset: number, inputOffset: number): Promise<Page> => {
      const query = new URLSearchParams({ limit: "16", offset: String(offset), inputOffset: String(inputOffset) });
      return requestJson(`${base}?${query}`, { signal: options.signal, cache: "no-store" });
    };
    const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const collect = async (key: "contentJsonBase64" | "inputJsonBase64", initial: Page): Promise<Uint8Array> => {
      const chunks: Uint8Array[] = [];
      const total = key === "contentJsonBase64" ? initial.total : initial.inputTotal;
      const maxBytes = 16 * 1024 * 1024;
      let offset = 0, page = initial, pages = 0;
      if (!Number.isSafeInteger(total) || total < 0 || total > maxBytes) throw new Error("工具详情超出读取预算。");
      while (offset < total) {
        if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        if (++pages > 4096) throw new Error("工具详情分页次数超出预算。");
        if (page[key]) {
          const bytes = decode(page[key]);
          const pageOffset = key === "contentJsonBase64" ? page.offset : page.inputOffset;
          if (pageOffset !== offset || !bytes.length) throw new Error("工具详情分页未前进。");
          chunks.push(bytes); offset = pageOffset + bytes.length;
          if (offset > total || offset > maxBytes) throw new Error("工具详情超出读取预算。");
        }
        if (offset < total) page = await fetchPage(key === "contentJsonBase64" ? offset : 0, key === "inputJsonBase64" ? offset : 0);
      }
      const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
      let cursor = 0; for (const chunk of chunks) { output.set(chunk, cursor); cursor += chunk.length; }
      return output;
    };
    const first = await fetchPage(0, 0);
    const [content, input] = await Promise.all([collect("contentJsonBase64", first), collect("inputJsonBase64", first)]);
    return { input: JSON.parse(new TextDecoder().decode(input)) as Record<string, unknown>,
      content: JSON.parse(new TextDecoder().decode(content)), is_error: first.is_error, pending: first.pending };
  },
  postComment(id: string, input: { requestId: string; body: string; employeeId?: string | null; sourceCommentId?: string | null }): Promise<{ comment: WandTaskComment; replayed: boolean }> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}/comments`, jsonBody(input));
  },
  update(
    id: string,
    patch: Partial<Pick<WandTask, "title" | "titleSource" | "description" | "status" | "priority" | "labels" | "dueDate" | "milestoneId" | "workspaceId" | "parentTaskId" | "sortOrder" | "agent" | "executionSubject" | "acceptance">>,
  ): Promise<WandTaskListed> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}`, jsonBody(patch, "PATCH"));
  },
  remove(id: string): Promise<void> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined);
  },
  /** 清空归档目录：永久删除归档卡片。省略 workspaceId 表示所有项目；服务端跳过仍在处理的会话。 */
  purgeArchived(workspaceId?: string | null): Promise<{ ok: boolean; deleted: number; skipped: number }> {
    return mutateTask(`/api/wand-tasks/archived${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
      { method: "DELETE" });
  },
  /** 用选定的 CLI 工具开一个结构化会话；prompt 作为这次派发的首条消息。 */
  dispatch(
    id: string,
    agent: WandTaskAgent | null,
    extra?: { prompt?: string; workspaceId?: string | null; subject?: TaskExecutionSubject; useEmployeeDefaults?: boolean },
  ): Promise<IssueDispatchResult> {
    const requestId = dispatchRequests.get(id) ?? crypto.randomUUID();
    dispatchRequests.set(id, requestId);
    return mutateTask<IssueDispatchResult>(`/api/wand-tasks/${encodeURIComponent(id)}/dispatch`, jsonBody({
      requestId,
      ...(agent ? { agent } : {}),
      ...(extra?.subject ? { subject: extra.subject } : {}),
      ...(extra?.useEmployeeDefaults ? { useEmployeeDefaults: true } : {}),
      ...(extra?.prompt != null ? { prompt: extra.prompt } : {}),
      ...(extra && "workspaceId" in extra ? { workspaceId: extra.workspaceId ?? null } : {}),
    })).then(result => { dispatchRequests.delete(id); return result; }).catch(error => {
      if (error instanceof HttpResponseError && error.status < 500 && ![408, 409].includes(error.status)) dispatchRequests.delete(id);
      throw error;
    });
  },
  moveSession(id: string, sessionId: string): Promise<WandTaskListed> {
    return mutateTask(`/api/wand-tasks/${encodeURIComponent(id)}/sessions`, jsonBody({ sessionId }));
  },
  /** 任务面板上次选用的 CLI 工具 / 模型 / 思考深度 / 工作模式。 */
  agentDefaults(): Promise<WandTaskAgent> {
    return requestJson("/api/wand-task-agent-defaults")
      .then((payload) => normalizeIssueAgentDefaults(payload))
      .catch(() => normalizeIssueAgentDefaults(null));
  },
  saveAgentDefaults(agent: WandTaskAgent): Promise<void> {
    const write = agentDefaultsWrite
      .catch(() => undefined)
      .then(async () => {
        await requestJson("/api/wand-task-agent-defaults", jsonBody(agent, "PUT"));
      });
    agentDefaultsWrite = write;
    return write;
  },
};

export type { IssueWorkspace };

/** Server verdict wins; status fallback keeps older servers safe. */
export function canArchiveBoardTask(task: WandTaskListed): boolean {
  return task.canArchive ?? task.status !== "doing";
}
