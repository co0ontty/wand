import * as React from "react";

/**
 * Shell / 任务树 / 顶栏共用的线性图标。
 * 名字即语义：folder 是文件夹，gear 是齿轮，branch 只表示 git 分支 / worktree。
 */
export type WandIconName =
  | "archive"
  | "audio"
  | "back"
  | "bell"
  | "binary"
  | "board"
  | "brain"
  | "branch"
  | "chat"
  | "check"
  | "chevron"
  | "chevronDown"
  | "chevronLeft"
  | "chevronUp"
  | "circle"
  | "clipboard"
  | "close"
  | "copy"
  | "cpu"
  | "download"
  | "edit"
  | "enter"
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
  | "keyboard"
  | "lock"
  | "logout"
  | "markdown"
  | "merge"
  | "mic"
  | "milestone"
  | "pin"
  | "more"
  | "paperclip"
  | "parallel"
  | "pdf"
  | "plus"
  | "question"
  | "rail"
  | "refresh"
  | "resume"
  | "search"
  | "server"
  | "shield"
  | "shieldCheck"
  | "sigma"
  | "sliders"
  | "spark"
  | "sparkle"
  | "splitHorizontal"
  | "splitVertical"
  | "stop"
  | "task"
  | "terminal"
  | "trash"
  | "unlock"
  | "user"
  | "users"
  | "up"
  | "video"
  | "warning"
  | "wrench"
  | "zap";

export function workspaceTaskIconName(isolated: boolean): "branch" | "task" {
  return isolated ? "branch" : "task";
}

/** Stable icon metadata. `slot` identifies an optional leading/trailing
 * adornment; `data-wand-icon` always retains the real icon identity. Existing
 * consumers can continue styling `data-icon` without coupling to a library. */
export type WandIconSlot = "start" | "end";

export function WandIcon({
  name,
  size = 14,
  className,
  strokeWidth = 1.8,
  slot,
}: {
  name: WandIconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  slot?: WandIconSlot;
}): React.ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    // Explicit dimensions keep legacy host styles from resizing icon adornments.
    style: { width: size, height: size, strokeWidth },
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
    "data-wand-icon": name,
    "data-icon": slot ?? name,
  };

  switch (name) {
    case "archive":
      return <svg {...common}><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>;
    case "audio":
      return <svg {...common}><path d="M9 18V5l11-2v13"/><circle cx="7" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>;
    case "back":
      return <svg {...common}><rect x="9" y="3" width="12" height="18" rx="2"/><path d="M15 18h.01"/><path d="M6 8L2 12l4 4M2 12h8"/></svg>;
    case "bell":
      return <svg {...common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>;
    case "user":
      return <svg {...common}><circle cx="12" cy="7.5" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/></svg>;
    case "users":
      return <svg {...common}><circle cx="9" cy="7.5" r="3"/><path d="M3.5 20v-1a5.5 5.5 0 0 1 11 0v1M16 5a3 3 0 0 1 0 5.5M20.5 20v-1a5.5 5.5 0 0 0-3.5-5.1"/></svg>;
    case "binary":
      return <svg {...common}><path d="M12 3l8 9-8 9-8-9 8-9z"/></svg>;
    case "board":
      return <svg {...common}><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M12 4v16M7 8v4M16.5 8v7"/></svg>;
    case "brain":
      return <svg {...common}><path d="M12 5a3 3 0 0 0-5.8 1A4 4 0 0 0 4 13a4 4 0 0 0 8 5V5Zm0 0a3 3 0 0 1 5.8 1A4 4 0 0 1 20 13a4 4 0 0 1-8 5M8 10l4 2 4-2"/></svg>;
    case "branch":
      return <svg {...common}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 2.5-6 6.5"/></svg>;
    case "chat":
      return <svg {...common}><path d="M5.5 4h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5.5 3V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8"/></svg>;
    case "check":
      return <svg {...common}><path d="M20 6L9 17l-5-5"/></svg>;
    case "chevron":
      return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "chevronDown":
      return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "chevronUp":
      return <svg {...common}><path d="M6 15l6-6 6 6"/></svg>;
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
    case "cpu":
      return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4" rx=".5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/></svg>;
    case "download":
      return <svg {...common}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>;
    case "edit":
      return <svg {...common}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4z"/></svg>;
    case "enter":
      return <svg {...common}><path d="M9 10l-5 5 5 5"/><path d="M4 15h11a5 5 0 005-5V4"/></svg>;
    case "explorer":
      return <svg {...common}><path d="M14 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9L14 3.5ZM14 3.5V9h5.5M8.5 13h7M8.5 16.5h5"/></svg>;
    case "eye":
      return <svg {...common}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "file":
      return <svg {...common}><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/></svg>;
    case "folder":
      return <svg {...common}><path d="M20.5 18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2H10l2 3h6.5a2 2 0 0 1 2 2v9Z"/></svg>;
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>
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
    case "keyboard":
      return <svg {...common}><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>;
    case "lock":
      return <svg {...common}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2"/></svg>;
    case "unlock":
      return <svg {...common}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.2M12 15v2"/></svg>;
    case "logout":
      return <svg {...common}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
    case "markdown":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15V9l3 4 3-4v6"/></svg>;
    case "merge":
      return <svg {...common}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M8.5 18H15.5M8.5 6c6 0 7.5 5 7.5 9.5"/></svg>;
    case "mic":
      return <svg {...common}><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>;
    case "milestone":
      return <svg {...common}><path d="M5 21V4"/><path d="M5 5h11l-1.6 3.5L16 12H5z"/></svg>;
    case "pin":
      return <svg {...common}><path d="m9 3 6 0-1 5 4 4v2h-5v7l-1-2-1 2v-7H6v-2l4-4z"/></svg>;
    case "more":
      return <svg {...common}><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>;
    case "paperclip":
      return <svg {...common}><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.84-8.84a4 4 0 1 1 5.66 5.66L9.41 17.41a2 2 0 1 1-2.83-2.83l8.84-8.83"/></svg>;
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
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>;
    case "server":
      return <svg {...common}><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>;
    case "shield":
      return <svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case "shieldCheck":
      return <svg {...common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>;
    case "sigma":
      return <svg {...common}><path d="M18 4H6l7 8-7 8h12"/></svg>;
    case "sliders":
      return <svg {...common}><path d="M4 7h10M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2M10 17h10"/><circle cx="8" cy="17" r="2"/></svg>;
    case "spark":
      return <svg {...common}><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/></svg>;
    case "sparkle":
      return <svg {...common}><path d="M12 3l1.3 3.8L17 8.1l-3.7 1.3L12 13l-1.3-3.6L7 8.1l3.7-1.3L12 3z"/><path d="M18 13l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/></svg>;
    case "splitHorizontal":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6 9l3 3-3 3M18 9l-3 3 3 3"/></svg>;
    case "splitVertical":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18M9 7l3 3 3-3M9 17l3-3 3 3"/></svg>;
    case "stop":
      return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>;
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
    case "wrench":
      return <svg {...common}><path d="M14.7 6.3a4 4 0 1 1 4 4l-9 9-3.5 1 1-3.5 7.5-7.5z"/></svg>;
    case "zap":
      return <svg {...common}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>;
  }
}
