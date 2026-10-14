import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CONVERSATION_OWNER, type ConversationInstance, type ConversationRequest } from "../conversation-types.js";
import { nowIso } from "../password-manager.js";
import type { WandTask } from "../task-types.js";
import { ConversationTurn, type SessionSnapshot } from "../types.js";
import type { WandStorage } from "../storage.js";
import { CreateWandTaskInput } from "./internal.js";

/** Conversation storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class ConversationRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  conversationListState(id: string): { pinnedAt: string | null; dissolvedAt: string | null; dissolvedBy: string | null; deleting: boolean } {
    const row = this.db.prepare("SELECT pinned_at, dissolved_at, dissolved_by, deleting FROM conversation_list_state WHERE conversation_id = ?")
      .get(id) as { pinned_at: string | null; dissolved_at: string | null; dissolved_by: string | null; deleting: number } | undefined;
    return { pinnedAt: row?.pinned_at ?? null, dissolvedAt: row?.dissolved_at ?? null, dissolvedBy: row?.dissolved_by ?? null, deleting: !!row?.deleting };
  }

  /** Separate from channel snapshots, so late run saves cannot overwrite lifecycle state. */
  updateConversationListState(id: string, patch: { pinned?: boolean; dissolved?: boolean; deleting?: boolean; dissolvedBy?: string }): void {
    this.s.transaction(() => {
      const previous = this.conversationListState(id);
      const pinnedAt = patch.pinned === false ? null : patch.pinned === true ? previous.pinnedAt ?? nowIso() : previous.pinnedAt;
      const dissolvedAt = patch.dissolved === true ? previous.dissolvedAt ?? nowIso() : patch.dissolved === false ? null : previous.dissolvedAt;
      // 解散人是当时那一版署名，保留真实归属；只有没传资料时才回落到默认的「我」。
      const dissolvedBy = dissolvedAt ? previous.dissolvedBy ?? patch.dissolvedBy ?? "我" : null;
      this.db.prepare(`INSERT INTO conversation_list_state(conversation_id, pinned_at, dissolved_at, dissolved_by, deleting) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET pinned_at = excluded.pinned_at, dissolved_at = excluded.dissolved_at, dissolved_by = excluded.dissolved_by, deleting = excluded.deleting`)
        .run(id, pinnedAt, dissolvedAt, dissolvedBy, Number(patch.deleting ?? previous.deleting));
    });
  }

  deleteConversation(id: string): void {
    this.s.transaction(() => {
      this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversation_tasks WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ? AND owner = ?").run(id, CONVERSATION_OWNER);
      this.db.prepare("DELETE FROM conversation_list_state WHERE conversation_id = ?").run(id);
      // Keep the content-free request ledger: retrying an old accepted request must never recreate deleted work.
    });
  }

  listConversations(): ConversationInstance[] {
    return (this.db.prepare("SELECT instance_json FROM conversations WHERE owner = ?").all(CONVERSATION_OWNER) as Array<{ instance_json: string }>)
      .map((row) => JSON.parse(row.instance_json) as ConversationInstance);
  }

  getConversation(id: string): ConversationInstance | null {
    const row = this.db.prepare("SELECT instance_json FROM conversations WHERE id = ? AND owner = ?")
      .get(id, CONVERSATION_OWNER) as { instance_json: string } | undefined;
    return row ? JSON.parse(row.instance_json) as ConversationInstance : null;
  }

  getConversationBySession(sessionId: string): ConversationInstance | null {
    const row = this.db.prepare("SELECT instance_json FROM conversations WHERE session_id = ? AND owner = ?")
      .get(sessionId, CONVERSATION_OWNER) as { instance_json: string } | undefined;
    return row ? JSON.parse(row.instance_json) as ConversationInstance : null;
  }

  saveConversation(instance: ConversationInstance): void {
    this.db.prepare(`INSERT INTO conversations(id, owner, kind, peer_employee_id, session_id, instance_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id, instance_json = excluded.instance_json`)
      .run(instance.id, instance.owner, instance.kind, instance.peerEmployeeId, instance.sessionId, JSON.stringify(instance));
  }

  conversationTasks(id: string): Array<{ taskId: string; linkedAt: string }> {
    return (this.db.prepare("SELECT task_id, linked_at FROM conversation_tasks WHERE conversation_id = ? ORDER BY linked_at, rowid")
      .all(id) as Array<{ task_id: string; linked_at: string }>).map((row) => ({ taskId: row.task_id, linkedAt: row.linked_at }));
  }

  linkConversationTask(conversationId: string, taskId: string, linkedAt: string): void {
    this.db.prepare("INSERT OR IGNORE INTO conversation_tasks(conversation_id, task_id, linked_at) VALUES (?, ?, ?)")
      .run(conversationId, taskId, linkedAt);
  }

  /** One canonical task/workspace/instance association commit, before any model input. */
  createConversationTask(instance: ConversationInstance, input: CreateWandTaskInput, accept?: (task: WandTask) => void): WandTask {
    return this.s.transaction(() => {
      const workspace = input.workspaceId ? this.s.getWorkspace(input.workspaceId) : null;
      if (!workspace || workspace.kind === "global") throw new Error("请选择非全局工作项目。");
      const milestoneId = this.s.taskMilestoneForWrite(input.milestoneId, workspace.id);
      const workspaceTaskId = this.s.insertWorkspaceTask({ workspaceId: workspace.id, name: input.title, milestoneId });
      const task = this.s.insertWandTask({ ...input, workspaceId: workspace.id, workspaceTaskId, milestoneId });
      this.s.saveConversation(instance);
      this.s.linkConversationTask(instance.id, task.id, task.createdAt);
      accept?.(task);
      return task;
    });
  }

  /** Commit the first accepted fact, identifiers and DM link together, before any execution I/O. */
  acceptConversationDispatch(instance: ConversationInstance, input: CreateWandTaskInput | { continueTaskId: string },
    request: ConversationRequest, source?: ConversationInstance): WandTask {
    const accept = (task: WandTask): WandTask => {
      this.s.saveConversation(instance);
      this.s.linkConversationTask(instance.id, task.id, task.createdAt);
      request.receipt = { ...request.receipt, state: "accepted", conversationId: instance.id, taskId: task.id, startup: "pending" };
      if (source) {
        source.createdAt ||= nowIso(); source.updatedAt = nowIso();
        this.s.saveConversation(source);
        this.s.appendConversationEvent(source.id, { role: "user", messageId: request.id, requestId: request.id,
          conversationTarget: null, content: [{ type: "text", text: "description" in input ? input.description ?? task.description : task.description }] });
        request.receipt.messageId = request.id;
        const employee = source.peerEmployeeId ? this.s.getSiliconEmployee(source.peerEmployeeId) : null;
        this.s.appendConversationEvent(source.id, { role: "assistant", notice: true,
          author: { id: source.peerEmployeeId ?? source.id, name: employee?.name ?? source.name, avatar: employee?.avatar },
          messageId: `${request.id}:task-link`, requestId: request.id,
          conversationLink: { conversationId: instance.id, taskId: task.id, title: task.title },
          content: [{ type: "text", text: `我正在处理「${task.title}」，进展在任务群实时同步。` }] });
      }
      this.s.saveConversationRequest({ ...request, updatedAt: nowIso() });
      return task;
    };
    if (!("continueTaskId" in input)) return this.createConversationTask(instance, input, accept);
    return this.s.transaction(() => {
      const task = this.s.getWandTask(input.continueTaskId);
      if (!task) throw new Error("任务不存在。");
      return accept(task);
    });
  }

  /** Message + reply + exact session association + receipt are committed before any model input. */
  acceptConversationSession(instance: ConversationInstance, createSession: () => string, title: string, input: string,
    request: ConversationRequest): void {
    this.s.transaction(() => {
      const sessionId = createSession();
      instance.createdAt ||= nowIso(); instance.updatedAt = nowIso();
      this.s.saveConversation(instance);
      this.s.appendConversationEvent(instance.id, { role: "user", messageId: request.id, requestId: request.id,
        conversationTarget: null, content: [{ type: "text", text: input }] });
      const employee = instance.peerEmployeeId ? this.s.getSiliconEmployee(instance.peerEmployeeId) : null;
      this.s.appendConversationEvent(instance.id, { role: "assistant", messageId: `${request.id}:session`, requestId: request.id,
        author: { id: instance.peerEmployeeId ?? instance.id, name: employee?.name ?? instance.name, avatar: employee?.avatar },
        sessionLink: { sessionId, title }, content: [] });
      this.s.saveConversationRequest({ ...request, updatedAt: nowIso(), receipt: { ...request.receipt,
        state: "accepted", conversationId: instance.id, sessionId, messageId: request.id, startup: "pending" } });
    });
  }

  /** Attach an independent interactive session, without copying its transcript or executing it. */
  linkEmployeeSession(instance: ConversationInstance, session: SessionSnapshot): void {
    const messageId = `employee-session:${session.id}`;
    const title = session.title?.trim() || "工作区会话";
    const previous = this.db.prepare("SELECT conversation_id, turn_json FROM conversation_messages WHERE id = ?")
      .get(messageId) as { conversation_id: string; turn_json: string } | undefined;
    if (previous?.conversation_id === instance.id
      && (JSON.parse(previous.turn_json) as ConversationTurn).sessionLink?.title === title) return;
    this.s.transaction(() => {
      // An explicit employee change is allowed only before the first input. Never move historical work.
      if (previous && previous.conversation_id !== instance.id) {
        if (this.s.lastSessionTurn(session.id)) return;
        this.db.prepare("DELETE FROM conversation_messages WHERE id = ?").run(messageId);
        const old = this.s.getConversation(previous.conversation_id);
        if (old?.kind === "dm" && !old.sessionId && !old.communicationSessionId && !old.historySessionIds?.length
          && !this.s.lastConversationEvent(old.id) && !this.s.conversationTasks(old.id).length
          && !this.s.conversationListState(old.id).pinnedAt) this.s.deleteConversation(old.id);
      }
      instance.createdAt ||= session.startedAt;
      instance.updatedAt = [instance.updatedAt, session.startedAt, session.endedAt ?? ""].sort().at(-1)!;
      this.s.saveConversation(instance);
      const employee = instance.peerEmployeeId ? this.s.getSiliconEmployee(instance.peerEmployeeId) : null;
      const turn: ConversationTurn = { role: "assistant", messageId, conversationId: instance.id,
        createdAt: session.startedAt,
        author: { id: instance.peerEmployeeId!, name: session.employeeName ?? employee?.name ?? instance.name,
          avatar: session.employeeAvatar ?? employee?.avatar },
        sessionLink: { sessionId: session.id, title }, content: [] };
      this.db.prepare(`INSERT INTO conversation_messages(id, conversation_id, turn_json, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET turn_json = excluded.turn_json`)
        .run(messageId, instance.id, JSON.stringify(turn), session.startedAt);
    });
  }

  employeeConversationForSession(sessionId: string): string | null {
    const row = this.db.prepare("SELECT conversation_id FROM conversation_messages WHERE id = ?")
      .get(`employee-session:${sessionId}`) as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
  }

  conversationSessionIds(id: string): string[] {
    const rows = this.db.prepare(`SELECT json_extract(turn_json, '$.sessionLink.sessionId') AS session_id
      FROM conversation_messages WHERE conversation_id = ? AND json_extract(turn_json, '$.sessionLink.sessionId') IS NOT NULL`)
      .all(id) as Array<{ session_id: string }>;
    return [...new Set(rows.map(row => row.session_id))];
  }

  conversationTaskStartup(taskId: string): ConversationRequest["receipt"] | null {
    const row = this.db.prepare(`SELECT receipt_json FROM conversation_requests
      WHERE json_extract(receipt_json, '$.taskId') = ? AND json_extract(receipt_json, '$.startup') IS NOT NULL
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(taskId) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as ConversationRequest["receipt"] : null;
  }

  appendConversationEvent(id: string, turn: ConversationTurn): void {
    const createdAt = turn.createdAt ?? nowIso();
    const messageId = turn.messageId ?? crypto.randomUUID();
    this.db.prepare("INSERT INTO conversation_messages(id, conversation_id, turn_json, created_at) VALUES (?, ?, ?, ?)")
      .run(messageId, id, JSON.stringify({ ...turn, messageId, conversationId: id, createdAt }), createdAt);
  }

  conversationEvents(id: string): ConversationTurn[] {
    return (this.db.prepare("SELECT turn_json FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid")
      .all(id) as Array<{ turn_json: string }>).map((row) => JSON.parse(row.turn_json) as ConversationTurn);
  }

  /** List preview only needs the newest event, not the whole transcript. */
  lastConversationEvent(id: string): ConversationTurn | null {
    const row = this.db.prepare(`SELECT turn_json FROM conversation_messages
      WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(id) as { turn_json: string } | undefined;
    return row ? JSON.parse(row.turn_json) as ConversationTurn : null;
  }

  /**
   * One turn from the persisted JSON array. Avoids materializing the transcript in the list path.
   * Append-only sessions keep the comparator-max at the tail; role walks backward from that tail.
   */
  lastSessionTurn(id: string, role?: "user" | "assistant"): ConversationTurn | null {
    const row = this.db.prepare("SELECT json_array_length(messages) AS length FROM command_sessions WHERE id = ?")
      .get(id) as { length: number | null } | undefined;
    const length = row?.length ?? 0;
    if (!length) return null;
    const read = this.db.prepare("SELECT json_extract(messages, ?) AS turn FROM command_sessions WHERE id = ?");
    for (let index = length - 1; index >= 0; index -= 1) {
      const item = read.get(`$[${index}]`, id) as { turn: string | null } | undefined;
      if (!item?.turn) continue;
      const turn = JSON.parse(item.turn) as ConversationTurn;
      if (!role || turn.role === role) return turn;
    }
    return null;
  }

  getConversationRequest(id: string): ConversationRequest | null {
    const row = this.db.prepare("SELECT * FROM conversation_requests WHERE id = ?").get(id) as
      { id: string; fingerprint: string; receipt_json: string; updated_at: string } | undefined;
    return row ? { id: row.id, fingerprint: row.fingerprint, receipt: JSON.parse(row.receipt_json), updatedAt: row.updated_at } : null;
  }

  saveConversationRequest(request: ConversationRequest): void {
    this.db.prepare(`INSERT INTO conversation_requests(id, fingerprint, receipt_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET receipt_json = excluded.receipt_json, updated_at = excluded.updated_at`)
      .run(request.id, request.fingerprint, JSON.stringify(request.receipt), request.updatedAt);
  }
}
