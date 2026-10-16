import * as React from "react";
import { newSessionController } from "../new-session/controller";
import { workspacesStore } from "./controller";
import { useUiDispatch, useUiStoreSnapshot } from "../shell/ui-store-react";
import { useTaskGroups } from "./task-groups-store";
import { listSessionLabel, withLiveSessionTitle } from "./session-order";
import { standaloneSessionTabScope } from "./standalone-session-tabs";
import { WorkspaceTabBarChrome } from "./workspace-tab-chrome";

/** Unbound sessions share the directory list; no task or persisted layout is created. */
export function StandaloneSessionTabBar(): React.ReactElement | null {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const { groups, loading, reload } = useTaskGroups();
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
  React.useEffect(() => {
    if (selected?.id && !(loading && groups.length === 0)
        && !groups.some(group => group.standaloneSessions.some(session => session.id === selected.id))) void reload();
  }, [selected?.id, reload]);
  const liveSessions = new Map(snapshot.sidebar.groups.flatMap(group => group.entries.map(session => [session.id, session] as const)));
  const scope = standaloneSessionTabScope(groups, selected, liveSessions);
  if (!scope || !selected) return null;
  const sessions = scope.sessions.map(session => {
    const live = liveSessions.get(session.id);
    return { ...withLiveSessionTitle(session, live?.title), status: live?.status ?? session.status };
  });
  const group = scope.group;
  return <WorkspaceTabBarChrome mobile={snapshot.viewport.mobile} variant="standalone" taskName=""
    activeWindowId={selected.id} closingWindowId={closingId}
    windows={sessions.map((session, index) => ({ id: session.id, label: listSessionLabel(session, index),
      status: session.status, count: 1, session }))}
    onSelectWindow={id => { if (id !== selected.id) void dispatch({ type: "session.select", id, focusInput: false }); }}
    onCloseWindow={id => {
      const rt = workspacesStore.getRuntime();
      const index = sessions.findIndex(session => session.id === id);
      if (!rt || closing.current || index < 0) return;
      closing.current = true;
      const attempt = { ownerId: selected.id, navigatedAway: false };
      closeAttempt.current = attempt;
      setClosingId(id);
      void (async () => {
        try {
          // Use the same confirmation, termination, deletion and refresh owner
          // as task windows. Cancellation/failure must leave the tab intact.
          if (!await rt.closeTaskSessions([id], "terminal")) return;
          const current = latestSnapshot.current;
          // A late deletion must not pull the user away from another session.
          if (!attempt.navigatedAway && selected.id === id && (!current.selected || current.selected.id === id)) {
            const live = new Map(current.sidebar.groups.flatMap(group => group.entries.map(session => [session.id, session] as const)));
            const candidates = [...sessions.slice(index + 1), ...sessions.slice(0, index).reverse()];
            const next = candidates.find(session => {
              const actual = live.get(session.id);
              return actual && !actual.archived && !actual.workspaceTaskId;
            });
            await dispatch(next ? { type: "session.select", id: next.id, focusInput: false } : { type: "nav.home" });
          }
          await reload();
        } catch (error) {
          rt.toast(error instanceof Error ? error.message : "关闭会话失败，请稍后重试。", "danger");
        } finally {
          closeAttempt.current = null;
          closing.current = false;
          setClosingId(null);
        }
      })();
    }}
    onNewSession={() => newSessionController.open({
      initialCwd: selected.cwd || group?.workspaceCwd,
      workspaceId: group ? !group.synthetic && !group.global ? group.workspaceId : undefined : selected.workspaceId,
    })}/>;
}
