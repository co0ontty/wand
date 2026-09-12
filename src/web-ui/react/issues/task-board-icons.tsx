import * as React from "react";
import type { WandTaskPriority, WandTaskStatus } from "../../../task-types";

interface GlyphProps {
  size?: number;
  color?: string;
  className?: string;
  title?: string;
}

function svgProps({ size = 16, color = "currentColor", className, title }: GlyphProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    className,
    "aria-hidden": title ? undefined : true,
    role: title ? "img" : undefined,
    color,
    style: { color, flex: "0 0 auto" } as React.CSSProperties,
  };
}

export function TaskBoardStatusIcon({
  status,
  size = 14,
  color = "currentColor",
  className,
}: GlyphProps & { status: WandTaskStatus }): React.ReactElement {
  const props = svgProps({ size, color, className });
  if (status === "doing") {
    return <svg {...props}>
      <path d="M8 1.83C3.38 1.83 1.83 3.38 1.83 8s1.55 6.17 6.17 6.17S14.17 12.62 14.17 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path fillRule="evenodd" d="M13.02 2.87c-.66-.59-1.67-.53-2.26.14s-2.91 3.29-3.92 4.43c-1.01 1.14-.27 2.72-.27 2.72s1.67.53 2.67-.6 3.92-4.43 3.92-4.43c.59-.66.52-1.67-.14-2.26Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m10.01 3.87 2.4 2.12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>;
  }
  if (status === "done") {
    return <svg {...props} viewBox="0 0 13.836 11.236">
      <path fillRule="evenodd" d="M9.026 5.618a2.108 2.108 0 1 1-4.216 0 2.108 2.108 0 0 1 4.216 0Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path fillRule="evenodd" d="M.75 5.618c0 2.187 2.761 4.868 6.168 4.868s6.168-2.679 6.168-4.868S10.324.75 6.918.75.75 3.431.75 5.618Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>;
  }
  return <svg {...props}>
    <path d="M13.16 11.5H8.84" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path fillRule="evenodd" d="M2.84 11.5c0 1.36.46 1.81 1.82 1.81s1.81-.45 1.81-1.81-.45-1.81-1.81-1.81-1.82.45-1.82 1.81Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8.84 4.5h4.32" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path fillRule="evenodd" d="M6.47 4.5c0-1.36-.45-1.81-1.81-1.81S2.84 3.14 2.84 4.5s.46 1.81 1.82 1.81 1.81-.45 1.81-1.81Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

export function TaskBoardPriorityIcon({
  priority,
  size = 14,
  color = "currentColor",
  className,
}: GlyphProps & { priority: WandTaskPriority }): React.ReactElement {
  const props = svgProps({ size, color, className });
  if (priority === "urgent") {
    return <svg {...props}>
      <path fill="currentColor" d="M8 1a7 7 0 1 0 .00 14A7 7 0 0 0 8 1Zm-1 3h2l-.25 5H7.25L7 4Zm2 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
    </svg>;
  }
  const bars = (
    <>
      <path fill="currentColor" d="M3.5 8h-1A.5.5 0 0 0 2 8.5v4a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-4A.5.5 0 0 0 3.5 8Z"/>
      <path fill="currentColor" fillOpacity={priority === "low" || priority === "none" ? 0.4 : 1} d="M8.5 5h-1A.5.5 0 0 0 7 5.5v7.5a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5V5.5A.5.5 0 0 0 8.5 5Z"/>
      <path fill="currentColor" fillOpacity={priority === "high" ? 1 : 0.4} d="M13.5 2h-1a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5Z"/>
    </>
  );
  if (priority === "none") {
    return <svg {...props}>
      <path fill="currentColor" opacity="0.9" d="M4 7.25H2a.25.25 0 0 0-.25.25v.5c0 .14.11.25.25.25h2a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25Z"/>
      <path fill="currentColor" opacity="0.9" d="M9 7.25H7a.25.25 0 0 0-.25.25v.5c0 .14.11.25.25.25h2a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25Z"/>
      <path fill="currentColor" opacity="0.9" d="M14 7.25h-2a.25.25 0 0 0-.25.25v.5c0 .14.11.25.25.25h2a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25Z"/>
    </svg>;
  }
  return <svg {...props}>{bars}</svg>;
}

export function TaskBoardFilterIcon({ size = 14, color = "currentColor", className }: GlyphProps): React.ReactElement {
  return <svg {...svgProps({ size, color, className })} viewBox="0 0 14 14">
    <path fill="currentColor" fillRule="evenodd" d="M12.47 2.63a.66.66 0 0 1 .66.65.66.66 0 0 1-.66.66H1.53a.66.66 0 1 1 0-1.31h10.94ZM3.5 7c0-.17.07-.34.19-.46.12-.13.29-.2.47-.2h5.68c.17 0 .34.07.47.2.12.12.19.29.19.46s-.07.34-.19.46c-.13.13-.3.2-.47.2H4.16a.66.66 0 0 1-.66-.66Zm2.41 3.06a.66.66 0 0 0 0 1.31h2.18a.66.66 0 1 0 0-1.31H5.91Z"/>
  </svg>;
}

export function TaskBoardPanelIcon({ size = 16, color = "currentColor", className }: GlyphProps): React.ReactElement {
  return <svg {...svgProps({ size, color, className })}>
    <path fill="currentColor" fillRule="evenodd" d="M4.25 2A3.25 3.25 0 0 0 1 5.25v5.5A3.25 3.25 0 0 0 4.25 14h7.5A3.25 3.25 0 0 0 15 10.75v-5.5A3.25 3.25 0 0 0 11.75 2H4.25ZM2.5 5.5A2 2 0 0 1 4.5 3.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-5Z"/>
    <path fill="currentColor" d="M11.5 5.75a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5Z"/>
  </svg>;
}

export function TaskBoardConversationIcon({ size = 16, color = "currentColor", className }: GlyphProps): React.ReactElement {
  return <svg {...svgProps({ size, color, className })}>
    <path d="M8 12.5c2.76 0 5-2.02 5-4.5S10.76 3.5 8 3.5 3 5.51 3 8c0 .9.29 1.73.79 2.43-.08.71-.29 1.39-.56 2.07A11.4 11.4 0 0 0 5.76 12c.67.3 1.43.5 2.24.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>;
}

export function TaskBoardSearchIcon({ size = 14, color = "currentColor", className }: GlyphProps): React.ReactElement {
  return <svg {...svgProps({ size, color, className })} viewBox="0 0 14 14">
    <path fill="currentColor" fillRule="evenodd" d="M6.13 1.75a4.38 4.38 0 0 1 3.52 6.97l2.41 2.41.05.05a.66.66 0 0 1-.93.93l-.05-.05-2.41-2.41A4.38 4.38 0 1 1 6.13 1.75Zm0 1.31a3.06 3.06 0 1 0 0 6.13 3.06 3.06 0 0 0 0-6.13Z"/>
  </svg>;
}

export function TaskBoardFolderIcon({ size = 12, color = "currentColor", className }: GlyphProps): React.ReactElement {
  return <svg {...svgProps({ size, color, className })}>
    <path d="M2 8v3.5A1.5 1.5 0 0 0 3.5 13h8a1.5 1.5 0 0 0 1.5-1.5V8M2 8V4.5A1.5 1.5 0 0 1 3.5 3h2c.63 0 1.22.3 1.6.8l.3.4c.38.5.97.8 1.6.8h2.5A1.5 1.5 0 0 1 14 6.5V8M2 8h12" stroke="currentColor" strokeWidth="1"/>
  </svg>;
}

export function TaskBoardDueIcon({ size = 12, color = "currentColor", className }: GlyphProps): React.ReactElement {
  return <svg {...svgProps({ size, color, className })}>
    <path fill="currentColor" fillRule="evenodd" d="M15 5a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v6a4 4 0 0 0 4 4h1.25a.75.75 0 0 0 0-1.5H5A2.5 2.5 0 0 1 2.5 11V6h11v.25a.75.75 0 0 0 1.5 0V5Zm-3.5 3a.75.75 0 0 1 .75.75v2h2a.75.75 0 0 1 0 1.5h-2v2a.75.75 0 0 1-1.5 0v-2h-2a.75.75 0 0 1 0-1.5h2v-2A.75.75 0 0 1 11.5 8Z"/>
  </svg>;
}

export function TaskBoardCompleteIcon({ size = 7, color = "#317CFF", className }: GlyphProps): React.ReactElement {
  return <svg {...svgProps({ size, color, className })} viewBox="0 0 7 6.03">
    <path d="M.5 3.73 1.76 5.35a.5.5 0 0 0 .72.01L6.5.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

export function TaskBoardProcessingGlyph({ className }: { className?: string }): React.ReactElement {
  return <span className={className ? `task-board-processing-glyph ${className}` : "task-board-processing-glyph"} aria-hidden="true">
    {Array.from({ length: 16 }, (_, index) => <i key={index} style={{ animationDelay: `${-150 * (index % 7)}ms` }}/>)}
  </span>;
}
