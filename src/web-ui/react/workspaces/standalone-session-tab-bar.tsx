import * as React from "react";
import { newSessionController } from "../new-session/controller";
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
    activeWindowId={selected.id}
    windows={sessions.map((session, index) => ({ id: session.id, label: listSessionLabel(session, index),
      status: session.status, count: 1, session }))}
    onSelectWindow={id => { if (id !== selected.id) void dispatch({ type: "session.select", id, focusInput: false }); }}
    onNewSession={() => newSessionController.open({
      initialCwd: selected.cwd || group?.workspaceCwd,
      workspaceId: group ? !group.synthetic && !group.global ? group.workspaceId : undefined : selected.workspaceId,
    })}/>;
}
