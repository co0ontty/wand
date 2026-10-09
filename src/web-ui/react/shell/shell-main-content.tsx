import * as React from "react";
import { Flex, Typography } from "antd";

import { WandBrandMark, WandButton, WandIcon, WandIconButton } from "../ui";
import { CodeEditorHost } from "../code-editor/host";
import { codeEditorStore } from "../code-editor/controller";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { openSessionWithOwningTask } from "../workspaces/session-open";
import { workspacesStore } from "../workspaces/controller";
import { WorkspaceWelcomeChooser, usableTeamWorkspaceId } from "../workspaces/workspace-agent-picker";
import { aiTeamPickerOption, aiTeamsRepository, useAiTeamList } from "../ai-teams/repository";
import { WorkspaceTabBar } from "../workspaces/workspace-tab-bar";
import { WorkspaceWindow } from "../workspaces/workspace-window";
import { activeWorkWindow } from "../workspaces/window-layout";
import type { WorkspaceSessionKind, WorkspaceSessionTarget } from "../workspaces/types";
import { HomeAttention } from "../attention/home-attention";
import { ShellFilePanel } from "./shell-file-panel";
import { TaskBoardHost } from "../issues/task-board-host";
import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { notifyTasksChanged } from "../task-changes";
import { AiTeamsPage, TeamChatPage } from "../ai-teams/lazy";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { ShellTopbar } from "./shell-topbar";
import { SettingsHost } from "../settings/host";
import { settingsStore } from "../settings/controller";
import { restartOverlayController } from "../restart-overlay/controller";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiSnapshotData } from "./ui-store";
import { ConversationHome } from "../conversations/home";
import { conversationUi, useConversationUi } from "../conversations/state";

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



function presentStartError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message && error.message !== "Failed to fetch") return error;
  return new Error(fallback);
}

