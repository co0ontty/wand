import { isSessionActive } from "./sidebar-display-mode";
import { workspaceProviderLabel } from "./session-order";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "./types";

/**
 * 侧栏「最近对话」的分组规则，与安卓首页同一套口径（`TaskListPresentation.kt`）：
 * 会话的一级归属是「员工 → 团队 → PTY 终端 → 空白终端 → 其它 CLI」，
 * key 只由会话自带的身份决定，员工改名 / 团队重开都不会让分组漂移。
 */
export type SidebarRecentKind = "employee" | "team" | "terminal" | "blank-terminal" | "cli";

export interface SidebarRecentEntry {
  readonly group: TaskDirectoryGroup;
  readonly taskName: string | null;
  readonly session: WorkspaceSessionSummary;
}

export interface SidebarRecentGroup {
  readonly key: string;
  readonly kind: SidebarRecentKind;
  readonly title: string;
  /** 员工分组才有：一级行头像与「新建对话」都按它取当前定义。 */
  readonly employeeId: string | null;
  readonly entries: readonly SidebarRecentEntry[];
  readonly latestStartedAt: string;
  readonly activeCount: number;
  /** 所有非空归属都保留一级身份头，数量/筛选不改变结构。 */
  readonly showsHeader: boolean;
}

export interface SidebarRecentEmployee {
  readonly id: string;
  readonly name: string;
  readonly duty?: string;
  /** 当前定义的头像与候选 CLI：展示按当前定义投影，定义没了才退回会话快照。 */
  readonly avatar?: string;
  readonly agents?: ReadonlyArray<{ provider?: string }>;
}

/** 员工 / 团队看最近窗口，终端不受窗口截断（对齐安卓首页）。 */
export const RECENT_CONVERSATION_LIMIT = 8;

const TERMINAL_GROUP_ORDER: readonly SidebarRecentKind[] = ["terminal", "blank-terminal"];

export function recentSessionIdentity(
  session: WorkspaceSessionSummary,
): { key: string; kind: SidebarRecentKind } {
  if (session.employeeId) return { key: `employee:${session.employeeId}`, kind: "employee" };
  // 团队一级只放群聊：同一团队的多次开工合成一行（缺 teamId 的旧数据退回 runId）。
  if (session.teamChat) {
    const teamId = session.teamChat.teamId || session.teamChat.runId;
    return { key: `team:${teamId}`, kind: "team" };
  }
  // 没有员工身份的派发步骤也不能丢，按一次运行归到团队。
  if (session.teamStep) return { key: `team-run:${session.teamStep.runId}`, kind: "team" };
  // provider 在服务端 DTO 上是 provider 联合；空白终端实际给空串（历史上也有 "shell"），
  // 所以这里按字符串比对，有真实 CLI 的才算 PTY 终端。
  const provider = String(session.provider ?? "");
  if (session.sessionKind === "pty" && provider && provider !== "shell") {
    return { key: "terminal", kind: "terminal" };
  }
  if (session.sessionKind === "pty") return { key: "blank-terminal", kind: "blank-terminal" };
  // 结构化会话理论上都有员工或团队归属；真遇到没有的也不能丢，按 CLI 单列一行。
  return { key: `cli:${provider}`, kind: "cli" };
}

function startedAtOf(session: WorkspaceSessionSummary): string {
  return session.startedAt ?? "";
}

function recencyOf(session: WorkspaceSessionSummary): number {
  const parsed = Date.parse(startedAtOf(session));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 「最近」的唯一排序：新的在前，时间相同用 id 保证稳定。 */
export function compareRecentEntries(left: SidebarRecentEntry, right: SidebarRecentEntry): number {
  const delta = recencyOf(right.session) - recencyOf(left.session);
  if (delta) return delta;
  return left.session.id.localeCompare(right.session.id);
}

/** 目录树里的全部会话（不含归档）拍平成最近列表的输入，顺序交给 compareRecentEntries。 */
export function collectRecentEntries(
  groups: readonly TaskDirectoryGroup[],
): SidebarRecentEntry[] {
  const entries: SidebarRecentEntry[] = [];
  const seen = new Set<string>();
  const push = (group: TaskDirectoryGroup, session: WorkspaceSessionSummary, taskName: string | null): void => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    entries.push({ group, taskName, session });
  };
  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) push(group, session, task.name);
    }
    for (const session of group.standaloneSessions) push(group, session, null);
  }
  return entries.sort(compareRecentEntries);
}

