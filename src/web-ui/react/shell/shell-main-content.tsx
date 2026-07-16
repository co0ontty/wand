import * as React from "react";

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

function WelcomeIcon({ name, size }: {
  name: "chat" | "chevron-down" | "folder" | "terminal";
  size: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "chat":
      return <svg {...common}><path d="M21 15a4 4 0 01-4 4H8l-5 3V7a4 4 0 014-4h10a4 4 0 014 4z"/></svg>;
    case "chevron-down":
      return <svg {...common} strokeWidth={2}><path d="M6 9l6 6 6-6"/></svg>;
    case "folder":
      return <svg {...common}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case "terminal":
      return <svg {...common}><path d="M4 17l6-5-6-5M12 19h8"/></svg>;
  }
}

function ShellBlankChat({ className, cwd, queueRef }: {
  className: string;
  cwd: string;
  queueRef?: React.Ref<HTMLDivElement>;
}) {
  const dispatch = useUiDispatch();
  const quickStart = (tool: ShellWelcomeQuickStart) => {
    void dispatch(getShellWelcomeQuickStartAction(tool));
  };
  const openFolderPicker = () => {
    void dispatch({ type: "folderPicker.open" });
  };

  return (
    <div id="blank-chat" className={className}>
      <div className="blank-chat-inner">
        <div className="blank-chat-logo">W</div>
        <h2 className="blank-chat-title">Wand</h2>
        <p className="blank-chat-subtitle">支持终端 PTY 会话与结构化 chat 会话，两种模式可并存。</p>
        <div className="blank-chat-tools">
          <button
            className="blank-chat-tool-btn"
            id="welcome-tool-claude"
            type="button"
            onClick={() => quickStart("claude")}
          >
            <span className="tool-icon"><WelcomeIcon name="terminal" size={16}/></span>
            新建终端会话
          </button>
          <button
            className="blank-chat-tool-btn"
            id="welcome-tool-codex"
            type="button"
            onClick={() => quickStart("codex")}
          >
            <span className="tool-icon tool-icon-text">⌘</span>
            新建 Codex 会话
          </button>
          <button
            className="blank-chat-tool-btn"
            id="welcome-tool-opencode"
            type="button"
            onClick={() => quickStart("opencode")}
          >
            <span className="tool-icon tool-icon-text">OC</span>
            新建 OpenCode 会话
          </button>
          <button
            className="blank-chat-tool-btn"
            id="welcome-tool-structured"
            type="button"
            onClick={() => quickStart("structured")}
          >
            <span className="tool-icon"><WelcomeIcon name="chat" size={16}/></span>
            新建结构化会话
          </button>
        </div>
        <div className="blank-chat-cwd-wrap">
          <div
            className="blank-chat-cwd"
            id="blank-chat-cwd"
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            title={`当前工作目录：${cwd}`}
            onClick={openFolderPicker}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              openFolderPicker();
            }}
          >
            <span className="blank-chat-cwd-icon"><WelcomeIcon name="folder" size={13}/></span>
            <span className="blank-chat-cwd-path tail-marquee-path" id="blank-chat-cwd-path" title={cwd}>
              <span className="tail-marquee-path-inner">{cwd}</span>
            </span>
            <span className="blank-chat-cwd-arrow" id="blank-chat-cwd-arrow">
              <WelcomeIcon name="chevron-down" size={11}/>
            </span>
          </div>
        </div>
      </div>
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
  const cwd = snapshot.topbar.cwd || "/";

  return (
    <main className={`main-content${snapshot.layout.filePanelOpen ? " file-panel-open" : ""}`}>
      <ShellTopbar/>
      <ShellFilePanel explorerRef={legacyRefs?.fileExplorer}/>
      <div id="output" className={classes.terminal} ref={legacyRefs?.terminal}/>
      <div id="chat-output" className={classes.chat} ref={legacyRefs?.chat}/>
      <ShellBlankChat
        className={classes.blank}
        cwd={cwd}
        queueRef={legacyRefs?.crossSessionQueue}
      />
      <div className={classes.composer} ref={legacyRefs?.composer}/>
    </main>
  );
}
