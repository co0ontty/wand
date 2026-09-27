import * as React from "react";

import { WandBrandMark, WandButton, WandIcon, WandIconButton } from "../ui";
import { CodeEditorHost } from "../code-editor/host";
import { codeEditorStore } from "../code-editor/controller";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { openSessionWithOwningTask } from "../workspaces/session-open";
import { workspacesStore } from "../workspaces/controller";
import { httpWorkspacesRepository } from "../workspaces/repository";
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
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiSnapshotData } from "./ui-store";

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

  const startInTask = async (target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string) => {
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
      });
      void runtime.refreshSessions();
    } catch (error) {
      throw presentStartError(error, "无法在任务中启动会话。");
    }
  };

  const startInProject = async (target: WorkspaceSessionTarget, kind: WorkspaceSessionKind, model: string) => {
    if (!workspaceProject) return;
    const runtime = workspacesStore.getRuntime();
    if (!runtime) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    try {
      const created = await httpWorkspacesRepository.createTask(workspaceProject.workspaceId, {
        worktree: false,
      });
      await Promise.resolve(runtime.openTask({
        workspaceId: workspaceProject.workspaceId,
        workspaceName: workspaceProject.workspaceName,
        taskId: created.id,
        taskName: created.name,
        cwd: created.cwd || workspaceProject.cwd,
      }));
      await runtime.newTaskSession({
        workspaceId: workspaceProject.workspaceId,
        taskId: created.id,
        cwd: created.cwd || workspaceProject.cwd,
        target,
        kind,
        model: model || undefined,
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
    <div id="blank-chat" className={className}>
      <HomeAttention variant="home"/>
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
          subtitle="项目还是空白的。选择 CLI 工具和结构化 / PTY，开始第一个任务。"
          cwd={workspaceProject.cwd}
          submitLabel="开始 "
          teams={teamWorkspaceId ? teamOptions : null}
          teamWorkspaceId={teamWorkspaceId}
          onStart={startInProject}
          onStartTeam={startTeamInProject}
        />
      ) : <div className="blank-chat-inner">
        <WandBrandMark className="blank-chat-logo" />
        <h2 className="blank-chat-title">Wand</h2>
        <p className="blank-chat-subtitle">创建一个任务，选择目录和 CLI，开始工作。</p>
        <div className="blank-chat-tools">
          <WandButton
            className="blank-chat-tool-btn welcome-new-task"
            id="welcome-new-task"
            kind="primary"
            onClick={() => void dispatch({ type: "workspace.new" })}
          >
            <span className="tool-icon" slot="start"><WandIcon name="plus" size={18}/></span>
            新建任务
          </WandButton>
        </div>
      </div>}
      <div id="cross-session-queue-host" ref={queueRef}/>
    </div>
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
  const snapshot = useUiStoreSnapshot();
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

  return (
    <main inert={snapshot.layout.sessionsBackdropVisible} className={`main-content${snapshot.layout.filePanelOpen ? " file-panel-open" : ""}${inSplit ? " main-content-in-split" : ""}${taskBoard.open ? " task-board-main-content" : ""}`}>
      {/* 任务内由标签条承担主区导航；不再叠一层重复的会话标题栏。 */}
      {context.taskId ? null : <ShellTopbar/>}
      {context.taskId && snapshot.layout.sidebarDrawer && (
        <nav className="workspace-mobile-navigation" aria-label="任务导航">
          <WandIconButton
            aria-label={snapshot.layout.sessionsDrawerOpen ? "关闭任务列表" : "打开任务"}
            title={snapshot.layout.sessionsDrawerOpen ? "关闭任务列表" : "打开任务"}
            data-pressed={snapshot.layout.sessionsDrawerOpen || undefined}
            aria-expanded={snapshot.layout.sessionsDrawerOpen} aria-controls="sessions-drawer"
            onClick={() => void dispatch({ type: "layout.drawer.toggle" })}>
            <SidebarToggleIcon open={snapshot.layout.sessionsDrawerOpen} size={19}/>
          </WandIconButton>
          <span title={context.taskName}>{context.taskName || "任务"}</span>
        </nav>
      )}
      <ShellFilePanel explorerRef={legacyRefs?.fileExplorer}/>
      <WorkspaceTabBar/>
      <div id="output" inert={editor.open} className={classes.terminal} ref={legacyRefs?.terminal}/>
      <div id="chat-output" inert={editor.open} className={classes.chat} ref={legacyRefs?.chat}/>
      <ShellBlankChat
        className={classes.blank}
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
      <div inert={editor.open} className={classes.composer} ref={legacyRefs?.composer}/>
      {inSplit ? <WorkspaceWindow/> : null}
      <CodeEditorHost/>
      {/* 看板是独立路由，不能替换 <main>：#output 等 LegacyHost 槽位必须一直挂着。 */}
      {taskBoard.open && taskBoard.page === "teamchat" ? <TeamChatPage
        runId={taskBoard.runId}
        sidebarOpen={snapshot.layout.sessionsDrawerOpen}
        onBack={() => taskBoardController.close()}
        onOpenSidebar={snapshot.layout.sidebarDrawer
          ? () => void dispatch({ type: "layout.drawer.toggle" })
          : undefined}
        onOpenSession={(sessionId) => {
          taskBoardController.close();
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
          // 看板卡片里的会话也要带上任务上下文，否则顶部标签栏（含「＋」）不出现。
          void openSessionWithOwningTask(sessionId, (id) => {
            void dispatch({ type: "session.select", id });
          });
        }}
      /> : null}
    </main>
  );
}
