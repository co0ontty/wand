/**
 * 首页要一眼看到、点进去能处理的报错。
 * 只收还没消化的失败：团队运行出错、会话 lastError / 失败、合并失败。
 * 等批准、步数用完、普通提问不算报错。
 */

export interface AttentionItem {
  id: string;
  title: string;
  detail: string;
  /** 点进去处理时打开的会话。没有会话时前端改去团队页。 */
  sessionId: string | null;
  updatedAt: string;
}

export interface AttentionSessionInput {
  id: string;
  title: string;
  archived?: boolean;
  status: string;
  lastError?: string | null;
  worktreeMergeStatus?: string | null;
  automationId?: string | null;
  updatedAt: string;
}

export interface AttentionTeamRunInput {
  id: string;
  status: string;
  statusDetail: string;
  taskTitle: string;
  teamName: string;
  chatSessionId: string | null;
  updatedAt: string;
}

const TEAM_ERROR = /出错|失败|耗尽|无法|不正确/;
const NOT_AN_ERROR = /步数上限/;
const ATTENTION_LIMIT = 20;

export function teamRunIdFromAutomation(automationId: string | null | undefined): string {
  if (!automationId) return "";
  if (automationId.startsWith("ai-team-chat:")) return automationId.slice("ai-team-chat:".length);
  if (automationId.startsWith("ai-team:")) return automationId.slice("ai-team:".length);
  return "";
}

/** 团队运行里值得在首页提示的报错。普通提问和步数上限不算。 */
export function teamRunErrorDetail(status: string, detail: string): string | null {
  const text = detail.trim();
  if (status === "failed") return text || "团队运行失败";
  if (status !== "waiting_user") return null;
  if (!text || NOT_AN_ERROR.test(text) || !TEAM_ERROR.test(text)) return null;
  return text;
}

export function sessionErrorDetail(session: AttentionSessionInput): string | null {
  if (session.archived || !session.id) return null;
  const lastError = session.lastError?.trim();
  if (lastError) return lastError;
  if (session.status === "failed") return "会话失败";
  if (session.worktreeMergeStatus === "failed") return "工作区合并失败";
  return null;
}

export function collectAttentionItems(input: {
  runs: readonly AttentionTeamRunInput[];
  sessions: readonly AttentionSessionInput[];
}): AttentionItem[] {
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  const coveredRunIds = new Set<string>();
  const push = (item: AttentionItem): void => {
    const key = `${item.sessionId ?? item.id}\0${item.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const run of input.runs) {
    const detail = teamRunErrorDetail(run.status, run.statusDetail);
    if (!detail) continue;
    coveredRunIds.add(run.id);
    const title = [run.teamName, run.taskTitle].filter(Boolean).join(" · ") || "团队运行";
    push({
      id: `team:${run.id}`,
      title,
      detail,
      sessionId: run.chatSessionId,
      updatedAt: run.updatedAt,
    });
  }

  for (const session of input.sessions) {
    const detail = sessionErrorDetail(session);
    if (!detail) continue;
    const runId = teamRunIdFromAutomation(session.automationId);
    if (runId && coveredRunIds.has(runId)) continue;
    const linked = runId ? runsById.get(runId) : undefined;
    push({
      id: `session:${session.id}`,
      title: session.title.trim() || "未命名会话",
      detail,
      sessionId: linked?.chatSessionId || session.id,
      updatedAt: session.updatedAt,
    });
  }

  return items
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, ATTENTION_LIMIT);
}
