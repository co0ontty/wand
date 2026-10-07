import { Flex, Menu, Skeleton, Typography } from "antd";
import { WandUiBoundary } from "../theme";
import * as React from "react";

import { SidebarEmployeeAvatar } from "./sidebar-employee-avatar";
import { newSessionController } from "../new-session/controller";
import { WandButton, WandIcon, WandIconButton } from "../ui";
import { classNames } from "../ui/class-names";
import { ImSidebarGroup } from "../shell/im-sidebar-group";
import { ImSidebarItem } from "../shell/im-sidebar-item";
import { SessionProviderMark, TeamChatSessionMark } from "./session-mark";
import { SidebarRowMenu } from "./sidebar-row-menu";
import { SessionMoveButton } from "./session-move-button";
import { confirmSessionDelete } from "./session-delete-confirm";
import { sidebarSessionLabel } from "./session-order";
import { SidebarDisclosure, useSidebarExpansion, anchorSidebarDisclosure } from "./sidebar-disclosure";
import { sidebarSessionState, sidebarAggregateState, sessionGlowStatus } from "./sidebar-session-state";
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
 * 只有真有会话的归属才出现，头像与「+」始终在固定一级行上；
 * 二级会话行只标实际工具。档位由公共展示控制行提供。
 */
export interface SidebarRecentSectionProps {
  entries: readonly SidebarRecentEntry[];
  employees: readonly SidebarRecentEmployee[];
  displayMode: SidebarDisplayMode;
  query?: string;
  disabled?: boolean;
  contactsLoading?: boolean;
  contactsError?: string | null;
  onReloadContacts?(): void;
  listLoading?: boolean;
  listError?: boolean;
  liveTitles?: Readonly<Record<string, string>>;
  selectedSessionId: string | null;
  now: number;
  onOpen(entry: SidebarRecentEntry): void;
  /** 新建员工对话前先让调用方收起侧栏浮层（原生外壳下会关抽屉）。 */
  onStartConversation?(): void;
  /** 与目录树同一批会话动作，右键 / 长按 / Shift+F10 打开；缺失时不提供菜单。 */
  onArchiveSession?(sessionId: string, archived: boolean): Promise<void>;
  onDeleteSession?(session: WorkspaceSessionSummary, label: string): Promise<void>;
}

