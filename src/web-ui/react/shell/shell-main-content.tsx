import * as React from "react";
import { Flex, Typography } from "antd";

import { WandBrandMark, WandButton, WandIcon, WandIconButton } from "../ui";
import { CodeEditorHost, TaskBoardHost, SettingsHost, NewSessionHost } from "../deferred-hosts";
import { newSessionController, newSessionStore } from "../new-session/controller";
import { codeEditorStore } from "../code-editor/controller";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { openSessionWithOwningTask } from "../workspaces/session-open";
import { workspacesStore } from "../workspaces/controller";
import { deferredComponent, deferredFeature } from "../deferred-feature";
import { WorkspaceTabBar } from "../workspaces/workspace-tab-bar";

import { activeWorkWindow } from "../workspaces/window-layout";
import { HomeAttention } from "../attention/home-attention";
import { ShellFilePanel } from "./shell-file-panel";

import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { AiTeamsPage, TeamChatPage } from "../ai-teams/lazy";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { ShellTopbar } from "./shell-topbar";

import { settingsStore } from "../settings/controller";
import { restartOverlayController } from "../restart-overlay/controller";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiSnapshotData } from "./ui-store";
import { ConversationHome } from "../conversations/home";
import { conversationUi, useConversationUi } from "../conversations/state";

const WorkspaceWindow = deferredComponent(
  () => import("../workspaces/workspace-window").then(module => module.WorkspaceWindow),
  { title: "分屏终端", renderPending: status => <div className="workspace-window" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{status}</div> },
);

const ScheduledTasksPage = deferredFeature(
  () => import("../scheduled-tasks/page").then(module => module.ScheduledTasksPage),
  taskBoardStore,
  (snapshot, props) => snapshot.open && (snapshot.page === "schedules" || snapshot.page === "calendar") && props.visible,
  { title: "定时", page: true, close: () => taskBoardController.close() },
);

export interface ShellMainContentRefs {
  /** Stable roots populated by the corresponding imperative legacy hosts. */
  readonly terminal?: React.Ref<HTMLDivElement>;
  readonly chat?: React.Ref<HTMLDivElement>;
  readonly composer?: React.Ref<HTMLDivElement>;
  readonly fileExplorer?: React.Ref<HTMLDivElement>;
  readonly crossSessionQueue?: React.Ref<HTMLDivElement>;
}

export interface ShellMainContentProps {
  readonly legacyRefs?: Readonly<ShellMainContentRefs>;
}

export interface ShellLegacySlotClasses {
  readonly terminal: string;
  readonly chat: string;
  readonly blank: string;
  readonly composer: string;
}

/** Pure visibility projection; the four roots themselves are never replaced. */
export function getShellLegacySlotClasses(
  visibility: Readonly<UiSnapshotData["legacyVisibility"]>,
): ShellLegacySlotClasses {
  return {
    terminal: `terminal-container ${visibility.terminal ? "active" : "hidden"}`,
    chat: `chat-container ${visibility.chat ? "active" : "hidden"}`,
    blank: `blank-chat${visibility.blank ? "" : " hidden"}`,
    composer: `input-panel${visibility.composer ? "" : " hidden"}`,
  };
}



function ShellBlankChat({ className, queueRef, workspaceTask, workspaceProject }: {
  className: string; queueRef?: React.Ref<HTMLDivElement>;
  workspaceTask?: { workspaceId: string; workspaceName: string; taskId: string; taskName: string; cwd: string };
  workspaceProject?: { workspaceId: string; workspaceName: string; cwd: string };
}) {
  return <Flex vertical id="blank-chat" className={className} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 24, display: className.includes("hidden") ? "none" : undefined }}>
    <HomeAttention/>
    <Flex vertical align="center" justify="center" gap="middle" style={{ flex: 1 }}>
      <WandBrandMark style={{ width: 48, height: 48 }}/>
      <Typography.Title level={2}>{workspaceTask?.taskName || workspaceProject?.workspaceName || "开始新的工作"}</Typography.Title>
      <WandButton id="welcome-new-work" kind="primary" onClick={() => newSessionController.open({
        initialCwd: workspaceTask?.cwd || workspaceProject?.cwd,
        workspaceId: workspaceTask?.workspaceId || workspaceProject?.workspaceId,
        workspaceTaskId: workspaceTask?.taskId, taskName: workspaceTask?.taskName,
      })}>新建工作</WandButton>
    </Flex>
    <div id="cross-session-queue-host" ref={queueRef}/>
  </Flex>;
}

