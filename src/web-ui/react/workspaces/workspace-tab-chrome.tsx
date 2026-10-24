import * as React from "react";
import { Badge, ConfigProvider, Flex, Tabs } from "antd";
import { WandUiBoundary } from "../theme";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
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
  readonly titleGenerating?: boolean;
}

function StatusDot({ status }: { status?: string }) {
  const running = status === "running" || status === "thinking";
  const label = status === "waiting-input" ? "等待输入" : status === "failed" ? "失败" : running ? "运行中"
    : status === "stopped" || status === "exited" ? "已结束" : "空闲";
  if (!running && status !== "failed" && status !== "waiting-input") return <span className="workbar-accessible-title">{label}</span>;
  return <span aria-label={label} title={label}><Badge status={status === "failed" ? "error" : running ? "processing" : "warning"}
    className={classNames("workspace-tab-dot", running ? "running" : "idle")} aria-hidden/></span>;
}

export function WorkspaceMoreButton({ className, ...props }: Omit<WandButtonProps, "children"> = {}) {
  return <WandButton kind="ghost" aria-label="工作窗口操作" title="工作窗口操作" {...props}
    className={classNames("workspace-tab-more", className)}><WandIcon name="more" size={18}/></WandButton>;
}

/** Static action geometry for first-window measurement; live controllers supply their action owner. */
export function WorkspaceDesktopActionsChrome({ children, onClose }: {
  children?: React.ReactNode; onClose?: () => void;
}) {
  return <div className="workbar-actions">{children}
    <WandButton kind="ghost" aria-label="打开终端"><WandIcon name="terminal" size={18}/></WandButton>
    <WorkspaceMoreButton onClick={onClose}/>
  </div>;
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
  readonly onCancelMove?: () => void;
  readonly leading?: React.ReactNode;
  readonly actions?: React.ReactNode;
}

/** One non-wrapping row, also used by the synchronous first-PTY geometry probe. */
export function WorkspaceTabBarChrome({ mobile, taskName, variant = "task", activeWindowId, windows, movingDir, closingWindowId,
  onSelectWindow, onCloseWindow, onNewSession, onCancelMove, leading, actions }: WorkspaceTabBarChromeProps) {
  const standalone = variant === "standalone";
  const active = windows.find(window => window.id === activeWindowId);
  return <Flex align="center" gap={8} className="workspace-tab-bar" data-session-tabs={variant}>
    <h1 className="workbar-accessible-title">{active?.label || taskName || "工作窗口"}</h1>
    {leading}
    <Flex align="center" gap={8} className="workspace-tab-bar-list">
      <WandUiBoundary><ConfigProvider theme={{ components: { Tabs: { cardBg: "transparent", cardPadding: "6px 10px", itemSelectedColor: "var(--text-link)", itemActiveColor: "var(--text-link)", itemHoverColor: "var(--text-link)" } } }}><Tabs className="wand-workspace-tabs" type="editable-card" hideAdd tabBarStyle={{ marginBottom: 0 }} style={{ flex: 1, minWidth: 0 }}
        aria-label={standalone ? "未分组会话标签" : `任务 ${taskName} 的工作窗口标签`} activeKey={activeWindowId ?? undefined}
        items={windows.map(presentation => ({
          key: presentation.id,
          closable: standalone || !mobile,
          label: <span className={classNames("wand-workspace-tab-label",
            movingDir && !presentation.containsMoving && "move-target", presentation.containsMoving && "moving-source")}
            title={movingDir && !presentation.containsMoving ? `把当前终端移入「${presentation.label}」`
              : `${presentation.label}${presentation.count > 1 ? "（分屏工作窗口）" : ""}${presentation.titleGenerating ? " · AI 正在生成标题" : ""}`}>
            <StatusDot status={presentation.status}/>
            {presentation.session ? <SessionProviderMark session={presentation.session} className="workspace-tab-logo"/> : null}
            <span className={presentation.titleGenerating ? "title-generating" : undefined} aria-busy={presentation.titleGenerating || undefined}>{presentation.label}</span>
          </span>,
          closeIcon: <span title={standalone ? "关闭并删除会话" : "关闭工作窗口（将结束并删除其中会话）"}
            aria-label={`${standalone ? "关闭并删除会话" : "关闭工作窗口"} ${presentation.label}`} aria-busy={closingWindowId === presentation.id}
            aria-disabled={closingWindowId !== null && closingWindowId !== undefined}><WandIcon name="close" size={12}/></span>,
        }))}
        onChange={movingDir ? undefined : key => onSelectWindow?.(key)}
        onTabClick={movingDir ? key => onSelectWindow?.(key) : undefined}
        onEdit={(key, action) => { if (action === "remove" && typeof key === "string" && !closingWindowId) onCloseWindow?.(key); }}/></ConfigProvider></WandUiBoundary>
      <WandButton kind="ghost" type="button" className="workspace-tab-add"
        title={standalone ? "在当前目录新建 Agent 或空白终端" : "新建 Agent 或空白终端（在同一 worktree）"}
        aria-label="新建 Agent 或空白终端" onClick={onNewSession}><WandIcon name="plus" size={18}/></WandButton>
    </Flex>
    <div className="workbar-spacer"/>
    {movingDir ? <WandButton kind="ghost" className="workspace-tab-move-hint" title="选择目标窗口 · Esc 取消" onClick={onCancelMove}>
      <WandIcon name="close" size={14}/><span>选择目标 · Esc 取消</span>
    </WandButton> : null}
    {actions ?? <WorkspaceDesktopActionsChrome/>}
  </Flex>;
}

export function FirstWorkspaceWindowChrome({ mobile, taskName, session }: {
  mobile: boolean; taskName: string; session: WorkspaceSessionSummary;
}) {
  return <WorkspaceTabBarChrome mobile={mobile} taskName={taskName} activeWindowId={session.id}
    windows={[{ id: session.id, label: listSessionLabel(session, 0), status: session.status, count: 1, session }]}/>;
}

export function FirstStandaloneSessionChrome({ mobile, session }: { mobile: boolean; session: WorkspaceSessionSummary }) {
  return <WorkspaceTabBarChrome mobile={mobile} variant="standalone" taskName="" activeWindowId={session.id}
    windows={[{ id: session.id, label: listSessionLabel(session, 0), status: session.status, count: 1, session }]}/>;
}