function ShellBlankChat({ className, queueRef, workspaceTask, workspaceProject }: {
  className: string;
  queueRef?: React.Ref<HTMLDivElement>;
  workspaceTask?: {
    workspaceId: string;
    workspaceName: string;
    taskId: string;
    taskName: string;
    cwd: string;
  };
  workspaceProject?: {
    workspaceId: string;
    workspaceName: string;
    cwd: string;
  };
}) {
  const dispatch = useUiDispatch();
  // 项目欢迎页的团队分支只在「无任务的项目」上下文出现；任务上下文分支刻意不加（§5.1）。
  const teamWorkspaceId = usableTeamWorkspaceId(workspaceProject?.workspaceId);
  const teamOptions = useAiTeamList(!!workspaceProject && !workspaceTask)?.map(aiTeamPickerOption) ?? null;

  const startInTask = async (target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string, employeeId?: string) => {
    if (!workspaceTask) return;
    const runtime = workspacesStore.getRuntime();
    if (!runtime) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    try {
      await runtime.newTaskSession({
        workspaceId: workspaceTask.workspaceId,
        taskId: workspaceTask.taskId,
        cwd: workspaceTask.cwd,
        target,
        kind,
        model: model || undefined,
        employeeId,
      });
      void runtime.refreshSessions();
    } catch (error) {
      throw presentStartError(error, "无法在任务中启动会话。");
    }
  };

  const startInProject = async (target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string, employeeId?: string) => {
    if (!workspaceProject) return;
    const runtime = workspacesStore.getRuntime();
    if (!runtime) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    try {
      // 项目里直接开工不再替会话建任务：会话只带项目归属，落在侧栏「未分组任务」，
      // 用户需要时再从会话行「归纳为新任务」。
      await runtime.newTaskSession({
        workspaceId: workspaceProject.workspaceId,
        cwd: workspaceProject.cwd,
        target,
        kind,
        model: model || undefined,
        employeeId,
      });
      void runtime.refreshSessions();
    } catch (error) {
      throw presentStartError(error, "无法在项目中启动会话。");
    }
  };

  /**
   * 项目欢迎页直接开工（§5.1）：成功后原位停 dwell 再前进 —— 落到 IM 群聊页（teamchat，按 runId 打开，
   * 与侧栏点群聊条目同一视图）；只有 run 没带回 chatSessionId 才退回团队页看运行（路径 b）。
   */
  const startTeamInProject = async (teamId: string, workspaceId: string) => {
    const team = teamOptions?.find((option) => option.id === teamId);
    try {
      // 欢迎页没有输入框：note 用团队名，服务端据此建出的 team_direct 卡标题也就是团队名（§4.2）。
      const started = await aiTeamsRepository.startDirect(teamId, {
        note: team?.name ?? "直接开工",
        workspaceId,
      });
      await aiTeamsRepository.settle("success");
      // 开团后首屏直接进 IM 群聊页（§5.1 路径 a 改走 teamchat），和侧栏点群聊条目一致。
      const sessionId = started.run.chatSessionId;
      if (sessionId) {
        taskBoardController.open("", "", "teamchat", started.run.id);
      } else {
        // 唯一退化分支：run 没带回群聊会话 id，跳团队页看这次运行（路径 b），不静默留在欢迎页。
        taskBoardController.open("", "", "teams");
      }
      // 侧栏群聊徽标来自 /api/tasks（useTaskGroups 订阅 task-changes），开团后主动通知一次，
      // 不等 ~6s 轮询；单次信号只让每个订阅者 reload 一遍，有 generation + revision 廉价校验，不会成刷新风暴。
      notifyTasksChanged();
    } catch (error) {
      throw presentStartError(error, "无法启动团队运行。");
    }
  };

  return (
    <Flex vertical id="blank-chat" className={className} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 24, display: className.includes("hidden") ? "none" : undefined }}>
      <HomeAttention/>
      {workspaceTask ? (
        // 任务上下文已有这张卡，加团队只会冗余建卡，所以这里不传 teams/onStartTeam（§5.1）。
        <WorkspaceWelcomeChooser
          eyebrow={workspaceTask.workspaceName || undefined}
          title={workspaceTask.taskName}
          subtitle="选择 CLI 工具，以及结构化或 PTY，开始这个任务。"
          cwd={workspaceTask.cwd}
          submitLabel="启动 "
          onStart={startInTask}
        />
      ) : workspaceProject ? (
        <WorkspaceWelcomeChooser
          eyebrow="项目"
          title={workspaceProject.workspaceName}
          subtitle="选择 CLI 工具和结构化 / PTY，在项目里直接开始会话；需要时再归纳成任务。"
          cwd={workspaceProject.cwd}
          submitLabel="开始 "
          teams={teamWorkspaceId ? teamOptions : null}
          teamWorkspaceId={teamWorkspaceId}
          onStart={startInProject}
          onStartTeam={startTeamInProject}
        />
      ) : <Flex vertical align="center" justify="center" gap="middle" className="blank-chat-inner" style={{ flex: 1 }}>
        <WandBrandMark className="blank-chat-logo" style={{ width: 48, height: 48 }} />
        <Typography.Title level={2} className="blank-chat-title" style={{ margin: 0 }}>Wand</Typography.Title>
        <Typography.Paragraph type="secondary" className="blank-chat-subtitle">创建一个任务，选择目录和 CLI，开始工作。</Typography.Paragraph>
        <Flex className="blank-chat-tools">
          <WandButton
            className="blank-chat-tool-btn welcome-new-task"
            id="welcome-new-task"
            kind="primary"
            onClick={() => void dispatch({ type: "workspace.new" })}
          >
            <span className="tool-icon" slot="start"><WandIcon name="plus" size={18}/></span>
            新建任务
          </WandButton>
        </Flex>
      </Flex>}
      <div id="cross-session-queue-host" ref={queueRef}/>
    </Flex>
  );
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
  const conversationVisible = !settings.open && !taskBoard.open && !editor.open && (conversationState.active === true
    || (conversationState.active === null && !inSplit && !snapshot.selected && !context.workspaceId));
  // 对话 / 看板 / 编辑器都是盖满主区的绝对定位页面层。它们在上面时，遗留槽位不能只是
  // 「被盖住」：#output / #chat-output / 输入区里的浮层仍然按自己的 z-index 参与主区堆叠
  // （终端缩放 11、终端拖拽把手 12、未读气泡 20、排队气泡 40、待办浮层 50 都高于页面层的 8），
  // 会直接浮到私聊页上。这里统一收口成 page layer，可见性交给同一条样式规则处理。
  const pageLayerOpen = settings.open || conversationVisible || taskBoard.open || editor.open;

  return (
    <Flex component="main" vertical inert={snapshot.layout.sessionsBackdropVisible} className={`main-content${snapshot.layout.filePanelOpen && !settings.open ? " file-panel-open" : ""}${inSplit ? " main-content-in-split" : ""}${conversationVisible ? " main-content-conversation" : ""}${taskBoard.open ? " task-board-main-content" : ""}${pageLayerOpen ? " main-content-page-layer" : ""}`} style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" }}>
      {/* 任务内由标签条承担主区导航；不再叠一层重复的会话标题栏。 */}
      {context.taskId ? null : <div style={{ display: "contents", visibility: settings.open ? "hidden" : undefined }} inert={conversationVisible || settings.open} aria-hidden={conversationVisible || settings.open}><ShellTopbar/></div>}
      {context.taskId && snapshot.layout.sidebarDrawer && (
        <Flex component="nav" align="center" gap="small" className="workspace-mobile-navigation" aria-label="任务导航" style={{ flexShrink: 0, padding: "6px 12px" }}>
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
      <ShellFilePanel explorerRef={legacyRefs?.fileExplorer} suspended={settings.open}/>
      <div style={{ display: "contents", visibility: settings.open ? "hidden" : undefined }} inert={conversationVisible || settings.open} aria-hidden={conversationVisible || settings.open}><WorkspaceTabBar/></div>
      <div id="output" inert={pageLayerOpen} className={classes.terminal} ref={legacyRefs?.terminal} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: snapshot.legacyVisibility.terminal && !inSplit ? "flex" : "none" }}/>
      <div id="chat-output" inert={pageLayerOpen} className={classes.chat} ref={legacyRefs?.chat} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", display: snapshot.legacyVisibility.chat && !inSplit ? "flex" : "none", flexDirection: "column" }}/>
      <ShellBlankChat
        className={`${classes.blank}${inSplit || conversationVisible || settings.open ? " hidden" : ""}`}
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
      {inSplit ? <div style={{ display: "contents" }} inert={conversationVisible || settings.open} aria-hidden={conversationVisible || settings.open}><WorkspaceWindow/></div> : null}
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
      /> : taskBoard.open ? <TaskBoardHost
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
      </div>
      <SettingsHost showRestart={() => restartOverlayController.showRestart()}/>
    </Flex>
  );
}
