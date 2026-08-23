import * as React from "react";

/**
 * Shell / 任务树 / 顶栏共用的线性图标。
 * 名字即语义：folder 是文件夹，gear 是齿轮，branch 只表示 git 分支 / worktree。
 */
export type WandIconName =
  | "audio"
  | "back"
  | "binary"
  | "branch"
  | "chat"
  | "check"
  | "chevron"
  | "chevronLeft"
  | "circle"
  | "clipboard"
  | "close"
  | "copy"
  | "download"
  | "edit"
  | "explorer"
  | "eye"
  | "file"
  | "folder"
  | "gear"
  | "git"
  | "hash"
  | "history"
  | "home"
  | "image"
  | "info"
  | "logout"
  | "markdown"
  | "merge"
  | "more"
  | "parallel"
  | "pdf"
  | "plus"
  | "question"
  | "rail"
  | "refresh"
  | "resume"
  | "server"
  | "spark"
  | "sparkle"
  | "task"
  | "terminal"
  | "trash"
  | "up"
  | "video"
  | "warning"
  | "zap";

export function workspaceTaskIconName(isolated: boolean): "branch" | "task" {
  return isolated ? "branch" : "task";
}

export function WandIcon({
  name,
  size = 14,
  className,
  strokeWidth = 2,
}: {
  name: WandIconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}): React.ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
    "data-icon": name,
  };

  switch (name) {
    case "audio":
      return <svg {...common}><path d="M9 18V5l11-2v13"/><circle cx="7" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>;
    case "back":
      return <svg {...common}><rect x="9" y="3" width="12" height="18" rx="2"/><path d="M15 18h.01"/><path d="M6 8L2 12l4 4M2 12h8"/></svg>;
    case "binary":
      return <svg {...common}><path d="M12 3l8 9-8 9-8-9 8-9z"/></svg>;
    case "branch":
      return <svg {...common}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 2.5-6 6.5"/></svg>;
    case "chat":
      return <svg {...common}><path d="M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 5z"/></svg>;
    case "check":
      return <svg {...common}><path d="M20 6L9 17l-5-5"/></svg>;
    case "chevron":
      return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "chevronLeft":
      return <svg {...common}><path d="M15 6l-6 6 6 6"/></svg>;
    case "circle":
      return <svg {...common}><circle cx="12" cy="12" r="7"/></svg>;
    case "clipboard":
      return <svg {...common}><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h2"/></svg>;
    case "close":
      return <svg {...common}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case "copy":
      return <svg {...common}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>;
    case "download":
      return <svg {...common}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>;
    case "edit":
      return <svg {...common}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4z"/></svg>;
    case "explorer":
      return <svg {...common}><path d="M8 3h7l4 4v11a2 2 0 01-2 2H8a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M15 3v4h4"/><path d="M3 9h7l2 2v8a1 1 0 01-1 1H4a1 1 0 01-1-1z"/></svg>;
    case "eye":
      return <svg {...common}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "file":
      return <svg {...common}><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/></svg>;
    case "folder":
      return <svg {...common}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3"/>
          <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/>
        </svg>
      );
    case "git":
      return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6"/></svg>;
    case "hash":
      return <svg {...common}><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></svg>;
    case "history":
      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>;
    case "home":
      return <svg {...common}><path d="M4 11l8-7 8 7v9a2 2 0 01-2 2h-4v-7H10v7H6a2 2 0 01-2-2z"/></svg>;
    case "image":
      return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/></svg>;
    case "info":
      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>;
    case "logout":
      return <svg {...common}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
    case "markdown":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15V9l3 4 3-4v6"/></svg>;
    case "merge":
      return <svg {...common}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M8.5 18H15.5M8.5 6c6 0 7.5 5 7.5 9.5"/></svg>;
    case "more":
      return <svg {...common}><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>;
    case "parallel":
      return <svg {...common}><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>;
    case "pdf":
      return <svg {...common}><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h5M8 17h8"/></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "question":
      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.5 2.5 0 113.5 2.3c-.9.4-1.3 1-1.3 2.2M12 17h.01"/></svg>;
    case "rail":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16"/><path d="M11 8h6M11 12h6M11 16h4"/></svg>;
    case "refresh":
      return <svg {...common}><path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 3v6h-6"/></svg>;
    case "resume":
      return <svg {...common}><path d="M1 4v6h6M3.5 15A9 9 0 109 3.6L3 10"/></svg>;
    case "server":
      return <svg {...common}><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>;
    case "spark":
      return <svg {...common}><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/></svg>;
    case "sparkle":
      return <svg {...common}><path d="M12 3l1.3 3.8L17 8.1l-3.7 1.3L12 13l-1.3-3.6L7 8.1l3.7-1.3L12 3z"/><path d="M18 13l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/></svg>;
    case "task":
      return <svg {...common}><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>;
    case "terminal":
      return <svg {...common}><rect x="2.5" y="3.5" width="19" height="17" rx="3"/><path d="m5 7 5 5-5 5M12 17h7"/></svg>;
    case "trash":
      return <svg {...common}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>;
    case "up":
      return <svg {...common}><path d="M12 19V5M5 12l7-7 7 7"/></svg>;
    case "video":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>;
    case "warning":
      return <svg {...common}><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>;
    case "zap":
      return <svg {...common}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>;
  }
}
