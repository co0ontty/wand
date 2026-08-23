import * as React from "react";

import { WandIcon } from "../ui";
import { CodeEditorHost } from "../code-editor/host";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { workspaceAgentDialogController } from "../workspaces/workspace-agent-dialog-controller";
import { WorkspaceTabBar } from "../workspaces/workspace-tab-bar";
import { WorkspaceWindow } from "../workspaces/workspace-window";
import { activeWorkWindow } from "../workspaces/window-layout";
import { ShellFilePanel } from "./shell-file-panel";
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



function ShellBlankChat({ className, queueRef, workspaceTask }: {
  className: string;
  queueRef?: React.Ref<HTMLDivElement>;
  workspaceTask?: {
    workspaceName: string;
    taskName: string;
    cwd: string;
  };
}) {
  const dispatch = useUiDispatch();

  return (
    <div id="blank-chat" className={className}>
      {workspaceTask ? (
        <div className="blank-chat-inner workspace-task-welcome">
          <div className="workspace-task-welcome-eyebrow">{workspaceTask.workspaceName}</div>
          <div className="blank-chat-logo"><WandIcon name="task" size={28} strokeWidth={1.8}/></div>
          <h2 className="blank-chat-title">{workspaceTask.taskName}</h2>
          <p className="blank-chat-subtitle">这个任务还没有工作窗口。选择一个 Agent，或直接打开空白终端。</p>
          <div className="blank-chat-tools">
            <button
              className="workspace-task-welcome-action"
              type="button"
              onClick={() => workspaceAgentDialogController.open()}
            >
              <WandIcon name="spark" size={17} strokeWidth={1.8}/>
              选择 Agent 或空白终端
            </button>
          </div>
          <div className="workspace-task-welcome-cwd" title={workspaceTask.cwd}>
            <WandIcon name="folder" size={13} strokeWidth={1.8}/>
            <span>{workspaceTask.cwd}</span>
          </div>
        </div>
      ) : <div className="blank-chat-inner">
        <div className="blank-chat-logo">W</div>
        <h2 className="blank-chat-title">Wand</h2>
        <p className="blank-chat-subtitle">一切从任务开始：新建任务时选目录，之后在任务里建会话无需再选目录。</p>
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
    <main className={`main-content${snapshot.layout.filePanelOpen ? " file-panel-open" : ""}${inSplit ? " main-content-in-split" : ""}`}>
      {/* 任务内由标签条承担主区导航；不再叠一层重复的会话标题栏。 */}
      {context.taskId ? null : <ShellTopbar/>}
      <ShellFilePanel explorerRef={legacyRefs?.fileExplorer}/>
      <WorkspaceTabBar/>
      <div id="output" className={classes.terminal} ref={legacyRefs?.terminal}/>
      <div id="chat-output" className={classes.chat} ref={legacyRefs?.chat}/>
      <ShellBlankChat
        className={classes.blank}
        queueRef={legacyRefs?.crossSessionQueue}
        workspaceTask={context.taskId ? {
          workspaceName: context.workspaceName,
          taskName: context.taskName,
          cwd: context.cwd,
        } : undefined}
      />
      <div className={classes.composer} ref={legacyRefs?.composer}/>
      {inSplit ? <WorkspaceWindow/> : null}
      <CodeEditorHost/>
    </main>
  );
}
