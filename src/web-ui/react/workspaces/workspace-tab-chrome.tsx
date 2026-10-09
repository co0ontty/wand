import * as React from "react";
import { Badge, Flex, Tabs } from "antd";
import { WandUiBoundary } from "../theme";
import { WandButton, WandIcon } from "../ui";
import type { WandButtonProps } from "../ui/button";
import { classNames } from "../ui/class-names";
import { SessionProviderMark } from "./session-mark";
import { listSessionLabel } from "./session-order";
import type { WorkspaceSessionSummary } from "./types";

export interface WorkspaceWindowPresentation {
  readonly id: string;
  readonly label: string;
  readonly status?: string;
  readonly count: number;
  readonly session?: WorkspaceSessionSummary;
  readonly containsMoving?: boolean;
}

function StatusDot({ status }: { status?: string }) {
  const tone = status === "running" || status === "thinking" || status === "waiting-input"
    ? "running"
    : status === "exited" || status === "failed" || status === "stopped" ? "ended" : "idle";
  return <Badge status={tone === "running" ? "processing" : status === "failed" ? "error" : "default"}
    className={classNames("workspace-tab-dot", tone)} aria-hidden/>;
}

/** Shared native trigger; measurement omits the live dropdown owner. */
export function WorkspaceMoreButton({ className, style, ...props }: Omit<WandButtonProps, "children"> = {}) {
  return <WandButton kind="ghost" aria-label="工作窗口操作" title="工作窗口操作" {...props}
    className={classNames("workspace-tab-more", className)} style={{ width: 44, height: 44, flexShrink: 0, ...style }}>
    <WandIcon name="more" size={18}/>
  </WandButton>;
}

/** Live git/reading controls are slots; future PTY creation has neither. */
export function WorkspaceDesktopActionsChrome({ children, onFiles, onClose }: {
  children?: React.ReactNode;
  onFiles?: () => void;
  onClose?: () => void;
}) {
  return <>{children}
    <WandButton kind="ghost" type="button" className="workspace-tab-files" title="打开文件面板" aria-label="文件" onClick={onFiles}>
      <WandIcon name="explorer" size={16} strokeWidth={1.8}/>
    </WandButton>
    <WandButton kind="ghost" type="button" className="workspace-tab-close" title="关闭任务标签组" aria-label="关闭任务标签组" onClick={onClose}>
      <WandIcon name="close" size={18}/>
    </WandButton>
  </>;
}

export interface WorkspaceTabBarChromeProps {
  readonly mobile: boolean;
  readonly taskName: string;
  readonly variant?: "task" | "standalone";
  readonly activeWindowId?: string | null;
  readonly windows: readonly WorkspaceWindowPresentation[];
  readonly movingDir?: "h" | "v" | null;
  readonly closingWindowId?: string | null;
  readonly onSelectWindow?: (id: string) => void;
  readonly onCloseWindow?: (id: string) => void;
  readonly onNewSession?: () => void;
  readonly onToggleMove?: (dir: "h" | "v") => void;
  readonly onCancelMove?: () => void;
  readonly actions?: React.ReactNode;
}