function groupTitle(
  kind: SidebarRecentKind,
  entries: readonly SidebarRecentEntry[],
  employees: readonly SidebarRecentEmployee[],
): string {
  const head = entries[0];
  if (!head) return "会话";
  const session = head.session;
  switch (kind) {
    case "employee": {
      const employee = employees.find((candidate) => candidate.id === session.employeeId);
      // 员工改名 / 换头像后展示当前定义，定义没了才退回会话快照。
      return employee?.name?.trim() || session.employeeName?.trim() || "员工";
    }
    case "team": {
      for (const entry of entries) {
        const name = entry.session.teamChat?.teamName?.trim() || entry.session.teamStep?.teamName?.trim();
        if (name) return name;
      }
      return "AI 团队";
    }
    case "terminal": return "PTY 终端";
    case "blank-terminal": return "空白终端";
    default: return workspaceProviderLabel(session.provider);
  }
}

/** 一级分组：员工 / 团队 / PTY 终端 / 空白终端 / 其它 CLI；终端排在最后且顺序固定。 */
export function recentConversationGroups(
  entries: readonly SidebarRecentEntry[],
  options: { employees?: readonly SidebarRecentEmployee[]; limit?: number } = {},
): SidebarRecentGroup[] {
  const employees = options.employees ?? [];
  const limit = Math.max(0, options.limit ?? RECENT_CONVERSATION_LIMIT);
  const ordered = [...entries].sort(compareRecentEntries);
  const buckets = new Map<string, { kind: SidebarRecentKind; entries: SidebarRecentEntry[] }>();
  const push = (entry: SidebarRecentEntry): void => {
    const { key, kind } = recentSessionIdentity(entry.session);
    const bucket = buckets.get(key);
    if (bucket) bucket.entries.push(entry);
    else buckets.set(key, { kind, entries: [entry] });
  };
  // 员工 / 团队 / CLI 只看最近窗口，终端不受窗口截断，避免旧终端被「最近 N 条」提前丢掉。
  const recent = ordered.filter((entry) => !isTerminalEntry(entry));
  const terminals = ordered.filter(isTerminalEntry);
  for (const entry of recent.slice(0, limit)) push(entry);
  for (const entry of terminals) push(entry);

  const groups: SidebarRecentGroup[] = [...buckets.entries()].map(([key, bucket]) => {
    const sorted = [...bucket.entries].sort(compareRecentEntries);
    return {
      key,
      kind: bucket.kind,
      title: groupTitle(bucket.kind, sorted, employees),
      employeeId: bucket.kind === "employee" ? sorted[0].session.employeeId ?? null : null,
      entries: sorted,
      latestStartedAt: startedAtOf(sorted[0].session),
      activeCount: sorted.filter((entry) => isSessionActive(entry.session)).length,
      showsHeader: true,
    };
  });

  const byRecency = groups
    .filter((group) => !TERMINAL_GROUP_ORDER.includes(group.kind))
    .sort((left, right) => {
      const delta = Date.parse(right.latestStartedAt || "") - Date.parse(left.latestStartedAt || "");
      if (delta) return delta;
      return left.key.localeCompare(right.key);
    });
  const terminalGroups = TERMINAL_GROUP_ORDER
    .map((kind) => groups.find((group) => group.kind === kind))
    .filter((group): group is SidebarRecentGroup => Boolean(group));
  return [...byRecency, ...terminalGroups];
}

function isTerminalEntry(entry: SidebarRecentEntry): boolean {
  const kind = recentSessionIdentity(entry.session).kind;
  return kind === "terminal" || kind === "blank-terminal";
}

/** 搜索文案：会话标题、任务名、目录名、员工与团队名都算命中。 */
export function recentEntrySearchText(
  entry: SidebarRecentEntry,
  employees: readonly SidebarRecentEmployee[],
): string {
  const session = entry.session;
  const employee = employees.find((candidate) => candidate.id === session.employeeId);
  return [
    session.title,
    entry.taskName,
    entry.group.workspaceName,
    employee?.name,
    session.employeeName,
    session.teamChat?.teamName,
    session.teamStep?.teamName,
    session.teamStep?.memberName,
  ].filter(Boolean).join(" ").toLowerCase();
}

export interface RecentEntryFilter {
  readonly query?: string;
  readonly employees?: readonly SidebarRecentEmployee[];
  /** 「在跑」档只留在动会话；正在看的那条始终保留。 */
  readonly activeOnly?: boolean;
  readonly selectedSessionId?: string | null;
}

export function filterRecentEntries(
  entries: readonly SidebarRecentEntry[],
  filter: RecentEntryFilter = {},
): SidebarRecentEntry[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const employees = filter.employees ?? [];
  return entries.filter((entry) => {
    if (query && !recentEntrySearchText(entry, employees).includes(query)) return false;
    if (!filter.activeOnly) return true;
    return isSessionActive(entry.session) || entry.session.id === filter.selectedSessionId;
  });
}