export function SidebarRecentSection({
  entries,
  employees,
  displayMode,
  query = "",
  disabled = false,
  contactsLoading = false,
  contactsError = null,
  onReloadContacts,
  listLoading = false,
  listError = false,
  liveTitles,
  selectedSessionId,
  now,
  onOpen,
  onStartConversation,
  onArchiveSession,
  onDeleteSession,
}: SidebarRecentSectionProps): React.ReactElement {
  const groups = React.useMemo(
    () => recentConversationGroups(entries, { employees }),
    [entries, employees],
  );
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const pickerButton = React.useRef<HTMLButtonElement>(null);
  const pickerId = React.useId();
  React.useEffect(() => { setPickerOpen(false); }, [displayMode, disabled, query]);
  const cancelPicker = (): void => {
    pickerButton.current?.focus({ preventScroll: true });
    setPickerOpen(false);
  };
  const startConversation = React.useCallback((employeeId?: string): void => {
    setPickerOpen(false);
    onStartConversation?.();
    newSessionController.open(employeeId ? { initialEmployeeId: employeeId } : {});
  }, [onStartConversation]);

  return (
    <section className="sidebar-recent" aria-label="最近对话" onKeyDown={(event) => {
      if (event.key !== "Escape" || !pickerOpen || event.defaultPrevented
        || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      cancelPicker();
    }}>
      <Flex align="center" justify="space-between" gap="small" className="sidebar-section-head" style={{ paddingBlock: 8 }}>
        <Typography.Text strong className="sidebar-section-title">最近对话</Typography.Text>
        <WandIconButton
          ref={pickerButton}
          className={classNames("sidebar-section-add", pickerOpen && "is-open")}
          title={pickerOpen ? "收起联系人" : "新建员工对话"}
          aria-label={pickerOpen ? "收起联系人" : "新建员工对话"}
          aria-expanded={pickerOpen}
          aria-controls={pickerId}
          disabled={disabled}
          onClick={(event) => anchorSidebarDisclosure(event.currentTarget,
            () => pickerOpen ? cancelPicker() : setPickerOpen(true))}
        >
          <WandIcon name="plus" size={16} className="sidebar-plus-morph"/>
        </WandIconButton>

      </Flex>
      <SidebarDisclosure id={pickerId} open={pickerOpen}>
      <div className="sidebar-contact-picker">
        <div className="sidebar-contact-picker-inner">
          <p className="sidebar-contact-picker-hint">点一位员工开始新对话</p>
          <Flex vertical gap={4} className="sidebar-contact-picker-list">
            {employees.map((employee) => (
              <WandButton kind="ghost"
                key={employee.id}
                type="button"
                className="sidebar-contact-picker-item"
                style={{ height: "auto", width: "100%", minWidth: 0, justifyContent: "flex-start", whiteSpace: "normal", padding: 8 }}
                title={[employee.name, employee.duty].filter(Boolean).join(" · ")}
                onClick={() => startConversation(employee.id)}
              >
                <span className="sidebar-contact-avatar"><SidebarEmployeeAvatar employee={employee}/></span>
                <Typography.Text ellipsis className="sidebar-contact-picker-name" title={employee.name} style={{ flex: 1, textAlign: "start" }}>{employee.name}</Typography.Text>
                <Typography.Text ellipsis type="secondary" className="sidebar-contact-picker-duty" style={{ maxWidth: 100, fontSize: 12 }}>{employee.duty || "员工"}</Typography.Text>
              </WandButton>
            ))}
            {contactsLoading || contactsError ? (
              <div className="sidebar-contact-state" role={contactsError ? "alert" : "status"}
                aria-busy={contactsLoading}>
                <span>{contactsLoading ? "正在加载联系人…" : "联系人加载失败"}</span>
                <WandButton kind="ghost" type="button" disabled={contactsLoading} onClick={onReloadContacts}>重试</WandButton>
              </div>
            ) : employees.length === 0 ? (
              <p className="sidebar-contact-state">还没有硅基员工，可从AI团队管理。</p>
            ) : null}
          </Flex>
        </div>
      </div>
      </SidebarDisclosure>
      {listLoading && groups.length === 0 ? (
        <div role="status" aria-label="正在加载最近对话" aria-busy="true">
          <WandUiBoundary><Skeleton active title={false} paragraph={{ rows: 2 }}/></WandUiBoundary>
        </div>
      ) : groups.length === 0 && (listError || query.trim() || displayMode === "active") ? null : groups.length === 0 ? (
        <p className="sidebar-section-empty">
          {displayMode === "active" ? "现在没有在跑、待处理或刚完成的会话。" : "还没有对话，点＋选择员工开始。"}
        </p>
      ) : (
        <Flex vertical gap={4} className="sidebar-recent-groups">
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
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
              disabled={disabled}
            />
          ))}
        </Flex>
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
  onArchiveSession,
  onDeleteSession,
  disabled = false,
}: {
  group: SidebarRecentGroup;
  employees: readonly SidebarRecentEmployee[];
  displayMode: SidebarDisplayMode;
  liveTitles?: Readonly<Record<string, string>>;
  selectedSessionId: string | null;
  now: number;
  onOpen(entry: SidebarRecentEntry): void;
  onStartConversation(employeeId?: string): void;
  onArchiveSession?(sessionId: string, archived: boolean): Promise<void>;
  onDeleteSession?(session: WorkspaceSessionSummary, label: string): Promise<void>;
  disabled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useSidebarExpansion(`recent.${group.key}`);
  const [menuSessionId, setMenuSessionId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const activity = sidebarAggregateState(group.entries.map((entry) => entry.session));
  // 右键菜单与目录树是同一批动作；确认走公共对话框，不复制一套内联确认。
  const hasMenu = Boolean(onArchiveSession || onDeleteSession);
  const confirmDelete = async (session: WorkspaceSessionSummary, label: string): Promise<void> => {
    if (!await confirmSessionDelete(label)) return;
    setBusy(true);
    try {
      await onDeleteSession?.(session, label);
      setMenuSessionId(null);
    } finally {
      setBusy(false);
    }
  };

  const rows = group.entries.map((entry, index) => {
    const session = entry.session;
    const label = sidebarSessionLabel(session, index, liveTitles?.[session.id]);
    const archived = session.archived === true;
    const item = (
      <ImSidebarItem
        id={session.id}
        title={label}
        avatarNode={<SecondaryRowMark entry={entry} group={group}/>}
        state={sidebarSessionState(session)}
        glow={sessionGlowStatus(session)}
        summary={entrySummary(entry, group, now)}
        active={selectedSessionId === session.id}
        onClick={() => onOpen(entry)}
      />
    );
    if (!hasMenu) return <React.Fragment key={session.id}>{item}</React.Fragment>;
    return (
      <SidebarRowMenu
        key={session.id}
        row={<div className="sidebar-recent-row">{item}</div>}
        open={menuSessionId === session.id}
        disabled={disabled || busy}
        onOpenChange={(next) => setMenuSessionId(next ? session.id : null)}
        label={`会话 ${label} 的操作`}
        className="workspace-session-menu"
      >
        {!archived && (
          <SessionMoveButton menuItem sessionId={session.id} taskId={session.workspaceTaskId}
            intoNewTask={session.workspaceTaskId ? undefined : entry.group}
            onMoved={() => setMenuSessionId(null)}/>
        )}
        <Menu selectable={false} items={[
          ...(onArchiveSession ? [{
            key: "archive", disabled: busy, icon: <WandIcon name={archived ? "resume" : "archive"}/>,
            label: archived ? "恢复会话" : "归档会话",
          }] : []),
          ...(onDeleteSession ? [{
            key: "delete", disabled: busy, danger: true, icon: <WandIcon name="trash"/>,
            label: "删除会话…",
          }] : []),
        ]} onClick={({ key }) => {
          if (key === "archive") {
            void (async () => {
              setBusy(true);
              try {
                await onArchiveSession?.(session.id, !archived);
                setMenuSessionId(null);
              } finally {
                setBusy(false);
              }
            })();
          } else if (key === "delete") {
            // 同目录树：确认层打开时不再留着行菜单。
            setMenuSessionId(null);
            void confirmDelete(session, label);
          }
        }}/>
      </SidebarRowMenu>
    );
  });

  return (
    <ImSidebarGroup
      label={group.title}
      count={group.entries.length}
      description={activity.description}
      activity={activity}
      containsCurrent={group.entries.some((entry) => entry.session.id === selectedSessionId)}
      avatarNode={<GroupMark group={group} employees={employees}/>}
      action={<GroupCreateButton group={group} onStartConversation={onStartConversation}/>}
      expanded={open}
      onToggle={() => setOpen(!open)}
      onSetOpen={setOpen}
    >
      {rows}
    </ImSidebarGroup>
  );
}

/** 一级行右侧的快捷新增：员工开新对话、终端建新终端；团队与 CLI 没有这一步（对齐安卓）。 */
function GroupCreateButton({
  group,
  onStartConversation,
}: {
  group: SidebarRecentGroup;
  onStartConversation(employeeId?: string): void;
}): React.ReactElement | null {
  if (group.kind === "employee") {
    return (
      <WandIconButton
        className="sidebar-recent-add"
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
        className="sidebar-recent-add"
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
  const parts = [entry.taskName || entry.group.workspaceName, recency];
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
    return <SidebarEmployeeAvatar employee={employee}/>;
  }
  if (session?.teamChat) return <TeamChatSessionMark teamChat={session.teamChat}/>;
  if (group.kind === "team") return <WandIcon name="parallel" size={18}/>;
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
  if (group.kind === "team") return <WandIcon name="parallel" size={14} className="sidebar-recent-provider"/>;
  return <SessionProviderMark session={session} size={14} className="sidebar-recent-provider"/>;
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
