import * as React from "react";
import { Flex, Typography } from "antd";

import { WandBrandMark } from "../ui/brand-mark";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { CodeEditorHost, TaskBoardHost, SettingsHost, NewSessionHost } from "../deferred-hosts";
import { newSessionController, newSessionStore } from "../new-session/controller";
import { NewSessionHeader, NewSessionHeaderProvided } from "../new-session/header";
import { codeEditorStore } from "../code-editor/controller";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { openSessionPage } from "../../page-route";
import { workspacesStore } from "../workspaces/controller";
import { deferredComponent, deferredFeature } from "../deferred-feature";
import { WorkspaceTabBar } from "../workspaces/workspace-tab-bar";

import { activeWorkWindow } from "../workspaces/window-layout";
import { HomeAttention } from "../attention/home-attention";
import { ShellFilePanel } from "./shell-file-panel";

import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { knowledgeController, knowledgeStore } from "../knowledge/controller";
import type { KnowledgeHostProps } from "../knowledge/host";
import { AiTeamsPage, TeamChatPage } from "../ai-teams/lazy";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { ShellTopbar } from "./shell-topbar";

import { settingsStore } from "../settings/controller";
import { restartOverlayController } from "../restart-overlay/controller";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiSnapshotData } from "./ui-store";
import type { ConversationHomeProps } from "../conversations/home";
// 会话页是整页覆盖层，只有用户真的进会话时才需要；首屏壳不需要它的消息列、
// 侧栏投影、Markdown 与附件卡。改成按需加载后它从 eager runtime 里退出。
const ConversationHome = deferredComponent<ConversationHomeProps>(
  () => import("../conversations/home").then(module => module.ConversationHome),
  { title: "聊天" },
);
import { useConversationUi } from "../conversations/state";

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
const KnowledgeHost = deferredFeature<KnowledgeHostProps, ReturnType<typeof knowledgeStore.getSnapshot>>(
  () => import("../knowledge/host").then(module => module.KnowledgeHost), knowledgeStore,
  (snapshot, props) => snapshot.open && props.visible,
  { title: "知识库", page: true, close: () => knowledgeController.close() },
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
  return <Flex vertical id="blank-chat" className={className} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 24, position: "relative", display: className.includes("hidden") ? "none" : undefined }}>
    {/* 报错条是异步到达的（没有报错时它根本不渲染）。若参与纵向流，它一出现就把居中的
        欢迎内容顶下去 32px（实测任务看板 CLS 0.0189）。改为绝对定位在左上角：
        位置不变，也不影响下面居中的内容。 */}
    <div className="blank-chat-attention"><HomeAttention/></div>
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
  const knowledge = React.useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot, knowledgeStore.getSnapshot);
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
  const conversationVisible = !newWork.open && !settings.open && !taskBoard.open && !knowledge.open && !editor.open && (conversationState.active === true
    || (conversationState.active === null && !inSplit && !snapshot.selected && !context.workspaceId));
  // 对话 / 看板 / 编辑器都是盖满主区的绝对定位页面层。它们在上面时，遗留槽位不能只是
  // 「被盖住」：#output / #chat-output / 输入区里的浮层仍然按自己的 z-index 参与主区堆叠
  // （终端缩放 11、终端拖拽把手 12、未读气泡 20、排队气泡 40、待办浮层 50 都高于页面层的 8），
  // 会直接浮到私聊页上。这里统一收口成 page layer，可见性交给同一条样式规则处理。
  const pageLayerOpen = newWork.open || settings.open || conversationVisible || taskBoard.open || knowledge.open || editor.open;

  return (
    <Flex component="main" vertical inert={snapshot.layout.sessionsBackdropVisible} className={`main-content${snapshot.layout.filePanelOpen && !settings.open ? " file-panel-open" : ""}${inSplit ? " main-content-in-split" : ""}${conversationVisible ? " main-content-conversation" : ""}${taskBoard.open ? " task-board-main-content" : ""}${pageLayerOpen ? " main-content-page-layer" : ""}`} style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" }}>
      {/* One route owns the whole header; page layers must not leave focusable portal chrome behind. */}
      {!pageLayerOpen && <WorkspaceTabBar fallback={<ShellTopbar/>}/>}
      {newWork.open && !settings.open && <NewSessionHeader/>}
      <ShellFilePanel explorerRef={legacyRefs?.fileExplorer} suspended={settings.open || newWork.open || knowledge.open}/>

      <div id="output" inert={pageLayerOpen} className={classes.terminal} ref={legacyRefs?.terminal} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: snapshot.legacyVisibility.terminal && !inSplit ? "flex" : "none" }}/>
      <div id="chat-output" inert={pageLayerOpen} className={classes.chat} ref={legacyRefs?.chat} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: snapshot.legacyVisibility.chat && !inSplit ? "flex" : "none", flexDirection: "column" }}/>
      <ShellBlankChat
        className={`${classes.blank}${inSplit || newWork.open || conversationVisible || settings.open || knowledge.open ? " hidden" : ""}`}
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
      {inSplit ? <div style={{ display: "contents" }} inert={newWork.open || conversationVisible || settings.open || knowledge.open} aria-hidden={newWork.open || conversationVisible || settings.open || knowledge.open}><WorkspaceWindow/></div> : null}
      <div style={{ display: "contents", visibility: settings.open || newWork.open || knowledge.open ? "hidden" : undefined }} inert={settings.open || newWork.open || knowledge.open} aria-hidden={settings.open || newWork.open || knowledge.open}><CodeEditorHost/></div>
      {/* 首次进入聊天才下载并挂载整页；之后常驻，用 visible 控制读取与订阅，草稿仍归 composer store。 */}
      <ConversationHome enabled={conversationVisible} visible={conversationVisible} sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onOpenSidebar={snapshot.layout.sidebarDrawer ? () => void dispatch({ type: "layout.drawer.toggle" }) : undefined}
        onOpenSession={openSessionPage}/>
      {/* 看板是独立路由，不能替换 <main>：#output 等 LegacyHost 槽位必须一直挂着。 */}
      <div style={{ display: "contents", visibility: settings.open || newWork.open || knowledge.open ? "hidden" : undefined }} inert={settings.open || newWork.open || knowledge.open} aria-hidden={settings.open || newWork.open || knowledge.open}>
      {taskBoard.open && taskBoard.page === "teamchat" ? <TeamChatPage
        runId={taskBoard.runId}
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer
          ? () => void dispatch({ type: "layout.drawer.toggle" })
          : undefined}
        onOpenSession={openSessionPage}
      /> : taskBoard.open && taskBoard.page === "teams" ? <AiTeamsPage
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer
          ? () => void dispatch({ type: "layout.drawer.toggle" })
          : undefined}
        onOpenSession={openSessionPage}
      /> : taskBoard.open && taskBoard.page === "board" ? <TaskBoardHost
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer
          ? () => void dispatch({ type: "layout.drawer.toggle" })
          : undefined}
        onOpenSession={openSessionPage}
      /> : null}
      <ScheduledTasksPage visible={taskBoard.open && (taskBoard.page === "schedules" || taskBoard.page === "calendar") && !settings.open}
        view={taskBoard.page === "calendar" ? "calendar" : "list"} calendarMode={taskBoard.calendarRange}
        onViewChange={value => taskBoardController.open("", "", value === "calendar" ? "calendar" : "schedules")}
        onCalendarModeChange={value => taskBoardController.calendarRange(value)}
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer ? () => void dispatch({ type: "layout.drawer.toggle" }) : undefined}
        onOpenSession={openSessionPage}/>
      </div>
      <KnowledgeHost visible={knowledge.open && !settings.open && !newWork.open}
        onOpenSidebar={snapshot.layout.sidebarDrawer ? () => void dispatch({ type: "layout.drawer.toggle" }) : undefined}/>
      <NewSessionHeaderProvided.Provider value={true}><NewSessionHost/></NewSessionHeaderProvided.Provider>
      <SettingsHost showRestart={restartOverlayController.showRestart}/>
    </Flex>
  );
}
