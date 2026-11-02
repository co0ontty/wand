import * as React from "react";
import { classNames } from "../ui/class-names";

export type TaskExecutionVisualStatus = "running" | "completed" | "failed" | "queued" | "attention";

export interface TaskStatusGlyphProps {
  status: TaskExecutionVisualStatus;
  size?: number;
  className?: string;
  title?: string;
  ariaLabel?: string;
}

/**
 * 菜单栏任务状态专用动效图标（A, B, B, B 组合）：
 * - running: 方案 A（圆圈延伸填满 + 顺滑擦除消失，带 Track 底轨）
 * - completed: 方案 B（浅绿弹性果冻软徽章）
 * - failed: 方案 B（轻度横向微震颤错号）
 * - queued: 方案 B（微型小时钟步进跳格走动）
 * - attention: 等你处理（等待授权、等待回答、重连中）；琥珀色感叹徽章持续呼吸，不是失败
 */
export function TaskStatusGlyph({
  status,
  size = 15,
  className,
  title,
  ariaLabel,
}: TaskStatusGlyphProps): React.ReactElement {
  if (status === "running") {
    return (
      <span
        className={classNames("wand-status-glyph-wrap", className)}
        style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        title={title}
        role="img"
        aria-label={ariaLabel || "运行中"}
      >
        <svg
          className="wand-status-glyph is-running"
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle className="task-status-track" cx="8" cy="8" r="6" strokeWidth="1.75" />
          <circle className="task-status-fill" cx="8" cy="8" r="6" strokeWidth="1.75" />
        </svg>
      </span>
    );
  }

  if (status === "completed") {
    return (
      <span
        className={classNames("wand-status-glyph-wrap", className)}
        style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        title={title}
        role="img"
        aria-label={ariaLabel || "已完成"}
      >
        <span
          className="wand-status-glyph is-completed"
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          <svg
            width={Math.round(size * 0.65)}
            height={Math.round(size * 0.65)}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />
          </svg>
        </span>
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span
        className={classNames("wand-status-glyph-wrap", className)}
        style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        title={title}
        role="img"
        aria-label={ariaLabel || "失败"}
      >
        <span
          className="wand-status-glyph is-failed"
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          <svg
            width={Math.round(size * 0.6)}
            height={Math.round(size * 0.6)}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" />
          </svg>
        </span>
      </span>
    );
  }

  if (status === "attention") {
    return (
      <span
        className={classNames("wand-status-glyph-wrap", className)}
        style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        title={title}
        role="img"
        aria-label={ariaLabel || "等你处理"}
      >
        <span
          className="wand-status-glyph is-attention"
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          <svg
            width={Math.round(size * 0.62)}
            height={Math.round(size * 0.62)}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M8 3.2 V8.8" />
            <circle cx="8" cy="12.4" r="1.2" fill="currentColor" stroke="none" />
          </svg>
        </span>
      </span>
    );
  }

  return (
    <span
      className={classNames("wand-status-glyph-wrap", className)}
      style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
      title={title}
      role="img"
      aria-label={ariaLabel || "排队中"}
    >
      <svg
        className="wand-status-glyph is-queued"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" strokeWidth="1.5" />
        <line x1="8" y1="8" x2="8" y2="4.5" strokeWidth="1.5" strokeLinecap="round" />
        <line className="task-status-minute-hand" x1="8" y1="8" x2="10.8" y2="8" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}
