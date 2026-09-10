import * as React from "react";

import { WandIcon } from "../ui";
import { CodeEditorHost } from "../code-editor/host";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { workspacesStore } from "../workspaces/controller";
import { httpWorkspacesRepository } from "../workspaces/repository";
import { WorkspaceWelcomeChooser } from "../workspaces/workspace-agent-picker";
import { WorkspaceTabBar } from "../workspaces/workspace-tab-bar";
import { WorkspaceWindow } from "../workspaces/workspace-window";
import { activeWorkWindow } from "../workspaces/window-layout";
import type { WorkspaceSessionKind, WorkspaceSessionTarget } from "../workspaces/types";
import { ShellFilePanel } from "./shell-file-panel";
import { TaskBoardHost } from "../issues/task-board-host";
import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { ShellTopbar } from "./shell-topbar";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiAction, UiSnapshotData } from "./ui-store";

export type ShellWelcomeQuickStart = "claude" | "codex" | "opencode" | "structured";

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

/** Each welcome entry remains a separate domain action and legacy command. */
export function getShellWelcomeQuickStartAction(tool: ShellWelcomeQuickStart): UiAction {
  switch (tool) {
    case "claude": return { type: "session.quickStart.claude" };
    case "codex": return { type: "session.quickStart.codex" };
    case "opencode": return { type: "session.quickStart.opencode" };
    case "structured": return { type: "session.quickStart.structured" };
  }
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

  const startInTask = async (target: WorkspaceSessionTarget, kind: WorkspaceSessionKind) => {
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
      });
      void runtime.refreshSessions();
    } catch (error) {
      throw presentStartError(error, "无法在任务中启动会话。");
    }
  };

  const startInProject = async (target: WorkspaceSessionTarget, kind: WorkspaceSessionKind) => {
    if (!workspaceProject) return;
    const runtime = workspacesStore.getRuntime();
    if (!runtime) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    try {
      const created = await httpWorkspacesRepository.createTask(workspaceProject.workspaceId, {
        name: "新任务",
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
      });
      void runtime.refreshSessions();
    } catch (error) {
      throw presentStartError(error, "无法在项目中启动会话。");
    }
  };

  return (
    <div id="blank-chat" className={className}>
      {workspaceTask ? (
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
          onStart={startInProject}
        />
      ) : <div className="blank-chat-inner">
        <div className="blank-chat-logo">W</div>
        <h2 className="blank-chat-title">Wand</h2>
        <p className="blank-chat-subtitle">可以先建一个不依赖项目的任务，或新建项目后再在目录下工作。</p>
        <div className="blank-chat-tools">
          <button
            className="blank-chat-tool-btn welcome-new-task"
            id="welcome-new-task"
            type="button"
            onClick={() => void dispatch({ type: "workspace.new" })}
          >
            <span className="tool-icon"><WandIcon name="task" size={16} strokeWidth={1.8}/></span>
            新建任务
          </button>
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

  if (taskBoard.open) {
    return <main className="main-content task-board-main-content"><TaskBoardHost onOpenSession={(sessionId) => {
      taskBoardController.close();
      dispatch({ type: "session.select", id: sessionId });
    }} /></main>;
  }

  return (
    <main inert={snapshot.layout.sessionsBackdropVisible} className={`main-content${snapshot.layout.filePanelOpen ? " file-panel-open" : ""}${inSplit ? " main-content-in-split" : ""}`}>
      {/* 任务内由标签条承担主区导航；不再叠一层重复的会话标题栏。 */}
      {context.taskId ? null : <ShellTopbar/>}
      {context.taskId && snapshot.viewport.mobile && (
        <nav className="workspace-mobile-navigation" aria-label="任务导航">
          <button type="button" aria-label="打开任务与项目" title="打开任务与项目"
            aria-expanded={snapshot.layout.sessionsDrawerOpen} aria-controls="sessions-drawer"
            onClick={() => void dispatch({ type: "layout.drawer.toggle" })}>
            <WandIcon name="rail" size={19}/>
          </button>
          <span title={context.taskName}>{context.taskName || "任务"}</span>
        </nav>
      )}
      <ShellFilePanel explorerRef={legacyRefs?.fileExplorer}/>
      <WorkspaceTabBar/>
      <div id="output" className={classes.terminal} ref={legacyRefs?.terminal}/>
      <div id="chat-output" className={classes.chat} ref={legacyRefs?.chat}/>
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
      <div className={classes.composer} ref={legacyRefs?.composer}/>
      {inSplit ? <WorkspaceWindow/> : null}
      <CodeEditorHost/>
    </main>
  );
}
