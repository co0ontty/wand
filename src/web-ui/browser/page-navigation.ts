import { hasPageRoute, pageSearch, subscribePageRoute, updatePageRoute, workspaceSessionHistoryMode } from "../page-route";
import { reportPageRouteFailure } from "../react/page-route-notice";
import { workspacesStore } from "../react/workspaces/controller";
import { httpWorkspacesRepository } from "../react/workspaces/repository";
import { setActiveWorkspaceContext, workspaceContextStore } from "../react/workspaces/workspace-context";
import { activeWorkWindowTab, layoutSessionIds } from "../react/workspaces/window-layout";
import { findLayoutTab } from "../react/workspaces/layout-tree";
import { configurePageRestore, configurePageSelection, withoutPageSelection } from "./page-selection";
import { goHome, selectSession } from "./session-engine";
import { state } from "./state";
import { conversationUi } from "../react/conversations/state";

let installed = false;
let ready = false;
let restoring = 0;
let generation = 0;
let scheduled = false;
let writing = false;
let lastTarget = "";
function targetKey(): string {
  const params = new URLSearchParams(pageSearch());
  return JSON.stringify(["view", "session", "workspace", "workspaceTask", "window", "tab"].map(key => params.get(key)));
}

function syncSelection(mode: "push" | "replace" = "push", userIntent = false): void {
  if (!ready || (restoring && !userIntent) || scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (!ready || (restoring && !userIntent)) return;
    const context = workspaceContextStore.getSnapshot();
    const window = context.layout?.windows.find(item => item.id === context.layout?.activeWindowId);
    const params = new URLSearchParams(pageSearch());
    writing = true;
    const historyMode = mode === "push"
      ? workspaceSessionHistoryMode(pageSearch(), state.selectedId || null)
      : mode;
    updatePageRoute({
      ...(!params.has("view") ? { view: "workspace" } : {}),
      session: state.selectedId || null,
      workspace: context.workspaceId,
      workspaceTask: context.taskId,
      window: window?.id ?? null,
      tab: window?.activeTabId ?? null,
    }, historyMode);
    writing = false;
    lastTarget = targetKey();
  });
}

/** Called only after authentication and the authoritative session list have loaded. */
export async function restorePageNavigation(): Promise<boolean> {
  if (!hasPageRoute()) {
    ready = true;
    const ui = conversationUi.getSnapshot();
    if (ui.active === true || ui.directory) {
      updatePageRoute({ view: ui.directory ? "contacts" : "chats", sidebar: ui.mode,
        conversation: ui.selectedId, chatFilter: ui.listFilter, chatActivity: String(ui.activityOnly),
        chatQuery: ui.filters["list-query"] ?? "" }, "replace");
      lastTarget = targetKey();
    } else syncSelection("replace");
    return false;
  }
  const epoch = ++generation;
  const requestedKey = targetKey();
  lastTarget = requestedKey;
  const params = new URLSearchParams(pageSearch());
  const runtime = workspacesStore.getRuntime();
  if (!runtime) return true;
  restoring++;
  reportPageRouteFailure("");
  const current = (): boolean => epoch === generation && targetKey() === requestedKey;
  try {
    const sessionId = params.get("session");
    const workspaceId = params.get("workspace");
    const windowId = params.get("window");
    const tabId = params.get("tab");
    const session = sessionId ? state.sessions.find(item => item.id === sessionId) : null;
    if (sessionId && !session) throw new Error("链接中的会话不存在、已删除或无权访问。");
    const taskId = params.get("workspaceTask") || session?.workspaceTaskId;
    if ((windowId || tabId) && !taskId) throw new Error("窗口链接缺少所属任务，请返回工作区重新选择。");
    if (taskId) {
      const detail = await httpWorkspacesRepository.getTask(taskId);
      if (!current()) return true;
      if (workspaceId && detail.workspaceId !== workspaceId) throw new Error("链接中的任务不属于指定工作区。");
      if (session && session.workspaceTaskId !== taskId) throw new Error("链接中的会话不属于指定任务。");
      await runtime.openTask({ workspaceId: detail.workspaceId, workspaceName: "", taskId: detail.id,
        taskName: detail.name, cwd: detail.cwd, preferredSessionId: sessionId || undefined, restoreRoute: true, navigationCurrent: current });
      if (!current()) return true;
      let layout = workspaceContextStore.getSnapshot().layout;
      if (layout && windowId) {
        const window = layout.windows.find(item => item.id === windowId);
        if (!window) throw new Error("链接中的窗口已关闭或不存在。");
        if (tabId && !findLayoutTab(window.layout, tabId)) throw new Error("链接中的窗格已关闭或不存在。");
        if (sessionId && !layoutSessionIds(window.layout).includes(sessionId)) throw new Error("链接中的会话不在指定窗口内。");
        layout = { ...layout, activeWindowId: windowId, windows: layout.windows.map(item => item.id === windowId && tabId ? { ...item, activeTabId: tabId } : item) };
        setActiveWorkspaceContext({ layout });
      }
      const active = activeWorkWindowTab(layout);
      if (sessionId) await selectSession(sessionId, { focusInput: false, updateRoute: false });
      else if (active?.kind === "session") await selectSession(active.sessionId, { focusInput: false, updateRoute: false });
      else goHome({ updateRoute: false });
    } else {
      withoutPageSelection(() => runtime.closeWorkspace());
      if (workspaceId) {
        const workspaces = await httpWorkspacesRepository.list();
        if (!current()) return true;
        const workspace = workspaces.find(item => item.id === workspaceId);
        if (!workspace) throw new Error("链接中的工作区不存在、已删除或无权访问。");
        if (session && session.workspaceId !== workspaceId) throw new Error("链接中的会话不属于指定工作区。");
        withoutPageSelection(() => runtime.openWorkspace(workspace));
      }
      if (sessionId) await selectSession(sessionId, { focusInput: false, updateRoute: false });
      else goHome({ updateRoute: false });
    }
  } catch (error) {
    if (current()) {
      withoutPageSelection(() => runtime.closeWorkspace());
      goHome({ updateRoute: false });
      reportPageRouteFailure(error instanceof Error ? error.message : "链接目标读取失败，请返回工作区重试。");
    }
  } finally {
    restoring--;
    ready = true;
  }
  return true;
}

export function installPageNavigation(): void {
  if (installed) return;
  installed = true;
  configurePageSelection(() => {
    // A real click invalidates an older in-flight route restore, including its later task read.
    if (restoring || !ready) { generation++; ready = true; }
    syncSelection("push", true);
  });
  configurePageRestore(restorePageNavigation);
  workspaceContextStore.subscribe(() => syncSelection());
  subscribePageRoute(() => {
    const next = targetKey();
    if ((!ready && !restoring) || writing || next === lastTarget) return;
    lastTarget = next;
    // Our own synchronous write already describes the current selection.
    if (scheduled) return;
    void restorePageNavigation();
  });
}
