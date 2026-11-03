import * as React from "react";
import { QuickTerminalChrome } from "../quick-terminal/action";
import { WorkbarActions, WorkbarLeading } from "../shell/workbar-actions";
import { newSessionController } from "../new-session/controller";
import { workspacesStore } from "./controller";
import { useUiDispatch, useUiStoreSnapshot } from "../shell/ui-store-react";
import { sidebarSessionLabel, withLiveSessionTitle } from "./session-order";
import { WorkspaceTabBarChrome } from "./workspace-tab-chrome";
import { useUnifiedSidebar } from "../conversations/unified-sidebar-model";

/** 顶部会话标签栏跟随侧边栏任务筛选逻辑：侧边栏显示多少，上面就显示多少。 */
export function StandaloneSessionTabBar({ fallback = null }: { fallback?: React.ReactElement | null } = {}): React.ReactElement | null {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const selected = snapshot.selected;
  const [closingId, setClosingId] = React.useState<string | null>(null);
  const closing = React.useRef(false);
  const closeAttempt = React.useRef<{ ownerId: string; navigatedAway: boolean } | null>(null);
  const pending = closeAttempt.current;
  if (pending && snapshot.selected?.id !== pending.ownerId
      && (snapshot.selected || snapshot.sidebar.groups.some(group => group.entries.some(session => session.id === pending.ownerId)))) {
    pending.navigatedAway = true;
  }
  const latestSnapshot = React.useRef(snapshot);
  latestSnapshot.current = snapshot;

  const liveSessions = React.useMemo(() => new Map(
    snapshot.sidebar.groups.flatMap(group => group.entries.map(session => [session.id, session] as const))
  ), [snapshot.sidebar.groups]);

  const sessionTitles = React.useMemo(() => Object.fromEntries(
    snapshot.sidebar.groups.flatMap(group => group.entries.map(entry => [entry.id, entry.title] as const))
  ), [snapshot.sidebar.groups]);

  const model = useUnifiedSidebar(true, sessionTitles);
  const orderedRows = model.orderedRows;

  if (orderedRows.length === 0) return fallback;

  const windows = orderedRows.map((entry, index) => {
    const session = entry.session;
    const live = liveSessions.get(session.id);
    const label = sidebarSessionLabel(session, model.entries.indexOf(entry), live?.title ?? sessionTitles[session.id]);
    return {
      id: session.id,
      label,
      status: live?.status ?? session.status,
      count: 1,
      session: { ...withLiveSessionTitle(session, live?.title), status: live?.status ?? session.status },
      titleGenerating: session.id === selected?.id && snapshot.topbar.titleGenerating,
    };
  });

  const currentEntry = orderedRows.find(entry => entry.session.id === selected?.id);
  const activeWindowId = currentEntry ? currentEntry.session.id : (selected?.id ?? null);

  return (
    <QuickTerminalChrome>
      <WorkspaceTabBarChrome
        mobile={snapshot.viewport.mobile}
        variant="standalone"
        taskName=""
        leading={<WorkbarLeading/>}
        actions={<WorkbarActions/>}
        activeWindowId={activeWindowId}
        closingWindowId={closingId}
        windows={windows}
        onSelectWindow={id => {
          if (id !== selected?.id) void dispatch({ type: "session.select", id, focusInput: false });
        }}
        onCloseWindow={id => {
          const rt = workspacesStore.getRuntime();
          const index = orderedRows.findIndex(entry => entry.session.id === id);
          if (!rt || closing.current || index < 0) return;
          closing.current = true;
          const attempt = { ownerId: selected?.id ?? "", navigatedAway: false };
          closeAttempt.current = attempt;
          setClosingId(id);
          void (async () => {
            try {
              if (!await rt.closeTaskSessions([id], "terminal")) return;
              const current = latestSnapshot.current;
              if (!attempt.navigatedAway && selected?.id === id && (!current.selected || current.selected.id === id)) {
                const live = new Map(current.sidebar.groups.flatMap(group => group.entries.map(session => [session.id, session] as const)));
                const candidates = [...orderedRows.slice(index + 1), ...orderedRows.slice(0, index).reverse()];
                const next = candidates.find(candidate => {
                  const actual = live.get(candidate.session.id);
                  return actual && !actual.archived;
                });
                await dispatch(next ? { type: "session.select", id: next.session.id, focusInput: false } : { type: "nav.home" });
              }
              model.refresh();
            } catch (error) {
              rt.toast(error instanceof Error ? error.message : "关闭会话失败，请稍后重试。", "danger");
            } finally {
              closeAttempt.current = null;
              closing.current = false;
              setClosingId(null);
            }
          })();
        }}
        onNewSession={kind => {
          const group = currentEntry?.group
            ?? model.groups.find(g => `id:${g.workspaceId}` === model.facets.workspace && !g.synthetic && !g.global)
            ?? (selected?.workspaceId ? model.groups.find(g => g.workspaceId === selected.workspaceId) : undefined);
          newSessionController.open({
            initialKind: kind,
            initialCwd: selected?.cwd || group?.workspaceCwd,
            workspaceId: group ? (!group.synthetic && !group.global ? group.workspaceId : undefined) : selected?.workspaceId,
          });
        }}
      />
    </QuickTerminalChrome>
  );
}
