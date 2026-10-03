import * as React from "react";

import { EmployeeAvatar } from "../agents/employee-avatar";
import { getEmployeePresence } from "../agents/employee-presence";
import { newSessionController } from "../new-session/controller";
import { WandIcon, WandIconButton, WandStretchTabs } from "../ui";
import { classNames } from "../ui/class-names";
import { ImSidebarGroup } from "../shell/im-sidebar-group";
import { ImSidebarItem } from "../shell/im-sidebar-item";
import { SessionProviderMark, TeamChatSessionMark } from "./session-mark";
import { sidebarSessionLabel, workspaceSessionProvider } from "./session-order";
import { useSidebarCollapsed } from "./sidebar-disclosure";
import { formatTaskRecency } from "./sidebar-task-meta";
import type { SidebarDisplayMode } from "./sidebar-display-mode";
import {
  recentConversationGroups,
  type SidebarRecentEmployee,
  type SidebarRecentEntry,
  type SidebarRecentGroup,
} from "./sidebar-recent";
import type { WorkspaceSessionSummary } from "./types";

/**
 * 侧栏第一段「最近对话」：会话按员工 / 团队 / 终端归属分组（口径见 `sidebar-recent.ts`），
 * 与安卓首页一致——只有真有会话的归属才出现，头像与「+」都在一级行上，
 * 二级会话行不再重复员工身份。档位开关贴在这一行文字的右边（安卓「总档位」的位置）。
 */
export interface SidebarRecentSectionProps {
  entries: readonly SidebarRecentEntry[];
  employees: readonly SidebarRecentEmployee[];
  displayMode: SidebarDisplayMode;
  onSelectMode(mode: SidebarDisplayMode): void;
  liveTitles?: Readonly<Record<string, string>>;
  selectedSessionId: string | null;
  now: number;
  onOpen(entry: SidebarRecentEntry): void;
  /** 新建员工对话前先让调用方收起侧栏浮层（原生外壳下会关抽屉）。 */
  onStartConversation?(): void;
}

const FOLD_TABS: ReadonlyArray<{ value: SidebarDisplayMode; label: string }> = [
  { value: "full", label: "展开" },
  { value: "folded", label: "收起" },
  { value: "active", label: "在跑" },
];

