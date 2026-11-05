import { Flex, Typography } from "antd";
import { SidebarLabelTooltip } from "../workspaces/sidebar-label-tooltip";
import { WandButton } from "../ui/button";
import * as React from "react";
import { classNames } from "../ui/class-names";
import { glowVisualStatus, type GlowStatus, type SidebarSessionState } from "../workspaces/sidebar-session-state";
import { TaskStatusGlyph } from "../workspaces/task-status-glyph";

export interface ImSidebarItemProps {
  id: string;
  avatarNode?: React.ReactNode;
  title: string;
  titleGenerating?: boolean;
  state: SidebarSessionState;
  glow?: GlowStatus;
  summary: string | { identity?: string; workspace?: string; status: string };
  active?: boolean;
  onClick(): void;
}

export function ImSidebarItem({
  id, avatarNode, title, titleGenerating = false, state, glow, summary, active = false, onClick,
}: ImSidebarItemProps): React.ReactElement {
  const effectiveGlow: GlowStatus = glow ?? (
    state.label === "运行中" ? "running"
      : state.label === "思考中" ? "thinking"
      : state.label === "刚完成" ? "just-completed"
      : state.label === "排队中" ? "queued"
      : state.label === "失败" ? "failed"
      : state.tone === "warning" ? "permission"
      : "none"
  );
  const summaryText = typeof summary === "string" ? summary : [summary.identity, summary.workspace, summary.status].filter(Boolean).join(" · ");
  const visualStatus = glowVisualStatus(effectiveGlow);
  const descriptionId = React.useId();
  return (
    <SidebarLabelTooltip title={`${title} · ${summaryText}`} selector=".im-sidebar-item-name">
      <WandButton kind={active ? "soft" : "ghost"} type="button" className={`session-item wand-sidebar-session-row${active ? " active" : ""}`}
        style={{ width: "100%", height: "auto", whiteSpace: "normal", justifyContent: "flex-start", padding: "8px 10px" }}
        data-session-id={id} aria-current={active ? "page" : undefined}
        aria-describedby={descriptionId} title={`${title} · ${summaryText}`} onClick={onClick}>
        <Flex vertical style={{ minWidth: 0, textAlign: "start", flex: 1, gap: 3 }}>
          {/* 第一行：会话标题 + 卡片右侧运行状态动效图标 */}
          <Flex align="center" justify="space-between" gap={8} style={{ width: "100%", minWidth: 0 }}>
            <Typography.Text ellipsis className={classNames("im-sidebar-item-name", titleGenerating && "title-generating")}
              aria-busy={titleGenerating || undefined} aria-label={titleGenerating ? `${title}，AI 正在生成标题` : undefined}
              title={titleGenerating ? "AI 正在生成标题" : undefined}
              style={{ flex: 1, minWidth: 0, fontWeight: 500, fontSize: 13, lineHeight: "18px" }}>
              {title}
            </Typography.Text>
            {visualStatus ? (
              <span
                className="im-sidebar-item-status-mark"
                aria-hidden="true"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, flexShrink: 0 }}
              >
                <TaskStatusGlyph status={visualStatus} size={15} title={state.label} ariaLabel={state.label} />
              </span>
            ) : null}
          </Flex>

          {/* 第二行：开头显示 CLI 工具 Logo + 小字摘要 */}
          <Flex align="center" gap={5} style={{ width: "100%", minWidth: 0, fontSize: 11, lineHeight: "16px", color: "var(--text-secondary)" }}>
            {avatarNode ? (
              <span
                className={classNames(
                  "im-sidebar-item-provider-logo",
                  effectiveGlow !== "none" && `wand-logo-glow glow-${effectiveGlow}`,
                )}
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, opacity: 0.9 }}
                data-glow={effectiveGlow}
                aria-hidden="true"
              >
                {avatarNode}
              </span>
            ) : null}
            {typeof summary === "string" ? (
              <Typography.Text ellipsis type="secondary" id={descriptionId} title={summaryText} className="im-sidebar-item-summary" style={{ fontSize: 11, margin: 0, flex: 1, minWidth: 0 }}>
                {summaryText}
              </Typography.Text>
            ) : (
              <span id={descriptionId} title={summaryText} aria-label={summaryText} className="im-sidebar-item-summary" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
                {summary.identity ? <><span className="im-sidebar-item-identity" style={{ flex: "0 1 auto", maxWidth: summary.workspace ? "35%" : undefined, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{summary.identity}</span><span aria-hidden="true" style={{ flexShrink: 0 }}>·</span></> : null}
                {summary.workspace ? <><span className="im-sidebar-item-workspace" style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{summary.workspace}</span><span aria-hidden="true" style={{ flexShrink: 0 }}>·</span></> : null}
                <span className="im-sidebar-item-summary-status" style={{ flexShrink: 0 }}>{summary.status}</span>
              </span>
            )}
          </Flex>
        </Flex>
      </WandButton>
    </SidebarLabelTooltip>
  );
}