/** Pure row shared by the live controller and first-window geometry projection. */
export function WorkspaceTabBarChrome({ mobile, taskName, variant = "task", activeWindowId, windows, movingDir, closingWindowId,
  onSelectWindow, onCloseWindow, onNewSession, onToggleMove, onCancelMove, actions }: WorkspaceTabBarChromeProps) {
  const standalone = variant === "standalone";
  return <Flex align="center" gap={4} wrap={!mobile} className="workspace-tab-bar"
    data-session-tabs={variant}
    style={{ flexShrink: 0, minWidth: 0, padding: "6px 12px", borderBottom: "1px solid var(--border-subtle)" }}>
    <Flex align="center" gap={4} className="workspace-tab-bar-list" style={{ flex: mobile ? "1 1 0" : "1 1 420px", minWidth: 0 }}>
      <WandUiBoundary><Tabs className="wand-workspace-tabs" type="editable-card" hideAdd tabBarStyle={{ marginBottom: 0 }} style={{ flex: 1, minWidth: 0 }}
        aria-label={standalone ? "未分组会话标签" : `任务 ${taskName} 的工作窗口标签`} activeKey={activeWindowId ?? undefined}
        items={windows.map(presentation => ({
          key: presentation.id,
          closable: !mobile && !standalone,
          label: <span className={classNames("wand-workspace-tab-label",
            movingDir && !presentation.containsMoving && "move-target", presentation.containsMoving && "moving-source")}
            title={movingDir && !presentation.containsMoving ? `把当前终端移入「${presentation.label}」`
              : `${presentation.label}${presentation.count > 1 ? "（分屏工作窗口）" : ""}`}>
            <StatusDot status={presentation.status}/>
            {presentation.session ? <SessionProviderMark session={presentation.session} className="workspace-tab-logo"/> : null}
            <span>{presentation.label}</span>
          </span>,
          closeIcon: <span aria-label={`关闭工作窗口 ${presentation.label}`} aria-busy={closingWindowId === presentation.id}
            aria-disabled={closingWindowId === presentation.id}><WandIcon name="close" size={14}/></span>,
        }))}
        onChange={movingDir ? undefined : key => onSelectWindow?.(key)}
        onTabClick={movingDir ? key => onSelectWindow?.(key) : undefined}
        onEdit={(key, action) => { if (action === "remove" && typeof key === "string") onCloseWindow?.(key); }}/></WandUiBoundary>
      {!mobile || standalone ? <WandButton kind="ghost" type="button" className="workspace-tab-add"
        style={mobile ? { width: 44, height: 44, flexShrink: 0 } : undefined}
        title={standalone ? "在当前目录新建 Agent 或空白终端" : "新建 Agent 或空白终端（在同一 worktree）"}
        aria-label="新建 Agent 或空白终端" onClick={onNewSession}><WandIcon name="plus" size={18}/></WandButton> : null}
      {!standalone && !mobile && windows.length > 1 ? <>
        <WandButton kind="ghost" type="button" className={classNames("workspace-tab-move", movingDir === "h" && "active")}
          title="把当前终端移入另一个工作窗口并左右分屏" aria-label="移动终端并左右分屏" aria-pressed={movingDir === "h"}
          onClick={() => onToggleMove?.("h")}><WandIcon name="splitHorizontal" size={18}/></WandButton>
        <WandButton kind="ghost" type="button" className={classNames("workspace-tab-move", movingDir === "v" && "active")}
          title="把当前终端移入另一个工作窗口并上下分屏" aria-label="移动终端并上下分屏" aria-pressed={movingDir === "v"}
          onClick={() => onToggleMove?.("v")}><WandIcon name="splitVertical" size={18}/></WandButton>
      </> : null}
    </Flex>
    {movingDir ? <WandButton kind="ghost" type="button" className="workspace-tab-move-hint" title="取消移动" onClick={onCancelMove}>
      选择目标窗口 · Esc 取消
    </WandButton> : null}
    {actions ?? (standalone ? null : mobile ? <WorkspaceMoreButton/> : <WorkspaceDesktopActionsChrome/>)}
  </Flex>;
}

/** Native first window with no store subscriptions, requests or business actions. */
export function FirstWorkspaceWindowChrome({ mobile, taskName, session }: {
  mobile: boolean;
  taskName: string;
  session: WorkspaceSessionSummary;
}) {
  return <WorkspaceTabBarChrome mobile={mobile} taskName={taskName} activeWindowId={session.id}
    windows={[{ id: session.id, label: listSessionLabel(session, 0), status: session.status, count: 1, session }]}/>;
}

/** The same row appears before and after the first ungrouped PTY is created. */
export function FirstStandaloneSessionChrome({ mobile, session }: {
  mobile: boolean;
  session: WorkspaceSessionSummary;
}) {
  return <WorkspaceTabBarChrome mobile={mobile} variant="standalone" taskName="" activeWindowId={session.id}
    windows={[{ id: session.id, label: listSessionLabel(session, 0), status: session.status, count: 1, session }]}/>;
}