export function SidebarRecentSection({
  entries,
  employees,
  displayMode,
  onSelectMode,
  liveTitles,
  selectedSessionId,
  now,
  onOpen,
  onStartConversation,
}: SidebarRecentSectionProps): React.ReactElement {
  const groups = React.useMemo(
    () => recentConversationGroups(entries, { employees }),
    [entries, employees],
  );
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const startConversation = React.useCallback((employeeId?: string): void => {
    setPickerOpen(false);
    onStartConversation?.();
    newSessionController.open(employeeId ? { initialEmployeeId: employeeId } : {});
  }, [onStartConversation]);
  // 收起路径：Esc 与再点触发点都能关掉联系人选择。
  React.useEffect(() => {
    if (!pickerOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPickerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pickerOpen]);

  return (
    <section className="sidebar-recent" aria-label="最近对话">
      <div className="sidebar-section-head">
        <h3 className="sidebar-section-title">最近对话</h3>
        <WandIconButton
          className={classNames("sidebar-section-add", pickerOpen && "is-open")}
          title={pickerOpen ? "收起联系人" : "新建员工对话"}
          aria-label={pickerOpen ? "收起联系人" : "新建员工对话"}
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((value) => !value)}
        >
          <WandIcon name={pickerOpen ? "close" : "plus"} size={14}/>
        </WandIconButton>
        <WandStretchTabs
          className="sidebar-fold-switch"
          ariaLabel="会话显示档位"
          tabs={FOLD_TABS.map((tab) => ({ value: tab.value, label: tab.label }))}
          value={displayMode}
          onValueChange={(value) => onSelectMode(value as SidebarDisplayMode)}
        />
      </div>
      <div className={classNames("sidebar-contact-picker", pickerOpen && "is-open")} inert={!pickerOpen}>
        <div className="sidebar-contact-picker-inner">
          <p className="sidebar-contact-picker-hint">点一位员工开始新对话</p>
          <div className="sidebar-contact-picker-list">
            {employees.map((employee) => (
              <button
                key={employee.id}
                type="button"
                className="sidebar-contact-picker-item"
                title={employee.duty || employee.name}
                onClick={() => startConversation(employee.id)}
              >
                <EmployeeAvatar employee={employee} size="sm"/>
                <span className="sidebar-contact-picker-name">{employee.name}</span>
                <span className="sidebar-contact-picker-duty">{employee.duty || "员工"}</span>
              </button>
            ))}
            {employees.length === 0 ? <p className="sidebar-section-empty">还没有硅基员工。</p> : null}
          </div>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="sidebar-section-empty">
          {displayMode === "active" ? "现在没有在跑或等你处理的会话。" : "还没有对话。"}
        </p>
      ) : (
        <div className="sidebar-recent-groups">
          {groups.map((group) => (
            <RecentConversationGroup
              key={group.key}
              group={group}
              employees={employees}
              displayMode={displayMode}
              liveTitles={liveTitles}
              selectedSessionId={selectedSessionId}
              now={now}
              onOpen={onOpen}
              onStartConversation={startConversation}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RecentConversationGroup({
  group,
  employees,
  displayMode,
  liveTitles,
  selectedSessionId,
  now,
  onOpen,
  onStartConversation,
}: {
  group: SidebarRecentGroup;
  employees: readonly SidebarRecentEmployee[];
  displayMode: SidebarDisplayMode;
  liveTitles?: Readonly<Record<string, string>>;
  selectedSessionId: string | null;
  now: number;
  onOpen(entry: SidebarRecentEntry): void;
  onStartConversation(employeeId?: string): void;
}): React.ReactElement {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed(`recent.${group.key}`, false);
  // 收起档下点一级行临时展开本组内容，再点恢复；不写全局档位（和任务行同一口径）。
  const [expandedInFolded, toggleExpandedInFolded] = useSidebarCollapsed(`recentFolded.${group.key}`, false);
  const open = displayMode === "folded"
    ? !collapsed && expandedInFolded
    : displayMode === "active"
      ? true
      : !collapsed;
  const toggleOpen = displayMode === "folded" ? toggleExpandedInFolded : toggleCollapsed;

  const rows = group.entries.map((entry, index) => (
    <ImSidebarItem
      key={entry.session.id}
      id={entry.session.id}
      title={sidebarSessionLabel(entry.session, index, liveTitles?.[entry.session.id])}
      // 一级行承载身份；组头已经在上面交代身份时，二级行只标这一条会话是哪个工具跑的。
      avatarNode={group.showsHeader
        ? <SecondaryRowMark entry={entry} group={group}/>
        : <GroupMark group={group} employees={employees}/>}
      presence={getEmployeePresence({
        hasSession: true,
        status: entry.session.status,
        inFlight: entry.session.inFlight,
      })}
      summary={entrySummary(entry, group, now)}
      active={selectedSessionId === entry.session.id}
      onClick={() => onOpen(entry)}
    />
  ));

  // 员工 / CLI 只有一条会话：一级行就是那张会话卡（头像仍在一级行上），不套空壳组头。
  if (!group.showsHeader) {
    return (
      <div className="sidebar-recent-flat">
        <div className="sidebar-recent-flat-main">{rows}</div>
        <GroupCreateButton group={group} onStartConversation={onStartConversation} flat/>
      </div>
    );
  }
  return (
    <ImSidebarGroup
      label={group.title}
      count={group.entries.length}
      hasAttention={group.activeCount > 0}
      avatarNode={<GroupMark group={group} employees={employees}/>}
      action={<GroupCreateButton group={group} onStartConversation={onStartConversation}/>}
      expanded={open}
      onToggle={toggleOpen}
    >
      {rows}
    </ImSidebarGroup>
  );
}

/** 一级行右侧的快捷新增：员工开新对话、终端建新终端；团队与 CLI 没有这一步（对齐安卓）。 */
function GroupCreateButton({
  group,
  onStartConversation,
  flat = false,
}: {
  group: SidebarRecentGroup;
  onStartConversation(employeeId?: string): void;
  flat?: boolean;
}): React.ReactElement | null {
  if (group.kind === "employee") {
    return (
      <WandIconButton
        className={classNames("sidebar-recent-add", flat && "is-flat")}
        title={`与${group.title}新建对话`}
        aria-label={`与${group.title}新建对话`}
        onClick={() => onStartConversation(group.employeeId ?? undefined)}
      >
        <WandIcon name="plus" size={14}/>
      </WandIconButton>
    );
  }
  if (group.kind === "blank-terminal" || group.kind === "terminal") {
    const blank = group.kind === "blank-terminal";
    return (
      <WandIconButton
        className={classNames("sidebar-recent-add", flat && "is-flat")}
        title={blank ? "新建空白终端" : "新建终端"}
        aria-label={blank ? "新建空白终端" : "新建终端"}
        onClick={() => {
          if (blank) newSessionController.open({ initialKind: "shell" });
          else newSessionController.open();
        }}
      >
        <WandIcon name="plus" size={14}/>
      </WandIconButton>
    );
  }
  return null;
}

function entrySummary(entry: SidebarRecentEntry, group: SidebarRecentGroup, now: number): string {
  const recency = formatTaskRecency(entry.session.startedAt ?? "", now);
  // 有组头时组名（也就是归属）已经写在一级行上，这里补上下文；单条会话的行要把归属自己带上。
  const parts = group.showsHeader
    ? [entry.taskName || entry.group.workspaceName, recency]
    : [group.title, recency];
  return parts.filter(Boolean).join(" · ");
}

/** 一级行的身份标记：员工头像 / 群聊猫 / 终端（沿用目录树里的 provider 标记）。 */
function GroupMark({
  group,
  employees,
}: {
  group: SidebarRecentGroup;
  employees: readonly SidebarRecentEmployee[];
}): React.ReactElement {
  const session = group.entries[0]?.session;
  if (group.kind === "employee") {
    // 员工改名 / 换头像后按当前定义显示，定义被删才退回会话快照。
    const employee = employees.find((candidate) => candidate.id === group.employeeId)
      ?? employeeSnapshot(session, group.title);
    return <EmployeeAvatar employee={employee} size="md"/>;
  }
  if (session?.teamChat) return <TeamChatSessionMark teamChat={session.teamChat}/>;
  if (group.kind === "team") return <WandIcon name="parallel" size={19}/>;
  if (session) return <SessionProviderMark session={session} size={18} className="sidebar-recent-provider"/>;
  return <WandIcon name="terminal" size={18} className="sidebar-recent-provider"/>;
}

/** 二级会话行：一级行已经交代身份，这里只说这一条会话是哪个工具跑的。 */
function SecondaryRowMark({
  entry,
  group,
}: {
  entry: SidebarRecentEntry;
  group: SidebarRecentGroup;
}): React.ReactElement {
  const session = entry.session;
  if (session.teamChat) return <TeamChatSessionMark teamChat={session.teamChat}/>;
  if (group.kind === "team") return <WandIcon name="parallel" size={17} className="sidebar-recent-provider"/>;
  return <SessionProviderMark session={session} size={16} className="sidebar-recent-provider"/>;
}

function employeeSnapshot(
  session: WorkspaceSessionSummary | undefined,
  fallbackName: string,
): { id: string; name: string; avatar: string } {
  return {
    id: session?.employeeId ?? "employee",
    name: fallbackName || session?.employeeName || "员工",
    avatar: session?.employeeAvatar ?? "",
  };
}