/**
 * React owns shell visibility and the blank state. Legacy modules exclusively
 * own the children of the terminal, chat, composer, and file explorer slots.
 */
export function ShellMainContent({ legacyRefs }: ShellMainContentProps = {}) {
  const editor = React.useSyncExternalStore(
    codeEditorStore.subscribe, codeEditorStore.getSnapshot, codeEditorStore.getSnapshot,
  );
  const settings = React.useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
  const snapshot = useUiStoreSnapshot();
  const conversationState = useConversationUi();
  const dispatch = useUiDispatch();
  const taskBoard = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const classes = getShellLegacySlotClasses(snapshot.legacyVisibility);
  const context = React.useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  // 进入工作空间分屏：只隐藏单例终端槽位（#output/#chat-output/composer/blank），
  // 顶部任务标签栏继续保留；多窗格内容改由 <WorkspaceWindow/> 和终端池渲染。
  // #output 本身仍保留在 DOM（单例终端实例仍挂在上面，仅不可见），退出分屏后
  // 用缓冲 output 重置即可恢复，无需重建终端。
  const inSplit = !!context.taskId && activeWorkWindow(context.layout)?.layout.type === "split";
  const newWork = React.useSyncExternalStore(newSessionStore.subscribe, newSessionStore.getSnapshot, newSessionStore.getSnapshot);
  const conversationVisible = !newWork.open && !settings.open && !taskBoard.open && !editor.open && (conversationState.active === true
    || (conversationState.active === null && !inSplit && !snapshot.selected && !context.workspaceId));
  // 对话 / 看板 / 编辑器都是盖满主区的绝对定位页面层。它们在上面时，遗留槽位不能只是
  // 「被盖住」：#output / #chat-output / 输入区里的浮层仍然按自己的 z-index 参与主区堆叠
  // （终端缩放 11、终端拖拽把手 12、未读气泡 20、排队气泡 40、待办浮层 50 都高于页面层的 8），
  // 会直接浮到私聊页上。这里统一收口成 page layer，可见性交给同一条样式规则处理。
  const pageLayerOpen = newWork.open || settings.open || conversationVisible || taskBoard.open || editor.open;

  return (
    <Flex component="main" vertical inert={snapshot.layout.sessionsBackdropVisible} className={`main-content${snapshot.layout.filePanelOpen && !settings.open ? " file-panel-open" : ""}${inSplit ? " main-content-in-split" : ""}${conversationVisible ? " main-content-conversation" : ""}${taskBoard.open ? " task-board-main-content" : ""}${pageLayerOpen ? " main-content-page-layer" : ""}`} style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" }}>
      {/* 任务内由标签条承担主区导航；不再叠一层重复的会话标题栏。 */}
      {context.taskId ? null : <div style={{ display: "contents", visibility: settings.open ? "hidden" : undefined }} inert={newWork.open || conversationVisible || settings.open} aria-hidden={newWork.open || conversationVisible || settings.open}><ShellTopbar/></div>}
      {context.taskId && snapshot.layout.sidebarDrawer && (
        <Flex component="nav" align="center" gap="small" hidden={newWork.open} className="workspace-mobile-navigation" aria-label="任务导航" style={{ flexShrink: 0, padding: "6px 12px" }}>
          <WandIconButton
            aria-label={snapshot.layout.sessionsDrawerOpen ? "关闭任务列表" : "打开任务"}
            title={snapshot.layout.sessionsDrawerOpen ? "关闭任务列表" : "打开任务"}
            data-pressed={snapshot.layout.sessionsDrawerOpen || undefined}
            aria-expanded={snapshot.layout.sessionsDrawerOpen} aria-controls="sessions-drawer"
            onClick={() => void dispatch({ type: "layout.drawer.toggle" })}>
            <SidebarToggleIcon open={snapshot.layout.sessionsDrawerOpen} size={19}/>
          </WandIconButton>
          <Typography.Text ellipsis title={context.taskName}>{context.taskName || "任务"}</Typography.Text>
        </Flex>
      )}
      <ShellFilePanel explorerRef={legacyRefs?.fileExplorer} suspended={settings.open || newWork.open}/>
      <div style={{ display: "contents", visibility: settings.open ? "hidden" : undefined }} inert={newWork.open || conversationVisible || settings.open} aria-hidden={newWork.open || conversationVisible || settings.open}><WorkspaceTabBar/></div>
      <div id="output" inert={pageLayerOpen} className={classes.terminal} ref={legacyRefs?.terminal} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: snapshot.legacyVisibility.terminal && !inSplit ? "flex" : "none" }}/>
      <div id="chat-output" inert={pageLayerOpen} className={classes.chat} ref={legacyRefs?.chat} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: snapshot.legacyVisibility.chat && !inSplit ? "flex" : "none", flexDirection: "column" }}/>
      <ShellBlankChat
        className={`${classes.blank}${inSplit || newWork.open || conversationVisible || settings.open ? " hidden" : ""}`}
        queueRef={legacyRefs?.crossSessionQueue}
        workspaceTask={context.taskId && context.workspaceId ? {
          workspaceId: context.workspaceId,
          workspaceName: context.workspaceName,
          taskId: context.taskId,
          taskName: context.taskName,
          cwd: context.cwd,
        } : undefined}
        workspaceProject={!context.taskId && context.workspaceId ? {
          workspaceId: context.workspaceId,
          workspaceName: context.workspaceName,
          cwd: context.cwd,
        } : undefined}
      />
      <div inert={pageLayerOpen} className={classes.composer} ref={legacyRefs?.composer} style={{ flexShrink: 0, position: "relative", display: snapshot.legacyVisibility.composer && !inSplit ? undefined : "none" }}/>
      {inSplit ? <div style={{ display: "contents" }} inert={newWork.open || conversationVisible || settings.open} aria-hidden={newWork.open || conversationVisible || settings.open}><WorkspaceWindow/></div> : null}
      <div style={{ display: "contents", visibility: settings.open ? "hidden" : undefined }} inert={settings.open} aria-hidden={settings.open}><CodeEditorHost/></div>
      <ConversationHome visible={conversationVisible} sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onOpenSidebar={snapshot.layout.sidebarDrawer ? () => void dispatch({ type: "layout.drawer.toggle" }) : undefined}
        onOpenSession={id => {
          conversationUi.suspend();
          void openSessionWithOwningTask(id, selectedId => { void dispatch({ type: "session.select", id: selectedId }); });
        }}/>
      {/* 看板是独立路由，不能替换 <main>：#output 等 LegacyHost 槽位必须一直挂着。 */}
      <div style={{ display: "contents", visibility: settings.open ? "hidden" : undefined }} inert={settings.open} aria-hidden={settings.open}>
      {taskBoard.open && taskBoard.page === "teamchat" ? <TeamChatPage
        runId={taskBoard.runId}
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer
          ? () => void dispatch({ type: "layout.drawer.toggle" })
          : undefined}
        onOpenSession={(sessionId) => {
          taskBoardController.close();
          conversationUi.suspend();
          // 群聊里点成员名字：同样带上任务上下文打开该成员的会话。
          void openSessionWithOwningTask(sessionId, (id) => {
            void dispatch({ type: "session.select", id });
          });
        }}
      /> : taskBoard.open && taskBoard.page === "teams" ? <AiTeamsPage
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer
          ? () => void dispatch({ type: "layout.drawer.toggle" })
          : undefined}
        onOpenSession={(sessionId) => {
          taskBoardController.close();
          conversationUi.suspend();
          void openSessionWithOwningTask(sessionId, (id) => {
            void dispatch({ type: "session.select", id });
          });
        }}
      /> : taskBoard.open && taskBoard.page === "board" ? <TaskBoardHost
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer
          ? () => void dispatch({ type: "layout.drawer.toggle" })
          : undefined}
        onOpenSession={(sessionId) => {
          taskBoardController.close();
          conversationUi.suspend();
          // 看板卡片里的会话也要带上任务上下文，否则顶部标签栏（含「＋」）不出现。
          void openSessionWithOwningTask(sessionId, (id) => {
            void dispatch({ type: "session.select", id });
          });
        }}
      /> : null}
      <ScheduledTasksPage visible={taskBoard.open && (taskBoard.page === "schedules" || taskBoard.page === "calendar") && !settings.open}
        view={taskBoard.page === "calendar" ? "calendar" : "list"} calendarMode={taskBoard.calendarRange}
        onViewChange={value => taskBoardController.open("", "", value === "calendar" ? "calendar" : "schedules")}
        onCalendarModeChange={value => taskBoardController.calendarRange(value)}
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer ? () => void dispatch({ type: "layout.drawer.toggle" }) : undefined}
        onOpenSession={(sessionId) => {
          taskBoardController.close();
          conversationUi.suspend();
          void openSessionWithOwningTask(sessionId, (id) => { void dispatch({ type: "session.select", id }); });
        }}/>
      </div>
      <NewSessionHost/>
      <SettingsHost showRestart={restartOverlayController.showRestart}/>
    </Flex>
  );
}
