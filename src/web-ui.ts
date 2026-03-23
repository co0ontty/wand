export function renderApp(configPath: string): string {
  var scriptClose = String.fromCharCode(60) + String.fromCharCode(47) + "script>";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Wand Console</title>
  <meta name="description" content="Local CLI Console for Vibe Coding - Manage terminal sessions from your browser" />
  <meta name="theme-color" content="#f6f1e8" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#1f1b17" media="(prefers-color-scheme: dark)" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Wand" />
  <link rel="apple-touch-icon" href="/icon-192.png" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="stylesheet" href="/vendor/xterm/css/xterm.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #f6f1e8;
      --bg-secondary: rgba(255, 251, 245, 0.88);
      --bg-tertiary: #f0e5d7;
      --bg-elevated: #fffaf2;
      --bg-terminal: #1f1b17;
      --border-subtle: rgba(150, 118, 85, 0.14);
      --border-default: rgba(125, 91, 57, 0.3);
      --text-primary: #2a1f16;
      --text-secondary: #5a4535;
      --text-muted: #8c735f;
      --accent: #c5653d;
      --accent-hover: #af5330;
      --accent-soft: #e8c5ae;
      --accent-muted: rgba(197, 101, 61, 0.12);
      --success: #4f7a58;
      --success-muted: rgba(79, 122, 88, 0.14);
      --warning: #a96a2f;
      --warning-muted: rgba(169, 106, 47, 0.14);
      --danger: #b24f45;
      --danger-muted: rgba(178, 79, 69, 0.14);
      --shadow-soft: 0 20px 50px rgba(89, 58, 32, 0.12);
      --shadow-elevated: 0 8px 24px rgba(89, 58, 32, 0.08);
      --radius-sm: 10px;
      --radius-md: 16px;
      --radius-lg: 24px;
      --font-sans: "Inter", "Helvetica Neue", "PingFang SC", "Noto Sans SC", sans-serif;
      --font-mono: "Geist Mono", "SF Mono", "Fira Code", monospace;
      --transition-fast: 0.15s ease;
      --transition-normal: 0.25s ease;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html {
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
      min-height: 100%;
      height: 100%;
    }

    body {
      font-family: var(--font-sans);
      background:
        radial-gradient(circle at top left, rgba(208, 138, 92, 0.22), transparent 28%),
        radial-gradient(circle at bottom right, rgba(148, 107, 74, 0.12), transparent 32%),
        linear-gradient(180deg, #fbf7f1 0%, #f6f1e8 100%);
      color: var(--text-primary);
      min-height: 100vh;
      min-height: 100dvh;
      line-height: 1.5;
      overflow: hidden;
    }

    .app-container {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      min-height: 100dvh;
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
    }

    .topbar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 14px;
      min-height: 68px;
      padding: 12px 18px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-subtle);
      backdrop-filter: blur(18px);
      flex-shrink: 0;
    }

    .topbar-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .topbar-actions { display: flex; align-items: center; gap: 8px; }
    .logo-wrap { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .logo { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 1rem; }
    .logo-icon {
      width: 28px; height: 28px;
      background: linear-gradient(135deg, #d77a52 0%, #a95130 100%);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
      font-size: 12px; color: white; font-weight: 700;
    }

    .brand-meta {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }

    .brand-name {
      font-size: 0.98rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .brand-subtitle {
      font-size: 0.6875rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-badge {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px;
      background: rgba(255, 247, 239, 0.95);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
    .status-dot.active { background: var(--success); box-shadow: 0 0 8px var(--success); }

    .topbar-center {
      min-width: 0;
      display: flex;
      justify-content: center;
    }

    .session-summary {
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      text-align: center;
    }

    .session-summary-label {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }

    .session-summary-value {
      max-width: min(52vw, 560px);
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .topbar-right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .config-path {
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
      padding: 6px 10px;
      background: rgba(255, 247, 239, 0.95);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }

    .protocol-note {
      font-size: 0.6875rem;
      color: var(--warning);
      background: rgba(255, 244, 230, 0.92);
      border: 1px solid rgba(169, 106, 47, 0.18);
      border-radius: 999px;
      padding: 6px 10px;
      white-space: nowrap;
    }

    .main-layout {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      padding-left: 320px;
      transition: padding-left var(--transition-normal);
    }
    .main-layout:not(.sidebar-open) {
      padding-left: 0;
    }

    .drawer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 24;
      background: rgba(42, 28, 18, 0.26);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--transition-normal);
    }

    .drawer-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }

    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 25;
      width: min(320px, calc(100vw - 24px));
      background: rgba(255, 251, 245, 0.94);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      min-height: 0;
      backdrop-filter: blur(18px);
      box-shadow: 24px 0 56px rgba(89, 58, 32, 0.14);
      transform: translateX(-100%);
      transition: transform var(--transition-normal);
    }

    .sidebar.open {
      transform: translateX(0);
    }

    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(255, 251, 245, 0.6);
    }

    .sidebar-header-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .sidebar-title {
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .session-count {
      font-size: 0.6875rem;
      color: var(--text-muted);
      background: rgba(240, 229, 215, 0.9);
      padding: 3px 8px;
      border-radius: var(--radius-sm);
    }

    .sidebar-close { flex-shrink: 0; }

    .sidebar-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(255, 251, 245, 0.6);
      padding: 0 16px;
    }

    .sidebar-tab {
      padding: 10px 12px;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: color var(--transition-fast), border-color var(--transition-fast);
      margin-bottom: -1px;
    }

    .sidebar-tab:hover { color: var(--text-secondary); }
    .sidebar-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    .sidebar-tab-icon { margin-right: 4px; }

    .file-explorer { flex: 1; overflow-y: auto; padding: 8px 0; }
    .file-explorer.empty {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: var(--text-muted);
      font-size: 0.8125rem;
      text-align: center;
    }

    .file-tree { font-size: 0.8125rem; }

    .tree-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 12px;
      cursor: pointer;
      border-radius: 6px;
      transition: background var(--transition-fast);
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tree-item:hover { background: var(--bg-tertiary); }
    .tree-item.active { background: var(--accent-muted); color: var(--accent); }

    .tree-toggle {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.625rem;
      color: var(--text-muted);
      transition: transform var(--transition-fast);
    }

    .tree-toggle.open { transform: rotate(90deg); }
    .tree-toggle.empty { visibility: hidden; }

    .tree-icon { flex-shrink: 0; font-size: 0.875rem; }
    .tree-name { overflow: hidden; text-overflow: ellipsis; }

    .tree-children { display: none; }
    .tree-children.open { display: block; }

    .file-explorer-header {
      padding: 6px 12px 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .file-explorer-path {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-explorer-actions { display: flex; gap: 4px; margin-left: auto; }

    .file-explorer-refresh {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 0.875rem;
      padding: 2px 4px;
      border-radius: 4px;
      color: var(--text-muted);
    }

    .file-explorer-refresh:hover { background: var(--bg-tertiary); color: var(--text-secondary); }

    .sidebar-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    .sidebar-intro {
      padding: 14px 18px 0;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .sessions-list { flex: 1; overflow-y: auto; padding: 12px; }
    .session-group { margin-bottom: 18px; }
    .session-group:last-child { margin-bottom: 0; }
    .session-group-title {
      padding: 4px 6px 10px;
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .session-item {
      width: 100%;
      text-align: left;
      background: rgba(255, 250, 244, 0.72);
      border: 1px solid rgba(150, 118, 85, 0.12);
      border-radius: var(--radius-lg);
      color: var(--text-primary);
      padding: 12px 14px;
      cursor: pointer;
      transition: all var(--transition-fast);
      font-family: var(--font-sans);
      margin-bottom: 8px;
      box-shadow: 0 4px 12px rgba(89, 58, 32, 0.04);
    }

    .session-item-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .session-main {
      min-width: 0;
      flex: 1;
    }

    .session-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .session-action-btn {
      width: 28px;
      height: 28px;
      min-height: 28px;
      padding: 0;
      border-radius: 999px;
    }

    .session-item:hover { background: rgba(255, 248, 240, 0.96); border-color: var(--accent-soft); transform: translateY(-2px); box-shadow: 0 8px 20px rgba(89, 58, 32, 0.08); }
    .session-item.active { background: linear-gradient(180deg, rgba(241, 214, 194, 0.66), rgba(255, 247, 239, 0.96)); border-color: rgba(197, 101, 61, 0.42); }

    .session-command {
      font-weight: 500;
      font-size: 0.8125rem;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--font-mono);
    }

    .session-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.6875rem;
      color: var(--text-muted);
      flex-wrap: wrap;
    }

    .session-status {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-weight: 500;
    }

    .session-status.running { background: var(--success-muted); color: var(--success); }
    .session-status.exited { background: var(--bg-tertiary); color: var(--text-muted); }
    .session-status.failed { background: var(--danger-muted); color: var(--danger); }
    .session-status.stopped { background: var(--warning-muted); color: var(--warning); }
    .session-status.archived { background: rgba(95, 74, 57, 0.1); color: var(--text-secondary); }

    /* 可折叠顶栏 */
    .topbar-collapsed .topbar-center,
    .topbar-collapsed .brand-meta,
    .topbar-collapsed .status-badge { display: none; }

    .topbar-toggle {
      display: none;
      width: 28px;
      height: 28px;
      min-width: 28px;
      min-height: 28px;
      padding: 0;
      border-radius: 6px;
      font-size: 0.875rem;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .topbar-toggle:hover { background: rgba(240, 229, 215, 0.72); }

    @media (max-width: 640px) {
      .topbar-toggle { display: flex; align-items: center; justify-content: center; }

      .topbar.topbar-collapsed {
        min-height: 36px;
        padding: 4px 8px;
      }

      .topbar.topbar-collapsed .topbar-left,
      .topbar.topbar-collapsed .topbar-right { gap: 4px; }

      .topbar.topbar-collapsed .btn-sm {
        padding: 4px 8px;
        font-size: 0.6875rem;
        min-height: 28px;
      }

      .topbar.topbar-collapsed .logo-icon {
        width: 20px;
        height: 20px;
        font-size: 8px;
      }

      /* 展开状态时的顶栏 */
      .topbar.topbar-expanded {
        grid-template-columns: auto 1fr auto;
        grid-template-areas:
          "toggle close ."
          "menu logo actions";
        padding: 8px 10px;
        min-height: auto;
        row-gap: 8px;
      }

      .topbar.topbar-expanded .topbar-toggle { grid-area: toggle; }
      .topbar.topbar-expanded .topbar-left { grid-area: menu; }
      .topbar.topbar-expanded .topbar-right { grid-area: actions; }
    }

    .session-id {
      font-family: var(--font-mono);
      font-size: 0.625rem;
      color: var(--text-muted);
      background: rgba(150, 118, 85, 0.1);
      padding: 1px 5px;
      border-radius: 4px;
    }

    .sidebar-footer {
      padding: 12px 14px 14px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: rgba(255, 251, 245, 0.6);
    }

    .sidebar-meta {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-family: var(--font-sans);
      font-size: 0.8125rem;
      font-weight: 500;
      padding: 8px 14px;
      border-radius: var(--radius-md);
      border: 1px solid transparent;
      cursor: pointer;
      transition: all var(--transition-fast);
      min-height: 40px;
    }

    .btn-primary { background: linear-gradient(180deg, #cf754d 0%, #b85c37 100%); color: white; box-shadow: 0 4px 12px rgba(184, 92, 55, 0.22); }
    .btn-primary:hover { background: linear-gradient(180deg, #c96b44 0%, #a94d2b 100%); transform: translateY(-1px); box-shadow: 0 6px 16px rgba(184, 92, 55, 0.28); }
    .btn-secondary { background: rgba(255, 250, 244, 0.9); color: var(--text-secondary); border-color: var(--border-subtle); }
    .btn-secondary:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--accent-soft); }
    .btn-ghost { background: transparent; color: var(--text-secondary); }
    .btn-ghost:hover { background: rgba(240, 229, 215, 0.72); color: var(--text-primary); }
    .btn-danger { background: var(--danger-muted); color: var(--danger); }
    .btn-danger:hover { background: var(--danger); color: white; }
    .btn-block { width: 100%; }
    .btn-sm { font-size: 0.75rem; padding: 6px 10px; min-height: 34px; }
    .btn-icon { padding: 8px; font-size: 1rem; min-height: 40px; }

    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      background: transparent;
    }

    .terminal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px 12px;
      background: rgba(255, 251, 245, 0.72);
      border-bottom: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
    }

    .terminal-title { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; min-width: 0; }
    .terminal-title-text { font-family: var(--font-mono); color: var(--accent); font-weight: 500; }
    .terminal-info { font-size: 0.6875rem; color: var(--text-muted); }
    .terminal-header-actions { display: flex; align-items: center; gap: 8px; }

    .terminal-container {
      flex: 1;
      display: none;
      background:
        radial-gradient(circle at top right, rgba(91, 58, 34, 0.16), transparent 28%),
        linear-gradient(180deg, #221d18 0%, #1b1714 100%);
      padding: 18px;
      overflow-y: auto;
      min-height: 200px;
      margin: 14px;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(122, 91, 64, 0.35);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), var(--shadow-soft);
    }

    .terminal-container.active { display: flex; }

    .terminal-container .xterm { height: 100%; }
    .terminal-container .xterm-viewport { background: transparent !important; }

    /* Chat View */
    .view-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      background: rgba(240, 229, 215, 0.7);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 3px;
    }

    .view-toggle-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);
      font-family: var(--font-sans);
    }

    .view-toggle-btn:hover { color: var(--text-secondary); background: rgba(255, 255, 255, 0.5); }
    .view-toggle-btn.active { background: white; color: var(--text-primary); box-shadow: 0 2px 8px rgba(89, 58, 32, 0.08); }

    .chat-container {
      flex: 1;
      display: none;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      padding: 14px 18px;
    }

    .chat-container.active { display: flex; }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding-bottom: 16px;
    }

    .chat-message {
      display: flex;
      flex-direction: column;
      max-width: 85%;
      animation: messageSlide 0.3s ease;
    }

    @keyframes messageSlide {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .chat-message.user {
      align-self: flex-end;
    }

    .chat-message.assistant {
      align-self: flex-start;
    }

    .chat-message-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      margin-bottom: 6px;
    }

    .chat-message.user .chat-message-avatar {
      display: none;
    }

    .chat-message.assistant .chat-message-avatar {
      background: linear-gradient(135deg, #c5653d 0%, #a95130 100%);
      color: white;
    }

    .chat-message.user .chat-message-bubble {
      background: linear-gradient(135deg, #c5653d 0%, #a95130 100%);
      color: white;
      border-bottom-right-radius: 4px;
    }

    .chat-message.assistant .chat-message-bubble {
      background: rgba(255, 251, 245, 0.95);
      border: 1px solid var(--border-subtle);
      border-bottom-left-radius: 4px;
    }

    .chat-message-bubble {
      padding: 12px 16px;
      border-radius: var(--radius-md);
      font-size: 0.875rem;
      line-height: 1.6;
      word-wrap: break-word;
    }

    .chat-message.user .chat-message-bubble {
      font-family: var(--font-mono);
    }

    /* Thinking Card (Deep Thought) */
    .chat-message.thinking {
      align-self: center;
      max-width: 90%;
      margin: 8px 0;
    }

    .thinking-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: linear-gradient(135deg, rgba(99, 101, 103, 0.08) 0%, rgba(150, 152, 155, 0.06) 100%);
      border: 1px solid rgba(150, 152, 155, 0.2);
      border-radius: var(--radius-lg);
      animation: thinkingPulse 2s ease-in-out infinite;
    }

    @keyframes thinkingPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.85; transform: scale(1.02); }
    }

    .thinking-icon {
      font-size: 1.25rem;
      animation: thinkingSpin 3s linear infinite;
    }

    @keyframes thinkingSpin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .thinking-content {
      font-size: 0.8125rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
      letter-spacing: 0.3px;
    }

    /* Prompt Suggestion Card (Pulsing) */
    .chat-message.prompt {
      align-self: center;
      max-width: 85%;
      margin: 4px 0;
    }

    .prompt-card {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: linear-gradient(135deg, rgba(197, 101, 61, 0.08) 0%, rgba(169, 81, 48, 0.04) 100%);
      border: 1px dashed rgba(197, 101, 61, 0.3);
      border-radius: var(--radius-md);
      animation: promptPulse 1.5s ease-in-out infinite;
      cursor: default;
    }

    @keyframes promptPulse {
      0%, 100% { opacity: 0.7; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.03); }
    }

    .prompt-icon {
      font-size: 1rem;
      filter: grayscale(0.3);
    }

    .prompt-content {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .prompt-text {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 500;
    }

    /* Inline Thinking (inside structured messages) */
    .inline-thinking {
      margin: 8px 0;
      animation: none;
    }
    .inline-thinking details summary {
      cursor: pointer;
      user-select: none;
      font-size: 0.8125rem;
      color: var(--text-muted);
    }
    .thinking-text {
      margin-top: 8px;
      font-size: 0.75rem;
      color: var(--text-muted);
      white-space: pre-wrap;
      max-height: 300px;
      overflow-y: auto;
    }

    /* Tool Use Card */
    .tool-use-card {
      margin: 8px 0;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .tool-use-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      background: rgba(79, 122, 88, 0.08);
      cursor: pointer;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-secondary);
      user-select: none;
    }
    .tool-icon { font-size: 0.875rem; }
    .tool-name { font-family: var(--font-mono); }
    .tool-use-body {
      padding: 8px 12px;
      background: var(--bg-elevated);
    }
    .tool-input {
      margin: 0;
      font-size: 0.75rem;
      max-height: 200px;
      overflow-y: auto;
    }
    .tool-input code {
      font-family: var(--font-mono);
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* Tool Result Card */
    .tool-result-card {
      margin: 8px 0;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    .tool-result-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(79, 122, 88, 0.06);
      cursor: pointer;
      font-size: 0.75rem;
      color: var(--text-muted);
      user-select: none;
    }
    .tool-result-error .tool-result-header {
      background: rgba(178, 79, 69, 0.08);
    }
    .tool-result-body {
      padding: 8px 12px;
      background: var(--bg-elevated);
    }
    .tool-result-content {
      margin: 0;
      font-size: 0.7rem;
      max-height: 200px;
      overflow-y: auto;
    }
    .tool-result-content code {
      font-family: var(--font-mono);
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* Markdown Content */
    .markdown-content { color: inherit; }
    .markdown-content p { margin: 0 0 8px 0; }
    .markdown-content p:last-child { margin-bottom: 0; }
    .markdown-content strong { font-weight: 600; }
    .markdown-content em { font-style: italic; }
    .markdown-content ul, .markdown-content ol { margin: 8px 0; padding-left: 20px; }
    .markdown-content li { margin: 4px 0; }
    .markdown-content h1, .markdown-content h2, .markdown-content h3 { margin: 16px 0 8px 0; font-weight: 600; }
    .markdown-content h1 { font-size: 1.25rem; }
    .markdown-content h2 { font-size: 1.1rem; }
    .markdown-content h3 { font-size: 1rem; }
    .markdown-content blockquote {
      margin: 8px 0;
      padding: 8px 12px;
      border-left: 3px solid var(--accent);
      background: rgba(197, 101, 61, 0.06);
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }
    .markdown-content code:not(.code-block):not(.code-inline) {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      background: rgba(150, 118, 85, 0.12);
      padding: 2px 5px;
      border-radius: 4px;
    }

    .markdown-content code.code-inline {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      background: rgba(150, 118, 85, 0.12);
      padding: 2px 5px;
      border-radius: 4px;
    }
    .markdown-content .code-block {
      margin: 10px 0;
      border-radius: var(--radius-md);
      overflow: hidden;
      background: #1f1b17;
      border: 1px solid rgba(122, 91, 64, 0.35);
    }
    .markdown-content .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: rgba(122, 91, 64, 0.2);
      border-bottom: 1px solid rgba(122, 91, 64, 0.2);
    }
    .markdown-content .code-lang {
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      color: #8c735f;
      text-transform: lowercase;
    }
    .markdown-content .code-copy {
      font-family: var(--font-sans);
      font-size: 0.6875rem;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.08);
      color: #c9b8a8;
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .markdown-content .code-copy:hover { background: rgba(255, 255, 255, 0.15); color: white; }
    .markdown-content .code-copy.copied { color: #7fa36f; border-color: rgba(127, 163, 111, 0.4); }
    .markdown-content pre {
      margin: 0;
      padding: 12px;
      overflow-x: auto;
    }
    .markdown-content pre code {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      line-height: 1.5;
      color: #f5eadc;
      background: transparent;
      padding: 0;
    }

    /* Syntax Highlighting */
    .token-comment { color: #625347; }
    .token-keyword { color: #c595c7; }
    .token-string { color: #7fa36f; }
    .token-number { color: #d5a35b; }
    .token-function { color: #87a9d9; }
    .token-operator { color: #d27766; }
    .token-class { color: #7fb3b1; }
    .token-variable { color: #f5eadc; }
    .token-type { color: #d5a35b; }

    .input-panel {
      background: rgba(255, 251, 245, 0.78);
      border-top: 1px solid var(--border-subtle);
      padding: 14px 18px 18px;
      backdrop-filter: blur(12px);
      flex-shrink: 0;
      position: relative;
    }

    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    .input-field { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    .input-label { font-size: 0.6875rem; color: var(--text-muted); font-weight: 500; }
    .input-textarea-wrap { position: relative; }

    .input-textarea {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      background: rgba(255, 255, 255, 0.65);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      padding: 10px 110px 10px 12px;
      outline: none;
      resize: none;
      min-height: 42px;
      max-height: 120px;
      width: 100%;
      flex: 1;
      transition: border-color var(--transition-fast);
      box-sizing: border-box;
    }

    .input-textarea:focus { border-color: var(--accent); }
    .input-textarea::placeholder { color: var(--text-muted); }

    .input-inline-controls {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      pointer-events: none;
    }

    .input-inline-controls > * {
      pointer-events: auto;
    }

    .keyboard-aware {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 20;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-subtle);
      padding: 12px 14px;
      padding-bottom: max(12px, env(keyboard-inset-bottom, 0px));
      transform: translateY(0);
      transition: transform 0.2s ease;
    }

    .keyboard-aware.hidden { transform: translateY(100%); }

    .input-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
      align-items: center;
    }
    .input-actions .btn {
      min-width: 72px;
      padding: 10px 14px;
    }
    .btn-send {
      background: linear-gradient(180deg, #5a8f5f 0%, #4a7a4f 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(74, 122, 79, 0.25);
    }
    .btn-send:hover {
      background: linear-gradient(180deg, #4f7f54 0%, #3f6a44 100%);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(74, 122, 79, 0.32);
    }
    .btn-stop {
      background: rgba(178, 79, 69, 0.12);
      color: var(--danger);
      border: 1px solid rgba(178, 79, 69, 0.25);
    }
    .btn-stop:hover {
      background: var(--danger);
      color: white;
      border-color: var(--danger);
    }
    .input-actions-spacer { flex: 1; }

    .floating-toggle {
      width: 38px;
      height: 38px;
      min-width: 38px;
      min-height: 38px;
      border-radius: var(--radius-md);
      box-shadow: 0 4px 12px rgba(89, 58, 32, 0.1);
      padding: 0;
      font-size: 1.1rem;
      line-height: 1;
    }

    .floating-backdrop {
      position: fixed;
      inset: 0;
      z-index: 38;
    }

    .floating-pad {
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      z-index: 39;
      width: min(240px, calc(100vw - 32px));
      background: rgba(255, 251, 245, 0.98);
      border: 1px solid rgba(150, 118, 85, 0.18);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-soft);
      padding: 14px;
      backdrop-filter: blur(18px);
    }

    .floating-pad-title {
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .floating-pad-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      align-items: center;
    }

    .floating-pad-grid .btn {
      width: 100%;
      min-height: 40px;
      padding: 8px;
      font-size: 0.875rem;
      border-radius: var(--radius-sm);
    }

    .quick-input {
      font-family: var(--font-mono);
      font-weight: 500;
    }

    .btn-yes {
      background: var(--success-muted);
      color: var(--success);
    }
    .btn-yes:hover {
      background: var(--success);
      color: white;
    }

    .btn-no {
      background: var(--danger-muted);
      color: var(--danger);
    }
    .btn-no:hover {
      background: var(--danger);
      color: white;
    }

    .floating-pad-spacer {
      visibility: hidden;
    }

    .login-container {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      min-height: 100dvh;
      padding: 24px;
    }

    .login-card {
      width: 100%;
      max-width: 380px;
      background: rgba(255, 251, 245, 0.92);
      border: 1px solid rgba(150, 118, 85, 0.16);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: var(--shadow-soft);
    }

    .login-header {
      padding: 28px 24px 22px;
      text-align: center;
      border-bottom: 1px solid var(--border-subtle);
      background:
        radial-gradient(circle at top, rgba(214, 144, 100, 0.26), transparent 45%),
        linear-gradient(180deg, rgba(255, 246, 235, 0.85), rgba(255, 251, 245, 0.85));
    }

    .login-logo { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 8px; }

    .login-logo-icon {
      width: 42px; height: 42px;
      background: linear-gradient(135deg, #d67b52 0%, #ab522e 100%);
      border-radius: var(--radius-md);
      display: flex; align-items: center; justify-content: center;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
      font-size: 18px; color: white; font-weight: 700;
    }

    .login-logo-text { font-size: 1.6rem; font-weight: 600; letter-spacing: -0.02em; }
    .login-subtitle { color: var(--text-muted); font-size: 0.875rem; }
    .login-body { padding: 24px; }
    .login-hint { font-size: 0.8125rem; color: var(--text-secondary); margin-bottom: 20px; line-height: 1.6; }
    .login-tip {
      font-size: 0.75rem;
      color: var(--warning);
      background: rgba(255, 244, 230, 0.92);
      border: 1px solid rgba(169, 106, 47, 0.18);
      border-radius: var(--radius-md);
      padding: 10px 12px;
      margin-bottom: 18px;
    }

    .field { margin-bottom: 16px; }
    .field-label { display: block; font-size: 0.75rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }

    .field-input {
      width: 100%;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      background: rgba(255, 255, 255, 0.66);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      padding: 10px 12px;
      outline: none;
      transition: border-color var(--transition-fast);
    }

    .field-input:focus { border-color: var(--accent); }
    .field-input::placeholder { color: var(--text-muted); }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      background: rgba(42, 28, 18, 0.48);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .modal {
      width: 100%;
      max-width: 440px;
      background: rgba(255, 251, 245, 0.96);
      border: 1px solid rgba(150, 118, 85, 0.18);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: var(--shadow-soft);
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .modal-title { font-size: 1rem; font-weight: 600; }
    .modal-body { padding: 20px; }
    .modal-body .field { margin-bottom: 16px; }
    .modal-body .field:last-of-type { margin-bottom: 20px; }
    .field-hint {
      margin-top: 6px;
      font-size: 0.75rem;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .tool-picker {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .tool-card {
      width: 100%;
      text-align: left;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      background: rgba(255, 255, 255, 0.58);
      padding: 14px;
      cursor: pointer;
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
    }
    .tool-card:hover {
      border-color: var(--accent-soft);
      transform: translateY(-1px);
      box-shadow: 0 8px 20px rgba(89, 58, 32, 0.08);
    }
    .tool-card.active {
      border-color: var(--accent);
      background: rgba(255, 247, 239, 0.96);
      box-shadow: 0 0 0 1px rgba(197, 101, 61, 0.12);
    }
    .tool-card-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.9375rem;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--text-primary);
    }
    .tool-card-desc {
      font-size: 0.75rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .tool-chip {
      flex-shrink: 0;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.6875rem;
      color: var(--accent);
      background: rgba(197, 101, 61, 0.1);
    }
    .command-preview {
      display: block;
      margin-top: 8px;
      padding: 10px 12px;
      border-radius: var(--radius-md);
      border: 1px dashed var(--border-default);
      background: rgba(255, 255, 255, 0.48);
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: var(--font-mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    select.field-input {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 36px;
    }

    .suggestions-wrap { position: relative; }

    .suggestions {
      position: absolute;
      top: calc(100% + 4px);
      left: 0; right: 0;
      z-index: 50;
      background: rgba(255, 250, 244, 0.98);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      max-height: 200px;
      overflow-y: auto;
    }

    .suggestion-item {
      width: 100%;
      text-align: left;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: var(--text-primary);
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      transition: background var(--transition-fast);
    }

    .suggestion-item:hover { background: rgba(232, 197, 174, 0.34); }
    .suggestion-item small { display: block; font-size: 0.6875rem; color: var(--text-muted); margin-top: 2px; }

    .error-message {
      font-size: 0.75rem;
      color: var(--danger);
      padding: 10px 12px;
      background: var(--danger-muted);
      border-radius: var(--radius-md);
      margin-top: 12px;
    }

    .hint { font-size: 0.6875rem; color: var(--text-muted); margin-top: 12px; }
    .empty-state { text-align: center; padding: 32px 16px; color: var(--text-muted); font-size: 0.8125rem; }
    .empty-state strong { display: block; color: var(--text-secondary); font-size: 0.95rem; margin-bottom: 6px; }
    .hidden { display: none !important; }

    .offline-banner {
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--warning);
      color: white;
      padding: 8px 16px;
      border-radius: var(--radius-md);
      font-size: 0.8125rem;
      font-weight: 500;
      z-index: 100;
      box-shadow: var(--shadow-elevated);
      animation: slideUp 0.3s ease;
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateX(-50%) translateY(20px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }

    .pwa-install-prompt {
      position: fixed;
      bottom: 24px;
      left: 24px;
      right: 24px;
      max-width: 400px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      padding: 16px;
      box-shadow: var(--shadow-soft);
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .pwa-install-prompt .prompt-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #d77a52 0%, #a95130 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 700;
      font-size: 20px;
      flex-shrink: 0;
    }

    .pwa-install-prompt .prompt-content {
      flex: 1;
      min-width: 0;
    }

    .pwa-install-prompt .prompt-title {
      font-weight: 600;
      font-size: 0.9375rem;
      margin-bottom: 2px;
    }

    .pwa-install-prompt .prompt-desc {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .pwa-install-prompt .prompt-actions {
      display: flex;
      gap: 8px;
    }

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:focus-visible { outline-offset: 0; }

    @media (max-width: 768px) {
      .topbar {
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas: "left right";
        padding: 8px 12px;
        min-height: 52px;
        gap: 8px;
      }
      .topbar-center { display: none; }
      .sidebar { width: min(304px, calc(100vw - 28px)); }
      .config-path { display: none; }
      .terminal-container { min-height: 180px; margin: 10px; }
      .btn { min-height: 40px; }
      .btn-sm { min-height: 36px; padding: 6px 10px; }
      .status-badge { display: none; }
      .brand-subtitle { display: none; }
      .view-toggle { display: none; }
      .chat-container { padding: 10px; }
      .chat-message { max-width: 95%; }
      .thinking-card { padding: 8px 12px; }
      .thinking-content { font-size: 0.75rem; }
      .tool-picker { grid-template-columns: 1fr; }
    }

    @media (min-width: 769px) {
      .drawer-backdrop {
        display: none;
      }
    }

    @media (max-width: 640px) {
      html, body {
        min-height: 100dvh;
        height: auto;
      }

      body {
        overflow-x: hidden;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }

      .app-container {
        min-height: 100dvh;
        height: auto;
        overflow: visible;
      }

      /* 简化顶栏：单行紧凑布局 */
      .topbar {
        position: sticky;
        top: 0;
        z-index: 30;
        grid-template-columns: auto minmax(0, 1fr) auto;
        grid-template-areas: "menu logo actions";
        align-items: center;
        gap: 8px;
        min-height: 48px;
        padding: 6px 10px;
      }

      .topbar-left { grid-area: menu; display: flex; gap: 6px; }
      .topbar-center { display: none; }
      .topbar-right { grid-area: actions; display: flex; gap: 6px; }
      .topbar-actions { display: contents; }

      /* 紧凑 logo */
      .logo-wrap { display: flex; align-items: center; gap: 6px; grid-area: logo; justify-content: center; }
      .logo { gap: 6px; font-size: 0.875rem; }
      .logo-icon { width: 24px; height: 24px; font-size: 10px; border-radius: 8px; }
      .brand-meta { display: none; }
      .status-badge { display: none; }
      .session-summary { display: none; }

      /* 紧凑按钮 */
      .topbar .btn-sm { padding: 6px 10px; font-size: 0.75rem; min-height: 36px; }

      .main-layout {
        flex-direction: column;
        flex: none;
        overflow: visible;
      }

      .sidebar {
        width: min(300px, calc(100vw - 20px));
        max-height: none;
        border-bottom: none;
      }

      .sessions-list {
        display: block;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 10px;
        -webkit-overflow-scrolling: touch;
      }

      .session-item {
        width: 100%;
        max-width: none;
        margin-bottom: 8px;
        padding: 10px 12px;
      }

      .main-content {
        overflow: visible;
      }

      /* 紧凑终端头部 */
      .terminal-header {
        padding: 8px 12px;
        align-items: center;
        gap: 6px;
      }
      .terminal-title {
        flex-direction: row;
        align-items: center;
        gap: 8px;
        font-size: 0.75rem;
      }
      .terminal-info { font-size: 0.625rem; }

      /* 最大化终端区域 */
      .terminal-container {
        flex: none;
        min-height: 40vh;
        max-height: 55vh;
        margin: 8px;
        padding: 12px;
        border-radius: var(--radius-md);
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }

      /* 紧凑输入面板 */
      .input-panel {
        position: sticky;
        bottom: 0;
        z-index: 20;
        padding: 10px 12px;
        padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
        box-shadow: 0 -8px 24px rgba(89, 58, 32, 0.08);
      }

      .input-row { flex-direction: column; align-items: stretch; gap: 8px; }
      .input-field { gap: 2px; }
      .input-label { font-size: 0.625rem; }

      .input-actions {
        width: 100%;
        display: flex;
        flex-wrap: nowrap;
        gap: 6px;
      }
      .input-actions .btn {
        flex: 1;
        min-width: 0;
        min-height: 40px;
        font-size: 0.8125rem;
      }
      .floating-toggle {
        flex: 0 0 auto;
        min-width: 40px;
        min-height: 40px;
        border-radius: var(--radius-md);
      }

      .input-textarea,
      .field-input {
        font-size: 16px;
      }

      .input-textarea {
        min-height: 44px;
        padding: 8px 84px 8px 10px;
      }

      .input-inline-controls {
        top: 8px;
        right: 8px;
        transform: none;
      }

      .chat-mode-select {
        max-width: 72px;
        height: 26px;
        font-size: 0.6875rem;
      }

      .floating-pad {
        right: 0;
        bottom: calc(100% + 6px);
        width: 100%;
        padding: 10px;
      }

      .floating-pad-grid .btn {
        min-height: 44px;
      }

      .login-container {
        min-height: 100dvh;
        align-items: flex-start;
        padding: 16px 12px calc(16px + env(safe-area-inset-bottom, 0px));
      }

      .login-card {
        margin-top: max(12px, env(safe-area-inset-top, 0px));
      }

      .login-header { padding: 20px 18px 16px; }
      .login-body { padding: 18px; }
      .btn { min-height: 44px; }
      .btn-sm { min-height: 38px; }

      .chat-message-bubble { padding: 10px 12px; font-size: 0.8125rem; }
      .chat-message-avatar { width: 24px; height: 24px; font-size: 12px; }
    }

    @media (max-width: 420px) {
      .topbar {
        padding: 4px 8px;
        min-height: 44px;
        gap: 6px;
      }

      .topbar-left,
      .topbar-right {
        gap: 4px;
      }

      .logo-icon { width: 22px; height: 22px; font-size: 9px; }
      .topbar .btn-sm { padding: 5px 8px; font-size: 0.6875rem; min-height: 32px; }

      .terminal-header { padding: 6px 10px; }
      .terminal-title-text { font-size: 0.75rem; }

      .terminal-container {
        min-height: 38vh;
        max-height: 50vh;
        margin: 6px;
        padding: 10px;
      }

      .input-panel {
        padding: 8px 10px;
        padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
      }

      .input-actions { gap: 4px; }
      .input-actions .btn { min-height: 38px; font-size: 0.75rem; }
      .floating-toggle { min-width: 38px; min-height: 38px; }

      .floating-pad {
        width: calc(100vw - 20px);
        right: 10px;
        padding: 8px;
      }

      .floating-pad-grid .btn { min-height: 40px; font-size: 0.8125rem; }

      .session-item { padding: 8px 10px; }
      .session-command { font-size: 0.75rem; }
      .session-meta { font-size: 0.625rem; }

      .sidebar-footer {
        padding: 8px 10px 10px;
      }

      .sidebar-meta {
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
      }

      .modal-body { padding: 16px; }
      .modal-header { padding: 12px 16px; }
      .modal-title { font-size: 0.9375rem; }

      .btn { min-height: 42px; }
      .btn-sm { min-height: 36px; }
    }

    .blank-chat {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: 24px 18px;
    }
    .blank-chat-inner {
      width: 100%;
      max-width: 600px;
      text-align: center;
    }
    .blank-chat-logo {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #d77a52, #a95130);
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      font-weight: 700;
      color: white;
      margin: 0 auto 16px;
      box-shadow: 0 4px 20px rgba(197, 101, 61, 0.25);
    }
    .blank-chat-title {
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    .blank-chat-subtitle {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin: 0 0 24px;
    }
    .blank-chat-input-wrap {
      position: relative;
      margin-bottom: 16px;
    }
    .blank-chat-input {
      width: 100%;
      padding: 14px 80px 14px 18px;
      border: 1.5px solid var(--border-default);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.8);
      color: var(--text-primary);
      font-size: 0.9375rem;
      font-family: var(--font-sans);
      outline: none;
      box-shadow: 0 2px 12px rgba(89, 58, 32, 0.06);
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
      box-sizing: border-box;
    }
    .blank-chat-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-muted), 0 2px 12px rgba(89, 58, 32, 0.06);
    }
    .blank-chat-input::placeholder { color: var(--text-muted); }
    .blank-chat-send-btn {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      padding: 8px 18px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 0.8125rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: background var(--transition-fast);
    }
    .blank-chat-send-btn:hover { background: var(--accent-hover); }
    .blank-chat-tools {
      display: flex;
      gap: 8px;
      justify-content: center;
      margin-bottom: 12px;
    }
    .blank-chat-tool-btn {
      padding: 8px 16px;
      border: 1.5px solid var(--border-default);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.6);
      color: var(--text-secondary);
      font-size: 0.8125rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: all var(--transition-fast);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .blank-chat-tool-btn:hover {
      background: var(--accent-muted);
      border-color: var(--accent);
      color: var(--accent);
    }
    .blank-chat-tool-btn .tool-icon {
      font-size: 1rem;
    }
    .blank-chat-hint {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin: 0;
    }
    .mode-btn-group {
      display: flex;
      gap: 4px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .mode-btn {
      padding: 5px 12px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-default);
      background: rgba(255, 255, 255, 0.5);
      color: var(--text-secondary);
      font-size: 0.75rem;
      font-family: inherit;
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .mode-btn:hover {
      background: rgba(255, 255, 255, 0.8);
      border-color: var(--accent);
      color: var(--accent);
    }
    .mode-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    .mode-selector-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .chat-mode-select {
      height: 28px;
      padding: 0 8px;
      border: 1.5px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 0.75rem;
      font-family: inherit;
      cursor: pointer;
      outline: none;
      max-width: 96px;
    }
    .chat-mode-select:focus {
      border-color: var(--accent);
    }
    .input-field-full {
      flex: 1;
    }
    .toast-message {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      padding: 10px 20px;
      border-radius: var(--radius-md);
      font-size: 0.875rem;
      z-index: 9999;
      animation: toast-in 0.2s ease;
    }
    .toast-error {
      background: var(--danger);
      color: white;
    }
    @keyframes toast-in {
      from { opacity: 0; transform: translateX(-50%) translateY(8px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  </style>
</head>
<body>
  <div id="app"></div>

  <script src="/vendor/xterm/lib/xterm.js"></script>
  <script src="/vendor/xterm-addon-fit/lib/addon-fit.js"></script>
  <script>
    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function(e) {
        console.log('SW registration failed:', e);
      });
    }

    (function() {
      var configPath = "${escapeHtml(configPath)}";

      var state = {
        selectedId: null,
        pollTimer: null,
        config: null,
        sessions: [],
        suggestionTimer: null,
        terminal: null,
        fitAddon: null,
        terminalSessionId: null,
        terminalOutput: "",
        resizeObserver: null,
        resizeHandler: null,
        resizeTimer: null,
        inputQueue: Promise.resolve(),
        drafts: {},
        isSyncingInputBox: false,
        loginPending: false,
        loginChecked: false,
        sessionsDrawerOpen: true,
        modalOpen: false,
        topbarCollapsed: false,
        presetValue: "",
        commandValue: "",
        cwdValue: "",
        modeValue: "full-access",
        chatMode: "full-access",
        sessionTool: "claude",
        preferredCommand: "claude",
        lastResize: { cols: 0, rows: 0 },
        isOnline: navigator.onLine,
        deferredPrompt: null,
        showInstallPrompt: false,
        ws: null,
        wsConnected: false,
        currentView: "chat",
        sidebarTab: "sessions",
        currentMessages: [],
        lastRenderedHash: 0,
        lastRenderedMsgCount: 0,
        lastRenderedEmpty: null,
        renderPending: false
      };

      // PWA install prompt handling
      window.addEventListener('beforeinstallprompt', function(e) {
        e.preventDefault();
        state.deferredPrompt = e;
        state.showInstallPrompt = true;
        updateInstallPrompt();
      });

      window.addEventListener('online', function() {
        state.isOnline = true;
        updateOfflineBanner();
      });

      window.addEventListener('offline', function() {
        state.isOnline = false;
        updateOfflineBanner();
      });

      function updateOfflineBanner() {
        var banner = document.getElementById('offline-banner');
        if (!state.isOnline && !banner) {
          var el = document.createElement('div');
          el.id = 'offline-banner';
          el.className = 'offline-banner';
          el.textContent = 'You are offline - some features may be limited';
          document.body.appendChild(el);
        } else if (state.isOnline && banner) {
          banner.remove();
        }
      }

      function updateInstallPrompt() {
        var prompt = document.getElementById('pwa-install-prompt');
        if (state.showInstallPrompt && state.deferredPrompt && !prompt) {
          var el = document.createElement('div');
          el.id = 'pwa-install-prompt';
          el.className = 'pwa-install-prompt';
          el.innerHTML =
            '<div class="prompt-icon">W</div>' +
            '<div class="prompt-content">' +
              '<div class="prompt-title">Install Wand</div>' +
              '<div class="prompt-desc">Add to home screen for quick access</div>' +
            '</div>' +
            '<div class="prompt-actions">' +
              '<button id="pwa-install-dismiss" class="btn btn-ghost btn-sm">Later</button>' +
              '<button id="pwa-install-accept" class="btn btn-primary btn-sm">Install</button>' +
            '</div>';
          document.body.appendChild(el);
          document.getElementById('pwa-install-dismiss').addEventListener('click', function() {
            el.remove();
            state.showInstallPrompt = false;
          });
          document.getElementById('pwa-install-accept').addEventListener('click', function() {
            state.deferredPrompt.prompt();
            state.deferredPrompt.userChoice.then(function(result) {
              state.deferredPrompt = null;
              state.showInstallPrompt = false;
              el.remove();
            });
          });
        }
      }

      restoreLoginSession();

      function restoreLoginSession() {
        fetch("/api/config", { credentials: "same-origin" })
          .then(function(res) {
            if (!res.ok) {
              state.loginChecked = true;
              render();
              return null;
            }
            return res.json();
          })
          .then(function(config) {
            if (!config) return;
            state.config = config;
            state.loginChecked = true;
            return refreshAll().then(function() {
              startPolling();
              render();
            });
          })
          .catch(function() {
            state.loginChecked = true;
            render();
          });
      }

      render();

      function render() {
        var app = document.getElementById("app");
        var isLoggedIn = state.config !== null;
        var wasModalOpen = state.modalOpen;

        teardownTerminal();

        app.innerHTML = isLoggedIn ? renderAppShell() : renderLogin();
        attachEventListeners();
        updateDrawerState();
        syncComposerModeSelect();
        applyCurrentView();
        updateShellChrome();

        // Restore modal state if it was open
        if (wasModalOpen && state.modalOpen) {
          var modal = document.getElementById("session-modal");
          if (modal) {
            modal.classList.remove("hidden");
            var commandEl = document.getElementById("command");
            var cwdEl = document.getElementById("cwd");
            var modeEl = document.getElementById("mode");
            if (commandEl) commandEl.value = state.commandValue;
            if (cwdEl) cwdEl.value = state.cwdValue;
            if (modeEl) modeEl.value = state.modeValue;
            syncSessionModalUI();
          }
        }
      }

      function renderLogin() {
        if (!state.loginChecked) {
          return '<div class="login-container">' +
            '<div class="login-card">' +
              '<div class="login-header">' +
                '<div class="login-logo">' +
                  '<div class="login-logo-icon">W</div>' +
                  '<span class="login-logo-text">Wand</span>' +
                '</div>' +
                '<div class="login-subtitle">正在恢复登录状态</div>' +
              '</div>' +
              '<div class="login-body">' +
                '<p class="login-hint">正在检查本地登录会话，请稍候。</p>' +
              '</div>' +
            '</div>' +
          '</div>';
        }
        return '<div class="login-container">' +
          '<div class="login-card">' +
            '<div class="login-header">' +
              '<div class="login-logo">' +
                '<div class="login-logo-icon">W</div>' +
                '<span class="login-logo-text">Wand</span>' +
              '</div>' +
              '<div class="login-subtitle">在浏览器中运行本机终端</div>' +
            '</div>' +
            '<div class="login-body">' +
              '<p class="login-hint">请输入访问密码</p>' +
              '<p class="login-tip">访问地址请使用 <strong>http://</strong>，不要用 https://。</p>' +
              '<div class="field">' +
                '<label class="field-label" for="password">密码</label>' +
                '<input id="password" type="password" class="field-input" placeholder="输入密码" autocomplete="current-password" />' +
              '</div>' +
              '<button id="login-button" class="btn btn-primary btn-block">进入控制台</button>' +
              '<p id="login-error" class="error-message hidden"></p>' +
            '</div>' +
          '</div>' +
        '</div>';
      }

      function renderAppShell() {
        var scriptClose = String.fromCharCode(60) + String.fromCharCode(47) + "script>";
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "未选择会话";
        var terminalInfo = selectedSession ? (selectedSession.mode + " | " + selectedSession.status) : "点击上方「新对话」开始";
        var currentDraft = state.selectedId ? (state.drafts[state.selectedId] || "") : "";
        var statusClass = state.config ? "status-dot active" : "status-dot";
        var statusText = state.config ? "已登录" : "未登录";
        var drawerClass = state.sessionsDrawerOpen ? " open" : "";
        var topbarClass = state.topbarCollapsed ? " topbar-collapsed" : " topbar-expanded";
        var preferredTool = getComposerTool();
        var composerMode = getSafeModeForTool(preferredTool, state.chatMode);

        return '<div class="app-container">' +
          '<header class="topbar' + topbarClass + '">' +
            '<button id="topbar-toggle-button" class="topbar-toggle" type="button" aria-label="Toggle toolbar">' + (state.topbarCollapsed ? '▾' : '▴') + '</button>' +
            '<div class="topbar-left">' +
              '<div class="topbar-actions">' +
                '<button id="sessions-toggle-button" class="btn btn-secondary btn-sm">≡ 菜单</button>' +
              '</div>' +
            '</div>' +
            '<div class="logo-wrap">' +
              '<div class="logo">' +
                '<div class="logo-icon">W</div>' +
              '</div>' +
              '<div class="brand-meta">' +
                '<span class="brand-name">Wand</span>' +
                '<span class="brand-subtitle">本地 AI 编程助手</span>' +
              '</div>' +
            '</div>' +
            '<div class="status-badge">' +
              '<span class="' + statusClass + '" id="status-dot"></span>' +
              '<span id="status-text">' + statusText + '</span>' +
            '</div>' +
            '<div class="topbar-center">' +
              '<div class="session-summary">' +
                '<span class="session-summary-label">当前会话</span>' +
                '<span class="session-summary-value">' + escapeHtml(terminalTitle) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="topbar-right">' +
              '<button id="topbar-new-session-button" class="btn btn-primary btn-sm">+ 新对话</button>' +
              '<button id="settings-button" class="btn btn-ghost btn-sm">⚙</button>' +
              '<button id="logout-button" class="btn btn-ghost btn-sm">退出</button>' +
            '</div>' +
          '</header>' +
          '<div id="sessions-drawer-backdrop" class="drawer-backdrop' + drawerClass + '"></div>' +
          '<div class="main-layout' + (state.sessionsDrawerOpen ? ' sidebar-open' : '') + '">' +
            '<aside id="sessions-drawer" class="sidebar' + drawerClass + '">' +
              '<div class="sidebar-header">' +
                '<div class="sidebar-header-main">' +
                  '<span class="sidebar-title">Menu</span>' +
                  '<span class="session-count" id="session-count">' + String(state.sessions.length) + '</span>' +
                '</div>' +
                '<button id="close-drawer-button" class="btn btn-ghost btn-sm sidebar-close" type="button" aria-label="关闭菜单">×</button>' +
              '</div>' +
              '<div class="sidebar-tabs">' +
                '<button class="sidebar-tab' + (state.sidebarTab !== "files" ? " active" : "") + '" id="tab-sessions" type="button">会话</button>' +
                '<button class="sidebar-tab' + (state.sidebarTab === "files" ? " active" : "") + '" id="tab-files" type="button"><span class="sidebar-tab-icon">▤</span>文件</button>' +
              '</div>' +
              '<div class="sidebar-body">' +
                '<div id="sessions-panel"' + (state.sidebarTab === "files" ? ' class="hidden"' : "") + '>' +
                  '<p class="sidebar-intro">最近的会话记录会显示在这里，方便你随时切换或继续。</p>' +
                  '<div class="sessions-list" id="sessions-list">' + renderSessions() + '</div>' +
                '</div>' +
                '<div id="files-panel"' + (state.sidebarTab !== "files" ? ' class="hidden"' : "") + '>' +
                  '<div class="file-explorer-header">' +
                    '<span class="file-explorer-path" id="file-explorer-cwd">' + escapeHtml(state.config && state.config.defaultCwd ? state.config.defaultCwd : "") + '</span>' +
                    '<div class="file-explorer-actions">' +
                      '<button class="file-explorer-refresh" id="file-explorer-refresh" title="Refresh">↻</button>' +
                    '</div>' +
                  '</div>' +
                  '<div class="file-explorer" id="file-explorer">' + renderFileExplorer(state.config && state.config.defaultCwd ? state.config.defaultCwd : "") + '</div>' +
                '</div>' +
              '</div>' +
              '<div class="sidebar-footer">' +
                '<button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> 新会话</button>' +
                '<div class="sidebar-meta">' +
                  '<span class="protocol-note">请使用 HTTP 访问</span>' +
                  '<span class="config-path">' + escapeHtml(configPath) + '</span>' +
                '</div>' +
              '</div>' +
            '</aside>' +
            '<main class="main-content">' +
              '<div class="terminal-header">' +
                '<div class="terminal-title">' +
                  '<span class="terminal-title-text" id="terminal-title">' + (selectedSession ? shortCommand(selectedSession.command) : "Wand") + '</span>' +
                  '<span class="terminal-info" id="terminal-info">' + (selectedSession ? (getModeLabel(selectedSession.mode) + " | " + selectedSession.status) : "开始对话") + '</span>' +
                '</div>' +
                '<div class="terminal-header-actions">' +
                  '<div class="view-toggle" aria-label="返回模式切换">' +
                    '<button id="view-terminal-btn" class="view-toggle-btn' + (state.currentView === "terminal" ? " active" : "") + '" type="button">原生返回</button>' +
                    '<button id="view-chat-btn" class="view-toggle-btn' + (state.currentView === "chat" ? " active" : "") + '" type="button">对话返回</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              // Blank chat state (when no session)
              '<div id="blank-chat" class="blank-chat' + (state.selectedId ? " hidden" : "") + '">' +
                '<div class="blank-chat-inner">' +
                  '<div class="blank-chat-logo">W</div>' +
                  '<h2 class="blank-chat-title">Wand</h2>' +
                  '<p class="blank-chat-subtitle">你的本地 AI 编程助手</p>' +
                  '<div class="blank-chat-input-wrap">' +
                    '<input type="text" id="welcome-input" class="blank-chat-input" ' +
                      'placeholder="输入你的问题，按 Enter 发送..." autocomplete="off" spellcheck="false" />' +
                    '<button id="welcome-send-btn" class="blank-chat-send-btn" type="button">发送</button>' +
                  '</div>' +
                  '<div class="blank-chat-tools">' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-claude" type="button">' +
                      '<span class="tool-icon">🤖</span>Claude' +
                    '</button>' +
                    '<button class="blank-chat-tool-btn" id="welcome-tool-codex" type="button">' +
                      '<span class="tool-icon">⚡</span>Codex' +
                    '</button>' +
                  '</div>' +
                  '<p class="blank-chat-hint">按 Enter 发送消息，或点击上方按钮快速开始</p>' +
                '</div>' +
              '</div>' +
              '<div id="output" class="terminal-container' + (state.selectedId ? "" : " hidden") + (state.selectedId && state.currentView === "terminal" ? " active" : "") + '"></div>' +
              '<div id="chat-output" class="chat-container' + (state.selectedId ? "" : " hidden") + (state.selectedId && state.currentView === "chat" ? " active" : "") + '"></div>' +
              '<div class="input-panel">' +
                '<div class="input-row">' +
                  '<div class="input-field input-field-full">' +
                    '<div class="input-textarea-wrap">' +
                      '<textarea id="input-box" class="input-textarea" placeholder="输入你的问题，按 Enter 发送..." rows="1">' + escapeHtml(currentDraft) + '</textarea>' +
                      '<div class="input-inline-controls">' +
                        '<select id="chat-mode-select" class="chat-mode-select" title="仅对新建会话生效">' +
                          renderModeOptions(preferredTool, composerMode) +
                        '</select>' +
                      '</div>' +
                    '</div>' +
                  '</div>' +
                  '<div class="input-actions">' +
                    '<button id="send-input-button" class="btn btn-send">发送</button>' +
                    '<button id="stop-button" class="btn btn-stop' + (state.selectedId ? "" : " hidden") + '">停止</button>' +
                  '</div>' +
                '</div>' +
                '<p id="action-error" class="error-message hidden"></p>' +
              '</div>' +
            '</main>' +
          '</div>' +
        '</div>' + renderSessionModal() + renderSettingsModal();
      }

      function renderSettingsModal() {
        return '<section id="settings-modal" class="modal-backdrop hidden">' +
          '<div class="modal">' +
            '<div class="modal-header">' +
              '<h2 class="modal-title">设置</h2>' +
              '<button id="close-settings-button" class="btn btn-ghost btn-icon">×</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label" for="new-password">新密码</label>' +
                '<input id="new-password" type="password" class="field-input" placeholder="输入新密码（至少 6 个字符）" autocomplete="new-password" />' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="confirm-password">确认密码</label>' +
                '<input id="confirm-password" type="password" class="field-input" placeholder="再次输入新密码" autocomplete="new-password" />' +
              '</div>' +
              '<button id="save-password-button" class="btn btn-primary btn-block">保存密码</button>' +
              '<p id="settings-error" class="error-message hidden"></p>' +
              '<p id="settings-success" class="hint hidden" style="color: var(--success);"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderSessions() {
        if (state.sessions.length === 0) {
          return '<div class="empty-state"><strong>还没有会话记录</strong><br>点击上方「新对话」开始你的第一次对话。</div>';
        }
        var activeSessions = state.sessions.filter(function(session) { return !session.archived; });
        var archivedSessions = state.sessions.filter(function(session) { return session.archived; });
        var groups = [];
        if (activeSessions.length > 0) {
          groups.push(renderSessionGroup("最近", activeSessions));
        }
        if (archivedSessions.length > 0) {
          groups.push(renderSessionGroup("已归档", archivedSessions));
        }
        return groups.join("");
      }

      function renderSessionGroup(title, sessions) {
        return '<section class="session-group">' +
          '<div class="session-group-title">' + escapeHtml(title) + '</div>' +
          sessions.map(renderSessionItem).join("") +
        '</section>';
      }

      function setSidebarTab(tab) {
        if (state.sidebarTab === tab) return;
        state.sidebarTab = tab;
        var tabSessions = document.getElementById("tab-sessions");
        var tabFiles = document.getElementById("tab-files");
        var sessionsPanel = document.getElementById("sessions-panel");
        var filesPanel = document.getElementById("files-panel");
        if (tabSessions) tabSessions.classList.toggle("active", tab !== "files");
        if (tabFiles) tabFiles.classList.toggle("active", tab === "files");
        if (sessionsPanel) sessionsPanel.classList.toggle("hidden", tab === "files");
        if (filesPanel) filesPanel.classList.toggle("hidden", tab !== "files");
        if (tab === "files") refreshFileExplorer();
      }

      function renderFileExplorer(cwd) {
        var root = cwd || (state.config && state.config.defaultCwd) || "";
        if (!root) {
          return '<div class="file-explorer empty">No working directory configured.</div>';
        }
        return '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(root) + '">' +
          '<div class="tree-loading">Loading...</div>' +
        '</div>';
      }

      function refreshFileExplorer() {
        var explorer = document.getElementById("file-explorer");
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!explorer) return;
        var cwd = cwdEl ? cwdEl.textContent : "";
        if (!cwd) {
          explorer.innerHTML = '<div class="file-explorer empty">No working directory.</div>';
          return;
        }
        explorer.innerHTML = '<div class="file-explorer"><div class="tree-loading" style="padding:12px;color:var(--text-muted);font-size:0.8125rem;">Loading...</div></div>';
        fetch("/api/directory?q=" + encodeURIComponent(cwd))
          .then(function(res) { return res.json(); })
          .then(function(items) {
            if (!items || items.length === 0) {
              explorer.innerHTML = '<div class="file-explorer empty">Empty directory or inaccessible.</div>';
              return;
            }
            explorer.innerHTML = '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(cwd) + '">' +
              items.map(function(item) {
                return renderFileTreeItem(item);
              }).join("") +
            '</div>';
            attachFileTreeListeners();
          })
          .catch(function() {
            explorer.innerHTML = '<div class="file-explorer empty">Failed to load files.</div>';
          });
      }

      function renderFileTreeItem(item) {
        var name = escapeHtml(item.name);
        var isDir = item.type === "dir";
        var icon = isDir ? "▸" : "📄";
        var toggleClass = isDir ? "" : " empty";
        return '<div class="tree-item" data-path="' + escapeHtml(item.path) + '" data-type="' + escapeHtml(item.type) + '">' +
          '<span class="tree-toggle' + toggleClass + '">' + icon + '</span>' +
          '<span class="tree-name">' + name + '</span>' +
        '</div>';
      }

      function attachFileTreeListeners() {
        var tree = document.getElementById("file-tree");
        if (!tree) return;
        tree.querySelectorAll(".tree-item[data-type='dir']").forEach(function(item) {
          item.addEventListener("click", function() {
            toggleTreeNode(item);
          });
        });
      }

      function toggleTreeNode(item) {
        var path = item.dataset.path;
        var toggle = item.querySelector(".tree-toggle");
        var children = item.nextElementSibling;

        if (children && children.classList.contains("tree-children")) {
          var isOpen = children.classList.contains("open");
          children.classList.toggle("open");
          if (toggle) toggle.classList.toggle("open", !isOpen);
          return;
        }

        // Load children
        if (toggle) toggle.classList.add("open");
        fetch("/api/directory?q=" + encodeURIComponent(path))
          .then(function(res) { return res.json(); })
          .then(function(items) {
            var childrenDiv = document.createElement("div");
            childrenDiv.className = "tree-children open";
            if (!items || items.length === 0) {
              childrenDiv.innerHTML = '<div class="tree-item" style="color:var(--text-muted);cursor:default;"><span class="tree-toggle empty">▸</span><span class="tree-name">（空目录）</span></div>';
            } else {
              childrenDiv.innerHTML = items.map(function(child) {
                return renderFileTreeItem(child);
              }).join("");
            }
            item.parentNode.insertBefore(childrenDiv, item.nextSibling);
            attachFileTreeListeners();
          })
          .catch(function() {});
      }

      function renderSessionItem(session) {
        var activeClass = session.id === state.selectedId ? " active" : "";
        var metaStatus = session.archived ? "已归档" : session.status;
        var modeName = session.mode === "full-access" ? "全权限" : session.mode === "default" ? "默认" : session.mode === "native" ? "原生" : session.mode === "auto-edit" ? "自动编辑" : session.mode;
        var deleteButton = '<button class="btn btn-ghost btn-sm session-action-btn" data-action="delete" data-session-id="' + session.id + '" type="button" aria-label="删除会话">×</button>';
        var resumeButton = "";
        var sessionIdDisplay = "";

        // 如果有 Claude 会话 ID，显示恢复按钮
        if (session.claudeSessionId) {
          var shortId = session.claudeSessionId.slice(0, 8);
          sessionIdDisplay = '<span class="session-id" title="' + escapeHtml(session.claudeSessionId) + '">' + escapeHtml(shortId) + '</span>';
          if (session.status !== "running") {
            resumeButton = '<button class="btn btn-secondary btn-sm session-action-btn" data-action="resume" data-claude-session-id="' + escapeHtml(session.claudeSessionId) + '" data-cwd="' + escapeHtml(session.cwd) + '" type="button" aria-label="恢复会话" title="恢复 Claude 会话">↻</button>';
          }
        }

        return '<div class="session-item' + activeClass + '" data-session-id="' + session.id + '" role="button" tabindex="0">' +
          '<div class="session-item-row">' +
            '<div class="session-main">' +
              '<div class="session-command">' + escapeHtml(session.command) + '</div>' +
              '<div class="session-meta">' +
                '<span>' + escapeHtml(modeName) + '</span>' +
                '<span class="session-status ' + metaStatus + '">' + escapeHtml(metaStatus) + '</span>' +
                sessionIdDisplay +
              '</div>' +
            '</div>' +
            '<span class="session-actions">' + resumeButton + deleteButton + '</span>' +
          '</div>' +
        '</div>';
      }

      function renderSessionModal() {
        var modalTool = state.sessionTool === "codex" ? "codex" : "claude";
        var modalMode = getSafeModeForTool(modalTool, state.modeValue || state.chatMode || "default");
        var commandValue = state.commandValue || modalTool;
        return '<section id="session-modal" class="modal-backdrop hidden">' +
          '<div class="modal">' +
            '<div class="modal-header">' +
              '<h2 class="modal-title">新建 Session</h2>' +
              '<button id="close-modal-button" class="btn btn-ghost btn-icon">×</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label">工具</label>' +
                '<div class="tool-picker" id="tool-picker">' +
                  '<button class="tool-card' + (modalTool === "claude" ? " active" : "") + '" type="button" data-tool="claude">' +
                    '<div class="tool-card-title"><span>Claude</span><span class="tool-chip">推荐</span></div>' +
                    '<div class="tool-card-desc">适合长会话、恢复上下文，以及 Claude 原生单轮回复。</div>' +
                  '</button>' +
                  '<button class="tool-card' + (modalTool === "codex" ? " active" : "") + '" type="button" data-tool="codex">' +
                    '<div class="tool-card-title"><span>Codex</span><span class="tool-chip">快速</span></div>' +
                    '<div class="tool-card-desc">适合直接进入编码工作流，保留完整 CLI 交互。</div>' +
                  '</button>' +
                '</div>' +
                '<p id="tool-description" class="field-hint">' + escapeHtml(getSessionToolDescription(modalTool)) + '</p>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="mode">模式</label>' +
                '<select id="mode" class="field-input">' +
                  renderModeOptions(modalTool, modalMode) +
                '</select>' +
                '<p id="mode-description" class="field-hint">' + escapeHtml(getToolModeHint(modalTool, modalMode)) + '</p>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="command">命令</label>' +
                '<textarea id="command" class="field-input" placeholder="claude&#10;codex&#10;任意 CLI 命令" rows="2">' + escapeHtml(commandValue) + '</textarea>' +
                '<span id="session-command-preview" class="command-preview">' + escapeHtml(commandValue) + '</span>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="cwd">工作目录</label>' +
                '<div class="suggestions-wrap">' +
                  '<input id="cwd" type="text" class="field-input" autocomplete="off" placeholder="留空则使用默认目录" />' +
                  '<div id="cwd-suggestions" class="suggestions hidden"></div>' +
                '</div>' +
              '</div>' +
              '<button id="run-button" class="btn btn-primary btn-block">启动会话</button>' +
              '<p id="modal-error" class="error-message hidden"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderWelcomeView() {
        var defaultCmd = (state.config && state.config.commandPresets && state.config.commandPresets.length > 0)
          ? state.config.commandPresets[0].command
          : "claude";
        var presets = state.config && state.config.commandPresets ? state.config.commandPresets : [];
        var cards = presets.slice(0, 2).map(function(p) {
          var icon = p.command.indexOf("claude") !== -1 ? "🤖" : (p.command.indexOf("codex") !== -1 ? "⚡" : "⌨");
          var desc = p.command.indexOf("claude") !== -1 ? "Anthropic 编程助手" : (p.command.indexOf("codex") !== -1 ? "OpenAI 编程助手" : "CLI 工具");
          return '<div class="quick-card" data-command="' + escapeHtml(p.command) + '">' +
            '<div class="quick-card-icon">' + icon + '</div>' +
            '<div class="quick-card-body">' +
              '<div class="quick-card-title">' + escapeHtml(p.label || p.command) + '</div>' +
              '<div class="quick-card-desc">' + desc + '</div>' +
            '</div>' +
          '</div>';
        }).join("");

        return '<div class="welcome-view">' +
          '<div class="welcome-header">' +
            '<div class="welcome-logo">W</div>' +
            '<h1 class="welcome-title">Wand</h1>' +
            '<p class="welcome-subtitle">你的本地 AI 编程助手</p>' +
          '</div>' +
          '<div class="quick-start-grid" id="quick-start-grid">' +
            cards +
          '</div>' +
          '<div class="welcome-custom-row">' +
            '<input id="welcome-custom-command" class="welcome-custom-input" placeholder="或输入任意命令..." />' +
            '<button id="welcome-custom-start" class="btn btn-primary">启动</button>' +
          '</div>' +
          '<p class="welcome-hint">从右侧菜单可查看历史会话</p>' +
        '</div>';
      }

      function attachEventListeners() {
        var loginButton = document.getElementById("login-button");
        if (loginButton) {
          loginButton.addEventListener("click", login);
          var passwordEl = document.getElementById("password");
          if (passwordEl) {
            passwordEl.addEventListener("keydown", function(e) {
              if (e.key === "Enter") login();
            });
            passwordEl.focus();
          }
          return;
        }

        // Welcome screen event listeners
        var welcomeInput = document.getElementById("welcome-input");
        if (welcomeInput) {
          welcomeInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              welcomeInputSend();
            }
          });
          welcomeInput.focus();
        }
        var welcomeSendBtn = document.getElementById("welcome-send-btn");
        if (welcomeSendBtn) {
          welcomeSendBtn.addEventListener("click", function() {
            welcomeInputSend();
          });
        }
        var welcomeClaudeBtn = document.getElementById("welcome-tool-claude");
        if (welcomeClaudeBtn) {
          welcomeClaudeBtn.addEventListener("click", function() {
            quickStartSession("claude");
          });
        }
        var welcomeCodexBtn = document.getElementById("welcome-tool-codex");
        if (welcomeCodexBtn) {
          welcomeCodexBtn.addEventListener("click", function() {
            quickStartSession("codex");
          });
        }

        var sessionsList = document.getElementById("sessions-list");
        if (sessionsList) {
          sessionsList.addEventListener("click", handleSessionItemClick);
          sessionsList.addEventListener("keydown", handleSessionItemKeydown);
        }

        var commandEl = document.getElementById("command");
        if (commandEl) commandEl.addEventListener("input", function() {
          state.commandValue = this.value;
          var inferredTool = inferToolFromCommand(this.value);
          if (inferredTool === "claude" || inferredTool === "codex") {
            state.sessionTool = inferredTool;
            state.modeValue = getSafeModeForTool(inferredTool, state.modeValue);
          }
          syncSessionModalUI();
        });
        var modalModeEl = document.getElementById("mode");
        if (modalModeEl) modalModeEl.addEventListener("change", function() {
          state.modeValue = this.value;
          syncSessionModalUI();
        });
        var toolPicker = document.getElementById("tool-picker");
        if (toolPicker) toolPicker.addEventListener("click", function(e) {
          var target = e.target;
          var card = target && target.closest ? target.closest(".tool-card") : null;
          if (!card || !card.dataset.tool) return;
          var nextTool = card.dataset.tool;
          state.sessionTool = nextTool;
          state.modeValue = getSafeModeForTool(nextTool, state.modeValue || state.chatMode);
          state.commandValue = replaceCommandBase(state.commandValue || nextTool, nextTool);
          var commandField = document.getElementById("command");
          if (commandField) commandField.value = state.commandValue;
          syncSessionModalUI();
        });
        var cwdEl = document.getElementById("cwd");
        if (cwdEl) {
          cwdEl.addEventListener("input", function() { state.cwdValue = this.value; });
          cwdEl.addEventListener("change", function() { state.cwdValue = this.value; });
          cwdEl.addEventListener("input", schedulePathSuggestions);
          cwdEl.addEventListener("focus", schedulePathSuggestions);
          cwdEl.addEventListener("blur", function() { setTimeout(hidePathSuggestions, 120); });
        }
        var sessionsToggle = document.getElementById("sessions-toggle-button");
        if (sessionsToggle) sessionsToggle.addEventListener("click", toggleSessionsDrawer);
        var drawerBackdrop = document.getElementById("sessions-drawer-backdrop");
        if (drawerBackdrop) drawerBackdrop.addEventListener("click", closeSessionsDrawer);
        var closeDrawerBtn = document.getElementById("close-drawer-button");
        if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeSessionsDrawer);
        var topbarToggle = document.getElementById("topbar-toggle-button");
        if (topbarToggle) topbarToggle.addEventListener("click", toggleTopbar);
        var logoutBtn = document.getElementById("logout-button");
        if (logoutBtn) logoutBtn.addEventListener("click", logout);
        var settingsBtn = document.getElementById("settings-button");
        if (settingsBtn) settingsBtn.addEventListener("click", openSettingsModal);
        var closeSettingsBtn = document.getElementById("close-settings-button");
        if (closeSettingsBtn) closeSettingsBtn.addEventListener("click", closeSettingsModal);
        var settingsModal = document.getElementById("settings-modal");
        if (settingsModal) settingsModal.addEventListener("click", function(e) {
          if (e.target.id === "settings-modal") closeSettingsModal();
        });
        var savePassBtn = document.getElementById("save-password-button");
        if (savePassBtn) savePassBtn.addEventListener("click", savePassword);
        var newSessBtn = document.getElementById("topbar-new-session-button");
        if (newSessBtn) newSessBtn.addEventListener("click", openSessionModal);
        var drawerNewSessBtn = document.getElementById("drawer-new-session-button");
        if (drawerNewSessBtn) drawerNewSessBtn.addEventListener("click", openSessionModal);
        var closeModalBtn = document.getElementById("close-modal-button");
        if (closeModalBtn) closeModalBtn.addEventListener("click", closeSessionModal);
        var runBtn = document.getElementById("run-button");
        if (runBtn) runBtn.addEventListener("click", runCommand);
        var sendBtn = document.getElementById("send-input-button");
        if (sendBtn) sendBtn.addEventListener("click", function() {
          closeSessionsDrawer();
          sendOrStart();
        });
        var stopBtn = document.getElementById("stop-button");
        if (stopBtn) stopBtn.addEventListener("click", stopSession);
        var modeSelect = document.getElementById("chat-mode-select");
        if (modeSelect) modeSelect.addEventListener("change", function() {
          state.chatMode = this.value;
          showToast("新会话模式已切换为：" + getModeLabel(this.value), "info");
        });
        var floatToggle = document.getElementById("floating-controls-toggle");
        if (floatToggle) floatToggle.addEventListener("click", toggleFloatingControls);
        var floatBackdrop = document.getElementById("floating-backdrop");
        if (floatBackdrop) floatBackdrop.addEventListener("click", hideFloatingControls);

        document.querySelectorAll(".quick-input").forEach(function(btn) {
          btn.addEventListener("click", function() {
            sendDirectInput(getControlInput(btn.dataset.inputKey || ""));
          });
        });

        var sessionModal = document.getElementById("session-modal");
        if (sessionModal) sessionModal.addEventListener("click", function(e) {
          if (e.target.id === "session-modal") closeSessionModal();
        });

        // Welcome view quick-start cards
        var quickGrid = document.getElementById("quick-start-grid");
        if (quickGrid) {
          quickGrid.addEventListener("click", function(e) {
            var target = e.target;
            var card = target.closest(".quick-card");
            if (!card) return;
            var cmd = card.dataset && card.dataset.command || "claude";
            quickStartSession(cmd);
          });
        }

        // Welcome view custom command button
        var customStartBtn = document.getElementById("welcome-custom-start");
        if (customStartBtn) {
          customStartBtn.addEventListener("click", function() {
            var inputEl = document.getElementById("welcome-custom-command");
            if (inputEl && inputEl.value.trim()) {
              quickStartSession(inputEl.value.trim());
            }
          });
        }
        var customInput = document.getElementById("welcome-custom-command");
        if (customInput) {
          customInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter") {
              var inputEl = e.target;
              if (inputEl.value.trim()) quickStartSession(inputEl.value.trim());
            }
          });
        }

        var inputBox = document.getElementById("input-box");
        if (inputBox) {
          inputBox.addEventListener("keydown", handleInputBoxKeydown);
          inputBox.addEventListener("paste", handleInputPaste);
          inputBox.addEventListener("focus", function() {
            // Close drawer when user focuses input to avoid backdrop blocking clicks
            closeSessionsDrawer();
          });
        }

        // View toggle handlers
        var viewTermBtn = document.getElementById("view-terminal-btn");
        if (viewTermBtn) viewTermBtn.addEventListener("click", function() { setView("terminal"); });
        var viewChatBtn = document.getElementById("view-chat-btn");
        if (viewChatBtn) viewChatBtn.addEventListener("click", function() { setView("chat"); });

        // Sidebar tabs
        var tabSessions = document.getElementById("tab-sessions");
        if (tabSessions) tabSessions.addEventListener("click", function() { setSidebarTab("sessions"); });
        var tabFiles = document.getElementById("tab-files");
        if (tabFiles) tabFiles.addEventListener("click", function() { setSidebarTab("files"); });

        // File explorer
        var fileRefresh = document.getElementById("file-explorer-refresh");
        if (fileRefresh) fileRefresh.addEventListener("click", refreshFileExplorer);

        initTerminal();
        setupMobileKeyboardHandlers();
        setupVisualViewportHandlers();
      }

      function handleSessionItemClick(event) {
        var target = event.target;
        if (!target || !(target instanceof Element)) return;
        var actionButton = target.closest("[data-action]");
        if (actionButton && actionButton instanceof HTMLElement) {
          event.preventDefault();
          event.stopPropagation();
          if (actionButton.dataset.action === "delete" && actionButton.dataset.sessionId) {
            deleteSession(actionButton.dataset.sessionId);
          } else if (actionButton.dataset.action === "resume" && actionButton.dataset.claudeSessionId) {
            startCommand("claude --resume " + actionButton.dataset.claudeSessionId, actionButton.dataset.cwd || "");
          }
          return;
        }
        var item = target.closest(".session-item");
        if (item && item.dataset.sessionId) {
          selectSession(item.dataset.sessionId);
          closeSessionsDrawer();
        }
      }

      function handleSessionItemKeydown(event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        var item = event.target.closest(".session-item");
        if (item && item.dataset.sessionId) {
          event.preventDefault();
          selectSession(item.dataset.sessionId);
          closeSessionsDrawer();
        }
      }

      function initTerminal() {
        var container = document.getElementById("output");
        if (!container || state.terminal) return;

        state.terminal = new Terminal({
          cols: 120,
          rows: 36,
          convertEol: false,
          disableStdin: true,
          cursorBlink: false,
          fontFamily: '"Geist Mono", "SF Mono", monospace',
          fontSize: 13,
          lineHeight: 1.5,
          theme: {
            background: "#1f1b17",
            foreground: "#f5eadc",
            cursor: "#d67b52",
            selectionBackground: "rgba(214, 123, 82, 0.28)",
            black: "#1f1b17",
            red: "#d27766",
            green: "#7fa36f",
            yellow: "#d5a35b",
            blue: "#87a9d9",
            magenta: "#c595c7",
            cyan: "#7fb3b1",
            white: "#f5eadc",
            brightBlack: "#625347",
            brightRed: "#e39a89",
            brightGreen: "#9cc08a",
            brightYellow: "#ebbb6e",
            brightBlue: "#a8c1ea",
            brightMagenta: "#dbb1dc",
            brightCyan: "#9acbca",
            brightWhite: "#fff7ef"
          }
        });

        state.fitAddon = new FitAddon.FitAddon();
        state.terminal.loadAddon(state.fitAddon);

        state.terminal.open(container);
        state.fitAddon.fit();

        if (state.selectedId) {
          var session = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (session && session.output) {
            var normalizedOutput = normalizeTerminalOutput(session.output);
            state.terminal.write(normalizedOutput);
            state.terminalOutput = normalizedOutput;
          }
        } else {
          state.terminal.writeln("点击上方「新对话」开始你的第一次对话。");
        }

        state.terminal.onData(function(data) { queueDirectInput(data); });
        container.addEventListener("click", focusInputBox);
        observeTerminalResize();
      }

      function login() {
        if (state.loginPending) return;

        var passwordEl = document.getElementById("password");
        var loginButton = document.getElementById("login-button");
        var errorEl = document.getElementById("login-error");

        hideError(errorEl);
        state.loginPending = true;
        loginButton.disabled = true;
        loginButton.textContent = "登录中...";

        fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: passwordEl.value }),
          credentials: "same-origin"
        })
        .then(function(res) {
          if (!res.ok) {
            showError(errorEl, "密码错误，请重试。");
            return Promise.reject("Invalid password");
          }
          return fetch("/api/config");
        })
        .then(function(res) { return res.json(); })
        .then(function(config) {
          state.config = config;
          var statusDot = document.getElementById("status-dot");
          var statusText = document.getElementById("status-text");
          if (statusDot) statusDot.classList.add("active");
          if (statusText) statusText.textContent = "已登录";
          return refreshAll();
        })
        .then(function() {
          startPolling();
          render();
        })
        .catch(function(error) {
          if (error !== "Invalid password") {
            showError(errorEl, "登录失败，请重试。");
          }
        })
        .finally(function() {
          state.loginPending = false;
          loginButton.disabled = false;
          loginButton.textContent = "进入控制台";
        });
      }

      function logout() {
        fetch("/api/logout", { method: "POST" }).catch(function() {});
        stopPolling();
        teardownTerminal();
        state.config = null;
        state.selectedId = null;
        state.sessions = [];
        state.sessionsDrawerOpen = false;
        render();
      }

      function refreshAll() {
        return loadSessions().then(function() {
          if (state.selectedId) return loadOutput(state.selectedId);
        });
      }

      function getModeLabel(mode) {
        return mode === "full-access"
          ? "全权限"
          : mode === "default"
            ? "默认"
            : mode === "native"
              ? "原生"
              : mode === "auto-edit"
                ? "自动编辑"
                : mode;
      }

      function inferToolFromCommand(command) {
        var base = String(command || "").trim().split(/\s+/)[0] || "";
        if (base === "claude") return "claude";
        if (base === "codex") return "codex";
        return "custom";
      }

      function getPreferredTool() {
        return inferToolFromCommand(state.preferredCommand) === "codex" ? "codex" : "claude";
      }

      function getComposerTool() {
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        var selectedTool = inferToolFromCommand(selectedSession && selectedSession.command ? selectedSession.command : "");
        if (selectedTool === "claude" || selectedTool === "codex") {
          return selectedTool;
        }
        return getPreferredTool();
      }

      function getSessionToolDescription(tool) {
        if (tool === "codex") {
          return "适合快速启动编码会话；不提供 Claude 的原生单轮模式。";
        }
        return "适合持续对话、恢复上下文，也支持原生单轮回复模式。";
      }

      function getToolModeHint(tool, mode) {
        if (mode === "full-access") {
          return "自动确认高权限操作，适合你确认环境安全后的连续修改。";
        }
        if (mode === "auto-edit") {
          return "保留交互式会话，同时更偏向直接编辑代码。";
        }
        if (mode === "native") {
          return tool === "claude"
            ? "按单轮消息调用 Claude 原生输出，适合快速问答或一次性生成。"
            : "Codex 不支持这里的原生单轮模式。";
        }
        return "保留标准交互流程，适合手动确认每一步。";
      }

      function getSupportedModes(tool) {
        return tool === "codex"
          ? ["default", "full-access", "auto-edit"]
          : ["default", "full-access", "auto-edit", "native"];
      }

      function getSafeModeForTool(tool, mode) {
        var supported = getSupportedModes(tool);
        if (supported.indexOf(mode) !== -1) return mode;
        var fallback = state.config && state.config.defaultMode ? state.config.defaultMode : "default";
        if (supported.indexOf(fallback) !== -1) return fallback;
        return supported[0];
      }

      function renderModeOptions(tool, selectedMode) {
        return getSupportedModes(tool).map(function(mode) {
          return '<option value="' + escapeHtml(mode) + '"' + (mode === selectedMode ? " selected" : "") + '>' +
            escapeHtml(getModeLabel(mode)) +
          '</option>';
        }).join("");
      }

      function replaceCommandBase(command, nextBase) {
        var trimmed = String(command || "").trim();
        if (!trimmed) return nextBase;
        var parts = trimmed.split(/\s+/);
        parts[0] = nextBase;
        return parts.join(" ");
      }

      function syncComposerModeSelect() {
        var select = document.getElementById("chat-mode-select");
        if (!select) return;
        var tool = getComposerTool();
        state.chatMode = getSafeModeForTool(tool, state.chatMode);
        select.innerHTML = renderModeOptions(tool, state.chatMode);
        select.value = state.chatMode;
      }

      function applyCurrentView() {
        var hasSession = !!state.selectedId;
        var terminalBtn = document.getElementById("view-terminal-btn");
        var chatBtn = document.getElementById("view-chat-btn");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");

        if (terminalBtn) terminalBtn.classList.toggle("active", state.currentView === "terminal");
        if (chatBtn) chatBtn.classList.toggle("active", state.currentView === "chat");
        if (terminalContainer) terminalContainer.classList.toggle("active", hasSession && state.currentView === "terminal");
        if (chatContainer) chatContainer.classList.toggle("active", hasSession && state.currentView === "chat");
      }

      function syncSessionModalUI() {
        var commandEl = document.getElementById("command");
        var modeEl = document.getElementById("mode");
        var toolHint = document.getElementById("tool-description");
        var modeHint = document.getElementById("mode-description");
        var previewEl = document.getElementById("session-command-preview");
        var tool = inferToolFromCommand(state.commandValue || state.preferredCommand || state.sessionTool || "claude");

        if (tool === "custom") {
          tool = state.sessionTool === "codex" ? "codex" : "claude";
        }

        state.sessionTool = tool;
        state.modeValue = getSafeModeForTool(tool, state.modeValue || state.chatMode || "default");

        document.querySelectorAll(".tool-card").forEach(function(card) {
          card.classList.toggle("active", card.dataset.tool === tool);
        });

        if (commandEl) {
          if (!commandEl.value.trim() && document.activeElement !== commandEl) {
            commandEl.value = tool;
            state.commandValue = tool;
          }
          commandEl.placeholder = tool === "codex"
            ? "codex --model gpt-5"
            : "claude --model sonnet";
        }

        if (modeEl) {
          modeEl.innerHTML = renderModeOptions(tool, state.modeValue);
          modeEl.value = state.modeValue;
        }

        if (toolHint) toolHint.textContent = getSessionToolDescription(tool);
        if (modeHint) modeHint.textContent = getToolModeHint(tool, state.modeValue);
        if (previewEl) previewEl.textContent = (commandEl && commandEl.value.trim()) || tool;
      }

      function updateSessionSnapshot(snapshot) {
        if (!snapshot || !snapshot.id) return;
        var updated = false;
        state.sessions = state.sessions.map(function(session) {
          if (session.id !== snapshot.id) return session;
          updated = true;
          // Merge snapshot fields into existing session to preserve all fields
          return Object.assign({}, session, snapshot);
        });
        if (!updated) {
          state.sessions.unshift(snapshot);
        }
      }

      function getPreferredSessionId(sessions) {
        if (!sessions || !sessions.length) return null;
        if (state.selectedId) {
          var selected = sessions.find(function(session) { return session.id === state.selectedId; });
          if (selected && selected.status === "running") return selected.id;
        }
        var runningSession = sessions.find(function(session) { return session.status === "running"; });
        return runningSession ? runningSession.id : null;
      }

      function loadSessions() {
        return fetch("/api/sessions")
          .then(function(res) {
            if (res.status === 401) {
              logout();
              return;
            }
            return res.json();
          })
          .then(function(sessions) {
            var serverSessions = sessions || [];
            var sessionIds = new Set(serverSessions.map(function(s) { return s.id; }));

            Object.keys(state.drafts).forEach(function(id) {
              if (!sessionIds.has(id)) delete state.drafts[id];
            });

            state.sessions = serverSessions.map(function(serverSession) {
              var localSession = state.sessions.find(function(s) { return s.id === serverSession.id; });
              if (localSession && localSession.output && localSession.output.length > (serverSession.output || '').length) {
                return localSession;
              }
              return serverSession;
            });

            state.selectedId = getPreferredSessionId(state.sessions);
            if (state.modalOpen) {
              updateSessionsList();
            } else {
              var listEl = document.getElementById("sessions-list");
              var rendered = renderSessions();
              if (listEl && listEl.innerHTML === rendered) {
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              } else {
                if (listEl) listEl.innerHTML = rendered;
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              }
            }
            updateShellChrome();
            if (state.selectedId) {
              loadOutput(state.selectedId);
            }
          });
      }


      function updateSessionsList() {
        var listEl = document.getElementById("sessions-list");
        var countEl = document.getElementById("session-count");
        if (listEl) listEl.innerHTML = renderSessions();
        if (countEl) countEl.textContent = String(state.sessions.length);
        updateShellChrome();
      }

      function updateShellChrome() {
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "Wand";
        var summaryEl = document.querySelector(".session-summary-value");
        var titleEl = document.getElementById("terminal-title");
        var infoEl = document.getElementById("terminal-info");
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");

        if (summaryEl) summaryEl.textContent = terminalTitle;
        if (titleEl) titleEl.textContent = terminalTitle;
        if (infoEl) {
          infoEl.textContent = selectedSession ? (getModeLabel(selectedSession.mode) + " | " + selectedSession.status) : "开始对话";
        }

        if (selectedSession) {
          if (blankChat) blankChat.classList.add("hidden");
          if (terminalContainer) terminalContainer.classList.remove("hidden");
          if (chatContainer) chatContainer.classList.remove("hidden");
          if (stopBtn) stopBtn.classList.remove("hidden");
        } else {
          if (blankChat) blankChat.classList.remove("hidden");
          if (terminalContainer) terminalContainer.classList.add("hidden");
          if (chatContainer) chatContainer.classList.add("hidden");
          if (stopBtn) stopBtn.classList.add("hidden");
        }
        syncComposerModeSelect();
        applyCurrentView();
      }

      function loadOutput(id) {
        // Cancel any pending debounced chat render to avoid flicker
        if (chatRenderTimer) {
          clearTimeout(chatRenderTimer);
          chatRenderTimer = null;
        }
        return fetch("/api/sessions/" + id)
          .then(function(res) { return res.json(); })
          .then(function(data) {
            updateSessionSnapshot(data);
            updateShellChrome();
            var terminalInfo = document.getElementById("terminal-info");
            if (terminalInfo) {
              terminalInfo.textContent = data.cwd + " | " + getModeLabel(data.mode) + " | " + data.status + " | exit=" + (data.exitCode ?? "n/a");
            }

            // Use structured messages if available (JSON chat mode), otherwise parse from PTY output
            var selectedSession = state.sessions.find(function(s) { return s.id === id; });
            if (selectedSession && selectedSession.messages && selectedSession.messages.length > 0) {
              state.currentMessages = selectedSession.messages;
            } else {
              state.currentMessages = parseMessages(selectedSession ? selectedSession.output : "", selectedSession ? selectedSession.command : "");
            }

            if (state.terminal) {
              if (state.terminalSessionId !== id) {
                state.terminal.reset();
                state.terminalOutput = "";
              }
              var newOutput = normalizeTerminalOutput(data.output || "");
              if (newOutput.startsWith(state.terminalOutput)) {
                state.terminal.write(newOutput.slice(state.terminalOutput.length));
              } else {
                state.terminal.reset();
                state.terminal.write(newOutput);
              }
              state.terminalSessionId = id;
              state.terminalOutput = newOutput;
              state.terminal.scrollToBottom();
            }

            renderChat();
          });
      }

      function selectSession(id) {
        state.selectedId = id;
        state.lastRenderedHash = 0;
        state.lastRenderedMsgCount = 0;
        state.lastRenderedEmpty = null;
        state.currentMessages = [];
        if (chatRenderTimer) { clearTimeout(chatRenderTimer); chatRenderTimer = null; }
        var session = state.sessions.find(function(item) { return item.id === id; });
        var inferredTool = inferToolFromCommand(session && session.command ? session.command : "");
        if (inferredTool === "claude" || inferredTool === "codex") {
          state.preferredCommand = inferredTool;
          state.chatMode = getSafeModeForTool(inferredTool, session && session.mode ? session.mode : state.chatMode);
        }
        updateSessionsList();
        switchToSessionView(id);
        loadOutput(id).then(focusInputBox);
      }

      function updateDrawerState() {
        var drawer = document.getElementById("sessions-drawer");
        var backdrop = document.getElementById("sessions-drawer-backdrop");
        var mainLayout = document.querySelector(".main-layout");
        if (drawer) {
          drawer.classList.toggle("open", state.sessionsDrawerOpen);
        }
        if (backdrop) {
          backdrop.classList.toggle("open", state.sessionsDrawerOpen);
        }
        if (mainLayout) {
          mainLayout.classList.toggle("sidebar-open", state.sessionsDrawerOpen);
        }
      }

      function toggleSessionsDrawer() {
        state.sessionsDrawerOpen = !state.sessionsDrawerOpen;
        updateDrawerState();
      }

      function closeSessionsDrawer() {
        if (!state.sessionsDrawerOpen) return;
        state.sessionsDrawerOpen = false;
        updateDrawerState();
      }

      function toggleTopbar() {
        state.topbarCollapsed = !state.topbarCollapsed;
        var topbar = document.querySelector('.topbar');
        var toggleBtn = document.getElementById('topbar-toggle-button');
        if (topbar) {
          topbar.classList.toggle('topbar-collapsed', state.topbarCollapsed);
          topbar.classList.toggle('topbar-expanded', !state.topbarCollapsed);
        }
        if (toggleBtn) {
          toggleBtn.textContent = state.topbarCollapsed ? '▾' : '▴';
        }
        // 触发终端重新调整大小
        setTimeout(function() {
          if (state.terminal && state.fitAddon) {
            state.fitAddon.fit();
          }
        }, 100);
      }

      function openSessionModal() {
        state.modalOpen = true;
        state.sessionsDrawerOpen = false;
        updateDrawerState();
        var modal = document.getElementById("session-modal");
        if (modal) {
          modal.classList.remove("hidden");
          var commandEl = document.getElementById("command");
          var defaultTool = getPreferredTool();
          var fallbackCommand = state.commandValue || state.preferredCommand || defaultTool;
          state.sessionTool = inferToolFromCommand(fallbackCommand) === "codex" ? "codex" : defaultTool;
          state.commandValue = fallbackCommand || state.sessionTool;
          state.modeValue = getSafeModeForTool(state.sessionTool, state.modeValue || state.chatMode);
          if (commandEl) commandEl.value = state.commandValue;
          syncSessionModalUI();
          setTimeout(function() { document.getElementById("command").focus(); }, 20);
        }
      }

      function closeSessionModal() {
        state.modalOpen = false;
        var modal = document.getElementById("session-modal");
        if (modal) modal.classList.add("hidden");
        hidePathSuggestions();
      }

      function openSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) {
          modal.classList.remove("hidden");
          document.getElementById("new-password").value = "";
          document.getElementById("confirm-password").value = "";
          hideSettingsMessages();
        }
      }

      function closeSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) modal.classList.add("hidden");
      }

      function hideSettingsMessages() {
        var errorEl = document.getElementById("settings-error");
        var successEl = document.getElementById("settings-success");
        if (errorEl) errorEl.classList.add("hidden");
        if (successEl) successEl.classList.add("hidden");
      }

      function savePassword() {
        var newPass = document.getElementById("new-password").value;
        var confirmPass = document.getElementById("confirm-password").value;
        var errorEl = document.getElementById("settings-error");
        var successEl = document.getElementById("settings-success");

        hideSettingsMessages();

        if (!newPass || newPass.length < 6) {
          errorEl.textContent = "密码长度至少为 6 个字符。";
          errorEl.classList.remove("hidden");
          return;
        }

        if (newPass !== confirmPass) {
          errorEl.textContent = "两次输入的密码不一致。";
          errorEl.classList.remove("hidden");
          return;
        }

        fetch("/api/set-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: newPass }),
          credentials: "same-origin"
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            errorEl.textContent = data.error;
            errorEl.classList.remove("hidden");
            return;
          }
          successEl.textContent = "密码修改成功！";
          successEl.classList.remove("hidden");
          document.getElementById("new-password").value = "";
          document.getElementById("confirm-password").value = "";
        })
        .catch(function() {
          errorEl.textContent = "Failed to save password.";
          errorEl.classList.remove("hidden");
        });
      }

      function populatePresets() {
        var select = document.getElementById("preset-select");
        if (!select || !state.config) return;

        select.innerHTML = '<option value="">Custom command</option>';
        (state.config.commandPresets || []).forEach(function(preset, i) {
          var opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = preset.label + " — " + preset.command;
          select.appendChild(opt);
        });
      }

      function applyPreset() {
        var select = document.getElementById("preset-select");
        var commandEl = document.getElementById("command");
        var modeEl = document.getElementById("mode");

        if (!select || !commandEl || !state.config || select.value === "") return;

        var preset = state.config.commandPresets[Number(select.value)];
        if (!preset) return;

        commandEl.value = preset.command;
        modeEl.value = preset.mode || state.config.defaultMode || "default";
        state.commandValue = commandEl.value;
        state.modeValue = modeEl.value;
      }

      function quickStartSession(command) {
        var defaultCwd = (state.config && state.config.defaultCwd) ? state.config.defaultCwd : "";
        var defaultMode = (state.config && state.config.defaultMode) ? state.config.defaultMode : "default";
        var inferredTool = inferToolFromCommand(command);
        if (inferredTool === "claude" || inferredTool === "codex") {
          state.preferredCommand = inferredTool;
          state.chatMode = getSafeModeForTool(inferredTool, state.chatMode);
        }
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: command, cwd: defaultCwd, mode: defaultMode })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return;
          }
          state.selectedId = data.id;
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          return refreshAll();
        })
        .then(focusInputBox)
        .catch(function() {
          showToast("无法启动命令。", "error");
        });
      }

      function runCommand() {
        var commandEl = document.getElementById("command");
        var cwdEl = document.getElementById("cwd");
        var modeEl = document.getElementById("mode");
        var errorEl = document.getElementById("modal-error");

        hideError(errorEl);

        var command = commandEl.value.trim();
        if (!command) {
          showError(errorEl, "请输入要执行的命令。");
          return;
        }

        var defaultCwd = (state.config && state.config.defaultCwd) ? state.config.defaultCwd : "";
        var selectedTool = inferToolFromCommand(command) === "codex" ? "codex" : "claude";
        var selectedMode = getSafeModeForTool(selectedTool, modeEl && modeEl.value ? modeEl.value : state.modeValue);
        state.modeValue = selectedMode;
        state.chatMode = selectedMode;
        state.sessionTool = selectedTool;
        state.preferredCommand = selectedTool;
        syncComposerModeSelect();

        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: command,
            cwd: cwdEl.value.trim() || defaultCwd,
            mode: selectedMode
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showError(errorEl, data.error);
            return;
          }
          state.selectedId = data.id;
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          closeSessionModal();
          closeSessionsDrawer();
          state.commandValue = command;
          return refreshAll();
        })
        .then(focusInputBox)
        .catch(function() {
          showError(errorEl, "无法启动命令。请检查命令是否正确安装。");
        });
      }

      function schedulePathSuggestions() {
        if (state.suggestionTimer) clearTimeout(state.suggestionTimer);
        state.suggestionTimer = setTimeout(loadPathSuggestions, 120);
      }

      function loadPathSuggestions() {
        var modal = document.getElementById("session-modal");
        if (modal && modal.classList.contains("hidden")) {
          hidePathSuggestions();
          return;
        }

        var cwdEl = document.getElementById("cwd");
        if (!cwdEl) return;

        fetch("/api/path-suggestions?q=" + encodeURIComponent(cwdEl.value.trim()))
          .then(function(res) { return res.json(); })
          .then(renderPathSuggestions)
          .catch(hidePathSuggestions);
      }

      function renderPathSuggestions(items) {
        var container = document.getElementById("cwd-suggestions");
        if (!container || !items.length) {
          hidePathSuggestions();
          return;
        }

        container.innerHTML = items.map(function(item) {
          return '<button class="suggestion-item" data-path="' + escapeHtml(item.path) + '">' +
            '<strong>' + escapeHtml(item.name) + '</strong>' +
            '<small>' + escapeHtml(item.path) + '</small>' +
          '</button>';
        }).join("");

        container.querySelectorAll(".suggestion-item").forEach(function(el) {
          el.addEventListener("click", function() {
            document.getElementById("cwd").value = el.dataset.path;
            state.cwdValue = el.dataset.path || "";
            hidePathSuggestions();
          });
        });

        container.classList.remove("hidden");
      }

      function hidePathSuggestions() {
        var container = document.getElementById("cwd-suggestions");
        if (container) {
          container.classList.add("hidden");
          container.innerHTML = "";
        }
      }

      function handleInputBoxKeydown(event) {
        if (event.isComposing) return;

        if (event.key === "Enter") {
          if (event.shiftKey) {
            event.preventDefault();
            var inputBox = document.getElementById("input-box");
            if (inputBox) {
              var start = inputBox.selectionStart || 0;
              var current = inputBox.value;
              var newValue = current.slice(0, start) + String.fromCharCode(10) + current.slice(start);
              inputBox.value = newValue;
              setDraftValue(newValue);
            }
            return;
          }
          event.preventDefault();
          sendInputFromBox(false);
          return;
        }

        if (event.key === "Backspace") {
          // Let default behavior handle the deletion, then sync state
          setTimeout(function() {
            var inputBox = document.getElementById("input-box");
            if (inputBox) {
              setDraftValue(inputBox.value);
            }
          }, 0);
          return;
        }

        if (event.key === "Tab") {
          event.preventDefault();
          var inputBox = document.getElementById("input-box");
          if (inputBox) {
            var start = inputBox.selectionStart || 0;
            var current = inputBox.value;
            var newValue = current.slice(0, start) + String.fromCharCode(9) + current.slice(start);
            inputBox.value = newValue;
            setDraftValue(newValue);
          }
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          queueDirectInput(getControlInput("escape"));
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_c"));
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_d"));
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_l"));
          return;
        }

        // Let browser handle all other keys naturally (including arrows, home, end, etc.)
        // Sync state after default behavior for character keys
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          setTimeout(function() {
            var inputBox = document.getElementById("input-box");
            if (inputBox) {
              setDraftValue(inputBox.value);
            }
          }, 0);
        }
      }

      function handleInputPaste(event) {
        var pasted = event.clipboardData && event.clipboardData.getData("text");
        if (!pasted) return;
        event.preventDefault();
        var inputBox = document.getElementById("input-box");
        if (inputBox) {
          var start = inputBox.selectionStart || 0;
          var end = inputBox.selectionEnd || 0;
          var current = inputBox.value;
          var newValue = current.slice(0, start) + pasted + current.slice(end);
          inputBox.value = newValue;
          setDraftValue(newValue);
        }
      }

      function queueDraftInput(text) {
        queueDirectInput(text);
        setDraftValue(getDraftValue() + text);
      }

      function getDraftValue() {
        return state.selectedId ? (state.drafts[state.selectedId] || "") : "";
      }

      function setDraftValue(value) {
        if (!state.selectedId) return;
        state.drafts[state.selectedId] = value;
        var inputBox = document.getElementById("input-box");
        if (inputBox) inputBox.value = value;
      }

      function isSelectedSessionRunning() {
        if (!state.selectedId) return false;
        var selectedSession = state.sessions.find(function(session) { return session.id === state.selectedId; });
        return !!selectedSession && selectedSession.status === "running";
      }

      // Send message from the welcome screen input
      function welcomeInputSend() {
        var welcomeInput = document.getElementById("welcome-input");
        var value = welcomeInput ? welcomeInput.value.trim() : "";
        if (!value) return;
        welcomeInput.value = "";
        welcomeInput.placeholder = "正在启动会话...";
        welcomeInput.disabled = true;
        var mode = state.chatMode || "full-access";
        var defaultCwd = (state.config && state.config.defaultCwd) ? state.config.defaultCwd : "";
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
            welcomeInput.disabled = false;
            return;
          }
          state.selectedId = data.id;
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          switchToSessionView(data.id);
          updateSessionSnapshot(data);
          updateSessionsList();
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: "subscribe", sessionId: data.id }));
          }
          loadOutput(data.id).then(function() {
            focusInputBox();
          });
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
          welcomeInput.placeholder = "输入你的问题，按 Enter 发送...";
          welcomeInput.disabled = false;
        });
      }

      function sendOrStart() {
        // Support welcome input as well as the main input box
        var welcomeInput = document.getElementById("welcome-input");
        var inputBox = document.getElementById("input-box");
        var value = (welcomeInput && welcomeInput.value.trim())
          ? welcomeInput.value.trim()
          : (inputBox ? inputBox.value.trim() : "");

        // If we have a selected ID, try to send input to it
        if (state.selectedId) {
          if (value) {
            sendInputFromBox(false);
          }
          return;
        }

        // No selected session, create a new one
        var mode = state.chatMode || "full-access";
        var defaultCwd = (state.config && state.config.defaultCwd) ? state.config.defaultCwd : "";
        var preferredTool = getPreferredTool();
        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: preferredTool,
            cwd: defaultCwd,
            mode: mode,
            initialInput: value || undefined
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            showToast(data.error, "error");
            return null;
          }
          state.selectedId = data.id;
          state.drafts[data.id] = "";
          state.lastRenderedHash = 0;
          state.lastRenderedMsgCount = 0;
          state.lastRenderedEmpty = null;
          if (inputBox) inputBox.value = "";
          if (welcomeInput) welcomeInput.value = "";
          switchToSessionView(data.id);
          updateSessionSnapshot(data);
          updateSessionsList();
          // Subscribe to new session via WebSocket
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'subscribe', sessionId: data.id }));
          }
          return loadOutput(data.id);
        })
        .catch(function(error) {
          showToast((error && error.message) || "无法启动会话。", "error");
        });
      }

      function switchToSessionView(sessionId) {
        var session = state.sessions.find(function(s) { return s.id === sessionId; });
        var blankChat = document.getElementById("blank-chat");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var stopBtn = document.getElementById("stop-button");
        var terminalTitle = document.getElementById("terminal-title");
        var terminalInfo = document.getElementById("terminal-info");
        var sessionSummary = document.querySelector(".session-summary-value");

        if (blankChat) blankChat.classList.add("hidden");
        if (terminalContainer) terminalContainer.classList.remove("hidden");
        if (chatContainer) {
          chatContainer.classList.remove("hidden");
        }
        if (stopBtn) stopBtn.classList.remove("hidden");

        var title = session ? shortCommand(session.command) : "Wand";
        var modeName = session ? getModeLabel(session.mode) : "";
        var info = session ? (modeName + " | " + session.status) : "";
        if (terminalTitle) terminalTitle.textContent = title;
        if (terminalInfo) terminalInfo.textContent = info;
        if (sessionSummary) sessionSummary.textContent = title;

        // Init terminal if not already done
        if (!state.terminal) initTerminal();
        applyCurrentView();
        if (state.currentView === "terminal") {
          setTimeout(scheduleTerminalResize, 40);
        }
        renderChat();
        focusInputBox();
      }


      function sendInputFromBox(appendEnter) {
        var inputBox = document.getElementById("input-box");
        var value = inputBox ? inputBox.value : "";
        if (value) {
          // Send text + Enter as a single call to avoid race conditions
          var combinedInput = value + getControlInput("enter");
          // Clear the input box immediately to prevent double-sending
          if (inputBox) inputBox.value = "";
          setDraftValue("");
          return queueDirectInput(combinedInput).catch(function(err) {
            showToast(err.message || "会话已结束，请重启会话。", "error");
            throw err;
          });
        }
        if (appendEnter) {
          return queueDirectInput(getControlInput("enter")).catch(function() {
            return Promise.resolve();
          });
        }
        return Promise.resolve();
      }

      function sendDirectInput(input) {
        return queueDirectInput(input);
      }

      function toggleFloatingControls() {
        var panel = document.getElementById("floating-controls");
        var backdrop = document.getElementById("floating-backdrop");
        if (!panel) return;
        var isHidden = panel.classList.contains("hidden");
        panel.classList.toggle("hidden", !isHidden);
        if (backdrop) backdrop.classList.toggle("hidden", !isHidden);
      }

      function hideFloatingControls() {
        var panel = document.getElementById("floating-controls");
        var backdrop = document.getElementById("floating-backdrop");
        if (panel) panel.classList.add("hidden");
        if (backdrop) backdrop.classList.add("hidden");
      }

      function getControlInput(key) {
        switch (key) {
          case "yes":
            return "y" + String.fromCharCode(13);
          case "no":
            return "n" + String.fromCharCode(13);
          case "up":
            return String.fromCharCode(27) + "[A";
          case "down":
            return String.fromCharCode(27) + "[B";
          case "left":
            return String.fromCharCode(27) + "[D";
          case "right":
            return String.fromCharCode(27) + "[C";
          case "enter":
            return String.fromCharCode(13);
          case "ctrl_c":
            return String.fromCharCode(3);
          case "ctrl_d":
            return String.fromCharCode(4);
          case "ctrl_l":
            return String.fromCharCode(12);
          case "escape":
            return String.fromCharCode(27);
          default:
            return "";
        }
      }

      function queueDirectInput(input) {
        if (!input || !state.selectedId) return Promise.resolve();
        state.inputQueue = state.inputQueue.then(function() { return postInput(input); });
        return state.inputQueue;
      }

      function postInput(input) {
        if (!state.selectedId) return Promise.resolve();
        return fetch("/api/sessions/" + state.selectedId + "/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: input })
        })
        .then(function(res) {
          if (!res.ok) {
            return res.json().then(function(data) {
              throw new Error(data.error || "会话已结束。");
            });
          }
          return res.json();
        });
      }

      function stopSession() {
        if (!state.selectedId) return;
        fetch("/api/sessions/" + state.selectedId + "/stop", { method: "POST" })
          .then(refreshAll);
      }

      function deleteSession(id) {
        fetch("/api/sessions/" + id, { method: "DELETE" })
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.error) {
              throw new Error(data.error);
            }
            if (state.selectedId === id) {
              state.selectedId = null;
            }
            return refreshAll();
          })
          .catch(function() {
            var errorEl = document.getElementById("action-error");
            showError(errorEl, "无法删除会话。");
          });
      }

      function startCommand(command, cwd, errorEl) {
        var inferredTool = inferToolFromCommand(command);
        if (inferredTool === "claude" || inferredTool === "codex") {
          state.preferredCommand = inferredTool;
          state.chatMode = getSafeModeForTool(inferredTool, state.chatMode);
        }
        return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: command,
            cwd: cwd || "",
            mode: state.chatMode || state.config.defaultMode || "default"
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            if (errorEl) showError(errorEl, data.error);
            return null;
          }
          state.selectedId = data.id;
          state.drafts[data.id] = "";
          return data;
        });
      }

      function focusInputBox() {
        var inputBox = document.getElementById("input-box");
        if (!inputBox || !state.selectedId) return;
        if (document.activeElement === inputBox) return;
        inputBox.focus();
        inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length);
      }

      // Mobile keyboard handling
      function setupMobileKeyboardHandlers() {
        if (!('virtualKeyboard' in navigator)) return;

        var vk = navigator.virtualKeyboard;
        var inputPanel = document.querySelector('.input-panel');

        vk.addEventListener('geometrychange', function() {
          if (inputPanel) {
            var rect = vk.boundingRect;
            inputPanel.style.paddingBottom = rect ? rect.height + 'px' : '';
          }
        });

        // Show virtual keyboard on terminal tap
        document.getElementById('output')?.addEventListener('click', function() {
          if (state.selectedId) {
            var inputBox = document.getElementById('input-box');
            if (inputBox) inputBox.focus();
          }
        });
      }

      // Visual viewport handling for better mobile keyboard support
      function setupVisualViewportHandlers() {
        if (!('visualViewport' in window)) return;

        var vv = window.visualViewport;
        var inputPanel = document.querySelector('.input-panel');

        function updateViewport() {
          if (!inputPanel || !vv) return;
          var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
          inputPanel.style.transform = offsetBottom > 0 ? 'translateY(-' + offsetBottom + 'px)' : '';
        }

        vv.addEventListener('resize', updateViewport);
        vv.addEventListener('scroll', updateViewport);
      }

      function observeTerminalResize() {
        var output = document.getElementById("output");
        if (!output) return;

        if (typeof ResizeObserver === "function") {
          state.resizeObserver = new ResizeObserver(function() { scheduleTerminalResize(); });
          state.resizeObserver.observe(output);
        }
        state.resizeHandler = scheduleTerminalResize;
        window.addEventListener("resize", state.resizeHandler);
        requestAnimationFrame(scheduleTerminalResize);
      }

      function teardownTerminal() {
        if (state.resizeObserver) {
          state.resizeObserver.disconnect();
          state.resizeObserver = null;
        }
        if (state.resizeHandler) {
          window.removeEventListener("resize", state.resizeHandler);
          state.resizeHandler = null;
        }
        if (state.terminal) {
          state.terminal.dispose();
          state.terminal = null;
        }
        state.fitAddon = null;
        state.terminalSessionId = null;
      }

      function scheduleTerminalResize() {
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(syncTerminalSize, 60);
      }

      function syncTerminalSize() {
        var output = document.getElementById("output");
        if (!state.terminal || !state.fitAddon || !output) return;

        state.fitAddon.fit();

        var nextSize = {
          cols: state.terminal.cols,
          rows: state.terminal.rows
        };

        if (!state.selectedId) return;

        // Only send resize API call if dimensions actually changed
        if (state.lastResize.cols !== nextSize.cols || state.lastResize.rows !== nextSize.rows) {
          state.lastResize = nextSize;
          fetch("/api/sessions/" + state.selectedId + "/resize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextSize)
          }).catch(function() {});
        }
      }

      function startPolling() {
        stopPolling();
        // Use WebSocket if available, fallback to polling
        if (initWebSocket()) {
          // WebSocket connected, initial load
          refreshAll();
          return;
        }
        // Fallback to HTTP polling
        state.pollTimer = setInterval(refreshAll, 1600);
      }

      function initWebSocket() {
        if (!window.WebSocket) return false;

        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var wsUrl = protocol + '//' + window.location.host + '/ws';

        try {
          var ws = new WebSocket(wsUrl);

          ws.onopen = function() {
            state.ws = ws;
            state.wsConnected = true;
            // Subscribe to current session if any
            if (state.selectedId) {
              ws.send(JSON.stringify({ type: 'subscribe', sessionId: state.selectedId }));
            }
          };

          ws.onmessage = function(event) {
            try {
              var msg = JSON.parse(event.data);
              handleWebSocketMessage(msg);
            } catch (e) {
              // Ignore parse errors
            }
          };

          ws.onclose = function() {
            state.ws = null;
            state.wsConnected = false;
            // Reconnect after 2 seconds
            setTimeout(function() {
              if (state.config && !state.ws) {
                initWebSocket();
              }
            }, 2000);
          };

          ws.onerror = function() {
            ws.close();
          };

          return true;
        } catch (e) {
          return false;
        }
      }

      function handleWebSocketMessage(msg) {
        switch (msg.type) {
          case 'output':
            // Update session output (for terminal display and local message parsing)
            if (msg.data && msg.data.output && msg.sessionId) {
              var snapshot = { id: msg.sessionId, output: msg.data.output };
              // Pass structured messages if available from JSON chat mode
              if (msg.data.messages) {
                snapshot.messages = msg.data.messages;
              }
              updateSessionSnapshot(snapshot);
              // Schedule debounced chat update (don't parse on every chunk to avoid flicker)
              scheduleChatRender();
            }
            // Real-time terminal output
            if (msg.sessionId === state.selectedId && state.terminal && msg.data && msg.data.output) {
              var newOutput = normalizeTerminalOutput(msg.data.output || "");
              if (newOutput.startsWith(state.terminalOutput)) {
                state.terminal.write(newOutput.slice(state.terminalOutput.length));
              } else {
                state.terminal.reset();
                state.terminal.write(newOutput);
              }
              state.terminalOutput = newOutput;
              state.terminal.scrollToBottom();
            }
            break;
          case 'started':
            // New session started
            loadSessions();
            break;
          case 'ended':
            // Session ended
            loadSessions();
            if (msg.sessionId === state.selectedId) {
              loadOutput(msg.sessionId);
            }
            // Update chat view
            if (state.currentView === "chat" && msg.sessionId === state.selectedId) {
              renderChat();
            }
            break;
          case 'init':
            // Initial state for subscribed session
            if (msg.sessionId === state.selectedId && msg.data) {
              if (chatRenderTimer) { clearTimeout(chatRenderTimer); chatRenderTimer = null; }
              updateTerminalOutput(msg.data.output || "");
              if (state.currentView === "chat") {
                renderChat();
              }
            }
            break;
        }
      }

      function updateTerminalOutput(output) {
        if (!state.terminal) return;
        var normalized = normalizeTerminalOutput(output);
        if (normalized.startsWith(state.terminalOutput)) {
          state.terminal.write(normalized.slice(state.terminalOutput.length));
        } else {
          state.terminal.reset();
          state.terminal.write(normalized);
        }
        state.terminalOutput = normalized;
        state.terminal.scrollToBottom();
      }

      function stopPolling() {
        if (state.pollTimer) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      }

      function setView(view) {
        if (state.currentView === view) return;
        state.currentView = view;
        applyCurrentView();
        if (view === "terminal") {
          setTimeout(scheduleTerminalResize, 40);
        }

        // Render chat if switching to chat view
        if (view === "chat") {
          renderChat();
        }
      }

      function renderChat() {
        if (state.renderPending) return;
        state.renderPending = true;

        requestAnimationFrame(function() {
          doRenderChat();
          state.renderPending = false;
        });
      }

      var chatRenderTimer = null;
      function scheduleChatRender() {
        if (chatRenderTimer) return;
        chatRenderTimer = setTimeout(function() {
          chatRenderTimer = null;
          // Re-parse messages from the latest session output
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          if (selectedSession) {
            // Prefer structured messages from JSON chat mode
            if (selectedSession.messages && selectedSession.messages.length > 0) {
              state.currentMessages = selectedSession.messages;
            } else if (selectedSession.output) {
              state.currentMessages = parseMessages(selectedSession.output, selectedSession.command);
            }
          }
          renderChat();
        }, 300);
      }

      function doRenderChat() {
        var chatOutput = document.getElementById("chat-output");
        if (!chatOutput) return;

        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSession) {
          if (state.lastRenderedEmpty !== "none") {
            chatOutput.innerHTML = '<div class="empty-state"><strong>未选择会话</strong><br>点击上方「新对话」开始你的第一次对话。</div>';
            state.lastRenderedEmpty = "none";
            state.lastRenderedMsgCount = 0;
          }
          return;
        }

        var messages = state.currentMessages;

        if (messages.length === 0) {
          if (state.lastRenderedEmpty !== "empty") {
            chatOutput.innerHTML = '<div class="empty-state"><strong>对话已开始</strong><br>在下方输入框发送消息，Claude 会自动回复。</div>';
            state.lastRenderedEmpty = "empty";
            state.lastRenderedMsgCount = 0;
          }
          return;
        }

        // Check if messages actually changed
        var msgCount = messages.length;
        var outputHash = selectedSession.output ? selectedSession.output.length : 0;
        // For structured messages, also hash the total content blocks count
        if (selectedSession.messages && selectedSession.messages.length > 0) {
          var totalBlocks = 0;
          for (var bi = 0; bi < selectedSession.messages.length; bi++) {
            totalBlocks += (selectedSession.messages[bi].content ? selectedSession.messages[bi].content.length : 0);
          }
          outputHash = msgCount * 1000 + totalBlocks;
        }
        if (msgCount === state.lastRenderedMsgCount && outputHash === state.lastRenderedHash) {
          return;
        }
        state.lastRenderedMsgCount = msgCount;
        state.lastRenderedHash = outputHash;

        var chatMessages = chatOutput.querySelector(".chat-messages");
        if (!chatMessages) {
          // First render - create container
          chatOutput.innerHTML = '<div class="chat-messages"></div>';
          chatMessages = chatOutput.querySelector(".chat-messages");
        }

        var existingCount = chatMessages.querySelectorAll(".chat-message").length;

        if (existingCount === 0) {
          // Full render for first load
          chatMessages.innerHTML = messages.map(renderChatMessage).join("");
        } else if (msgCount > existingCount) {
          // Incremental: only append new messages
          for (var i = existingCount; i < messages.length; i++) {
            var div = document.createElement("div");
            div.innerHTML = renderChatMessage(messages[i]);
            var el = div.firstElementChild;
            if (el) {
              chatMessages.appendChild(el);
              attachCopyHandler(el);
            }
          }
        } else {
          // Message count decreased (session switched or output truncated) - full re-render
          chatMessages.innerHTML = messages.map(renderChatMessage).join("");
          attachAllCopyHandlers(chatMessages);
        }

        // Scroll to bottom
        chatOutput.scrollTop = chatOutput.scrollHeight;
      }

      function attachCopyHandler(el) {
        el.querySelectorAll(".code-copy").forEach(function(btn) {
          btn.addEventListener("click", function() {
            var codeBlock = btn.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              navigator.clipboard.writeText(code.textContent || "").then(function() {
                btn.textContent = "Copied!";
                btn.classList.add("copied");
                setTimeout(function() {
                  btn.textContent = "Copy";
                  btn.classList.remove("copied");
                }, 2000);
              });
            }
          });
        });
      }

      function attachAllCopyHandlers(container) {
        container.querySelectorAll(".code-copy").forEach(function(btn) {
          // Remove existing listeners by cloning
          var clone = btn.cloneNode(true);
          btn.parentNode.replaceChild(clone, btn);
          clone.addEventListener("click", function() {
            var codeBlock = clone.closest(".code-block");
            var code = codeBlock ? codeBlock.querySelector("code") : null;
            if (code) {
              navigator.clipboard.writeText(code.textContent || "").then(function() {
                clone.textContent = "Copied!";
                clone.classList.add("copied");
                setTimeout(function() {
                  clone.textContent = "Copy";
                  clone.classList.remove("copied");
                }, 2000);
              });
            }
          });
        });
      }

      function parseMessages(output, command) {
        var messages = [];
        if (!output) return messages;

        var text = String(output || "");
        var newline = String.fromCharCode(10);
        var carriageReturn = String.fromCharCode(13);
        var ansiStripped = text.replace(
          /\\x1b\[[0-9;?]*[a-zA-Z]|\\x1b\][^\\x07]*(\\x07|\\x1b\\\\)|\\x1b[><=eP_X^]|[\\x00-\\x08\\x0b-\\x0c\\x0e-\\x1f]|\\xa0|\\r/g,
          function(m) { return m === '\\xa0' ? ' ' : m === '\\r' ? newline : ''; }
        ).split(carriageReturn).join(newline);

        var lines = ansiStripped.split(newline).map(function(line) { return line.trim(); }).filter(Boolean);

        // Extract thinking/deep thought content
        var thinkingPatterns = [
          /thinking with high effort/i,
          /thinking with medium effort/i,
          /thinking with low effort/i,
          /thought for \d+s/i,
          /Sauteed for \d+m/i,
          /Germinating/i,
          /Doodling/i,
          /Brewing/i
        ];

        // Find the most recent thinking line (usually appears after user input)
        var lastThinkingLine = null;
        var userCmdIndex = -1;

        // Separate different types of content
        var promptLines = [];  // Try "..." suggestions
        var contentLines = []; // Actual conversation content
        var thinkingLines = [];

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];

          // Check for prompt suggestions (Try "..." pattern, including after ❯)
          var lineForPromptCheck = line.replace(/^❯\s*/, "");
          if (lineForPromptCheck.indexOf('Try"') === 0 || lineForPromptCheck.indexOf('Try "') === 0) {
            promptLines.push(lineForPromptCheck);
            continue;
          }

          // Check for thinking content
          var isThinking = false;
          for (var p = 0; p < thinkingPatterns.length; p++) {
            if (thinkingPatterns[p].test(line)) {
              isThinking = true;
              thinkingLines.push(line);
              break;
            }
          }
          if (isThinking) continue;

          // Filter noise
          if (!line) continue;
          if (line.indexOf("────────────────") === 0) continue;
          if (line === "❯") continue;
          if (line.indexOf("esc to interrupt") !== -1) continue;
          if (line.indexOf("Claude Code v") !== -1) continue;
          if (line.indexOf("Sonnet") !== -1) continue;
          if (line.indexOf("~/") === 0) continue;
          if (line.indexOf("● high") !== -1) continue;
          if (line.indexOf("Failed to install Anthropic marketplace") !== -1) continue;
          if (line.indexOf("Claude Code has switched from npm to native installer") !== -1) continue;
          if (line.indexOf("Fluttering") !== -1) continue;
          if (line.indexOf("? for shortcuts") !== -1) continue;
          if (line.indexOf("0;") === 0) continue;
          if (line.indexOf("9;") === 0) continue;
          if (line.indexOf("Claude is waiting") !== -1) continue;
          if (line.indexOf("✢") !== -1 || line.indexOf("✳") !== -1 || line.indexOf("✶") !== -1 || line.indexOf("✻") !== -1 || line.indexOf("✽") !== -1) continue;
          if (line.indexOf("▐") === 0 || line.indexOf("▝") === 0 || line.indexOf("▘") === 0) continue;
          if ((line === "lu" || line === "ue" || line === "tr" || line === "ti" || line === "g" || line === "n" || line === "i…" || line === "…" || line === "uts" || line === "lt" || line === "rg" || line === "·") && line.length < 4) continue;
          if (line.indexOf("✽F") === 0 || line.indexOf("✻F") === 0) continue;

          contentLines.push(line);
        }

        // Add thinking message (most recent one, deduplicated)
        if (thinkingLines.length > 0) {
          var lastThinking = thinkingLines[thinkingLines.length - 1];
          var durationMatch = lastThinking.match(/for (\d+[ms]+| \d+m \d+s)/i);
          var thinkingText = durationMatch ? "深度思考 " + durationMatch[0].replace(/for /i, "") : "深度思考中...";
          messages.push({ role: "thinking", content: thinkingText, type: "deep-thought" });
        }

        // Add prompt suggestion as a special message (pulsing display)
        if (promptLines.length > 0) {
          var promptText = promptLines[promptLines.length - 1].replace(/^Try\s*/, "").trim();
          messages.push({ role: "prompt", content: promptText, type: "suggestion" });
        }

        if (!contentLines.length) return messages;

        // Find user command in content lines
        var userCmdIndex = -1;
        var userText = "";

        for (var i = 0; i < contentLines.length; i++) {
          var line = contentLines[i];

          // Check for ❯ prompt followed by actual user input (not Try"..." suggestion)
          if (line.indexOf("❯") === 0) {
            var afterPrompt = line.replace(/^❯\s*/, "");
            if (afterPrompt.indexOf('Try"') !== 0 && afterPrompt.indexOf('Try "') !== 0 && afterPrompt.trim()) {
              userCmdIndex = i;
              userText = afterPrompt.trim();
              break;
            }
          }
        }

        // If no ❯ prompt found, look for standalone user input (lines that look like user commands)
        // This handles cases where the user input appears without the ❯ prefix
        if (!userText) {
          for (var i = 0; i < contentLines.length; i++) {
            var line = contentLines[i];
            // Skip noise lines and system messages
            if (line.indexOf('Try"') === 0 || line.indexOf('Try "') === 0) continue;
            if (line.indexOf('Failed to install') !== -1) continue;
            if (line.indexOf('ctrl+g') !== -1) continue;
            if (line.indexOf('● ') === 0) continue;
            if (line.indexOf('Claude Code has switched') !== -1) continue;
            if (line.indexOf('esctointerrupt') !== -1) continue;
            if (line.length < 2 || line.length > 100) continue;
            // Looks like user input (starts with letter, reasonable length)
            if (/^[a-zA-Z]/.test(line)) {
              userText = line.trim();
              userCmdIndex = i;
              break;
            }
          }
        }

        if (userText) {
          messages.push({ role: "user", content: userText });
        }

        var assistantLines = contentLines.slice(userCmdIndex + 1).filter(function(line) {
          if (line.indexOf("⏺") !== -1 && (line.indexOf("Hi!") !== -1 || line.indexOf("Hello") !== -1 || line.indexOf("What") !== -1 || line.indexOf("working") !== -1)) return true;
          if (line.indexOf("⏺") === 0) return true;
          if (line.length < 8) return false;
          if (line.indexOf("✢") !== -1 || line.indexOf("✳") !== -1 || line.indexOf("✶") !== -1 || line.indexOf("✻") !== -1 || line.indexOf("✽") !== -1) return false;
          if (line.indexOf("▐") === 0 || line.indexOf("▝") === 0 || line.indexOf("▘") === 0) return false;
          if (line.indexOf("❯") === 0) return false;
          if (line.indexOf("esctointerrupt") !== -1) return false;
          if (line.indexOf("?for") === 0 || line.indexOf("? for") === 0) return false;
          return true;
        });

        if (assistantLines.length) {
          messages.push({ role: "assistant", content: assistantLines.join(newline) });
        }

        return messages;
      }

      function renderChatMessage(msg) {
        // Thinking card (deep thought) — from PTY parsing
        if (msg.role === "thinking") {
          return '<div class="chat-message thinking">' +
            '<div class="thinking-card">' +
              '<div class="thinking-icon">🤔</div>' +
              '<div class="thinking-content">' + escapeHtml(msg.content) + '</div>' +
            '</div>' +
          '</div>';
        }

        // Prompt suggestion card (pulsing display) — from PTY parsing
        if (msg.role === "prompt") {
          return '<div class="chat-message prompt">' +
            '<div class="prompt-card">' +
              '<div class="prompt-icon">💡</div>' +
              '<div class="prompt-content">试试：<span class="prompt-text">' + escapeHtml(msg.content) + '</span></div>' +
            '</div>' +
          '</div>';
        }

        // Structured content blocks (from JSON chat mode)
        if (Array.isArray(msg.content)) {
          return renderStructuredMessage(msg);
        }

        // Legacy string content (from PTY parsing)
        var avatar = msg.role === "assistant" ? '<div class="chat-message-avatar">AI</div>' : "";
        var bubbleContent = msg.role === "assistant" ? renderMarkdown(msg.content) : escapeHtml(msg.content);
        return '<div class="chat-message ' + msg.role + '">' +
          avatar +
          '<div class="chat-message-bubble">' + bubbleContent + '</div>' +
        '</div>';
      }

      function renderStructuredMessage(msg) {
        var role = msg.role;
        var avatar = role === "assistant" ? '<div class="chat-message-avatar">AI</div>' : "";
        var blocksHtml = "";

        for (var i = 0; i < msg.content.length; i++) {
          var block = msg.content[i];
          blocksHtml += renderContentBlock(block, role);
        }

        return '<div class="chat-message ' + role + '">' +
          avatar +
          '<div class="chat-message-bubble">' + blocksHtml + '</div>' +
        '</div>';
      }

      function renderContentBlock(block, role) {
        if (!block || !block.type) return "";

        switch (block.type) {
          case "text":
            return role === "assistant" ? renderMarkdown(block.text || "") : escapeHtml(block.text || "");

          case "thinking":
            return '<div class="thinking-card inline-thinking">' +
              '<div class="thinking-icon">🤔</div>' +
              '<div class="thinking-content">' +
                '<details><summary>深度思考</summary>' +
                '<div class="thinking-text">' + escapeHtml(block.thinking || "") + '</div>' +
                '</details>' +
              '</div>' +
            '</div>';

          case "tool_use":
            var toolName = escapeHtml(block.name || "unknown");
            var inputStr = "";
            try {
              inputStr = JSON.stringify(block.input || {}, null, 2);
            } catch (e) {
              inputStr = String(block.input || "");
            }
            return '<div class="tool-use-card">' +
              '<details>' +
                '<summary class="tool-use-header">' +
                  '<span class="tool-icon">🔧</span> ' +
                  '<span class="tool-name">' + toolName + '</span>' +
                '</summary>' +
                '<div class="tool-use-body">' +
                  '<pre class="tool-input"><code>' + escapeHtml(inputStr) + '</code></pre>' +
                '</div>' +
              '</details>' +
            '</div>';

          case "tool_result":
            var content = block.content || "";
            var isError = block.is_error;
            var statusClass = isError ? "tool-result-error" : "tool-result-success";
            var statusIcon = isError ? "❌" : "✅";
            // Truncate long results
            var displayContent = content.length > 500 ? content.slice(0, 500) + "..." : content;
            return '<div class="tool-result-card ' + statusClass + '">' +
              '<details>' +
                '<summary class="tool-result-header">' +
                  statusIcon + ' 工具结果' +
                '</summary>' +
                '<div class="tool-result-body">' +
                  '<pre class="tool-result-content"><code>' + escapeHtml(displayContent) + '</code></pre>' +
                '</div>' +
              '</details>' +
            '</div>';

          default:
            return '<div class="unknown-block">' + escapeHtml(JSON.stringify(block)) + '</div>';
        }
      }

      function renderMarkdown(text) {
        if (!text) return "";

        var result = escapeHtml(text);
        var bt = String.fromCharCode(96);
        var newline = String.fromCharCode(10);

        function replacePair(source, marker, openTag, closeTag) {
          var cursor = 0;
          while (true) {
            var start = source.indexOf(marker, cursor);
            if (start === -1) break;
            var end = source.indexOf(marker, start + marker.length);
            if (end === -1) break;
            var inner = source.slice(start + marker.length, end);
            if (!inner) {
              cursor = end + marker.length;
              continue;
            }
            var replacement = openTag + inner + closeTag;
            source = source.slice(0, start) + replacement + source.slice(end + marker.length);
            cursor = start + replacement.length;
          }
          return source;
        }

        function replaceLinePrefix(source, marker, openTag, closeTag) {
          return source.split(newline).map(function(line) {
            if (line.indexOf(marker) !== 0) return line;
            return openTag + line.slice(marker.length) + closeTag;
          }).join(newline);
        }

        function replaceOrderedList(source) {
          return source.split(newline).map(function(line) {
            var dotIndex = line.indexOf('. ');
            if (dotIndex <= 0) return line;
            for (var i = 0; i < dotIndex; i += 1) {
              var code = line.charCodeAt(i);
              if (code < 48 || code > 57) return line;
            }
            return '<li>' + line.slice(dotIndex + 2) + '</li>';
          }).join(newline);
        }

        function wrapParagraphs(source) {
          return source.split(newline + newline).map(function(part) {
            var block = part.trim();
            if (!block) return "";
            if (block.indexOf("<div") === 0 || block.indexOf("<h1") === 0 || block.indexOf("<h2") === 0 || block.indexOf("<h3") === 0 || block.indexOf("<h4") === 0 || block.indexOf("<h5") === 0 || block.indexOf("<h6") === 0 || block.indexOf("<ul") === 0 || block.indexOf("<ol") === 0 || block.indexOf("<li") === 0 || block.indexOf("<blockquote") === 0 || block.indexOf("<pre") === 0) {
              return block;
            }
            return '<p>' + block.split(newline).join('<br>') + '</p>';
          }).join("");
        }

        var pos = 0;
        while (true) {
          var start = result.indexOf(bt + bt + bt, pos);
          if (start === -1) break;
          var endTag = result.indexOf(bt + bt + bt, start + 3);
          if (endTag === -1) break;

          var codeBlock = result.slice(start + 3, endTag);
          var langLineEnd = codeBlock.indexOf(newline);
          var lang = "";
          var code = codeBlock;
          if (langLineEnd !== -1 && langLineEnd < 30) {
            var potentialLang = codeBlock.slice(0, langLineEnd).trim();
            var isSimpleLang = potentialLang.length > 0;
            for (var j = 0; j < potentialLang.length; j += 1) {
              var langCode = potentialLang.charCodeAt(j);
              var isDigit = langCode >= 48 && langCode <= 57;
              var isUpper = langCode >= 65 && langCode <= 90;
              var isLower = langCode >= 97 && langCode <= 122;
              if (!isDigit && !isUpper && !isLower) {
                isSimpleLang = false;
                break;
              }
            }
            if (isSimpleLang) {
              lang = potentialLang;
              code = codeBlock.slice(langLineEnd + 1);
            }
          }

          var highlighted = highlightCode(code.trim(), lang);
          var replacement = '<div class="code-block">' +
            '<div class="code-block-header">' +
              '<span class="code-lang">' + (lang || "code") + '</span>' +
              '<button class="code-copy">Copy</button>' +
            '</div>' +
            '<pre><code>' + highlighted + '</code></pre>' +
          '</div>';
          result = result.slice(0, start) + replacement + result.slice(endTag + 3);
          pos = start + replacement.length;
        }

        pos = 0;
        while (true) {
          var inlineStart = result.indexOf(bt, pos);
          if (inlineStart === -1) break;
          var inlineEnd = result.indexOf(bt, inlineStart + 1);
          if (inlineEnd === -1) break;
          if (inlineEnd === inlineStart + 1) {
            pos = inlineEnd + 1;
            continue;
          }
          var inlineCode = result.slice(inlineStart + 1, inlineEnd);
          var inlineReplacement = '<code class="code-inline">' + inlineCode + '</code>';
          result = result.slice(0, inlineStart) + inlineReplacement + result.slice(inlineEnd + 1);
          pos = inlineStart + inlineReplacement.length;
        }

        result = replacePair(result, "**", '<strong>', '</strong>');
        result = replacePair(result, "*", '<em>', '</em>');
        result = replacePair(result, "_", '<em>', '</em>');
        result = replaceLinePrefix(result, "### ", '<h3>', '</h3>');
        result = replaceLinePrefix(result, "## ", '<h2>', '</h2>');
        result = replaceLinePrefix(result, "# ", '<h1>', '</h1>');
        result = replaceLinePrefix(result, "&gt; ", '<blockquote>', '</blockquote>');
        result = replaceLinePrefix(result, "- ", '<li>', '</li>');
        result = replaceLinePrefix(result, "* ", '<li>', '</li>');
        result = replaceOrderedList(result);

        var lines = result.split(newline);
        var grouped = [];
        var listBuffer = [];

        function flushListBuffer() {
          if (!listBuffer.length) return;
          grouped.push('<ul>' + listBuffer.join("") + '</ul>');
          listBuffer = [];
        }

        lines.forEach(function(line) {
          if (line.indexOf('<li>') === 0 && line.lastIndexOf('</li>') === line.length - 5) {
            listBuffer.push(line);
            return;
          }
          flushListBuffer();
          grouped.push(line);
        });
        flushListBuffer();

        result = wrapParagraphs(grouped.join(newline));
        return '<div class="markdown-content">' + result + '</div>';
      }

      function highlightCode(code, lang) {
        // Syntax highlighting - escape HTML for display
        code = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return code;
      }

      function shortCommand(cmd) {
        var s = String(cmd || "").trim();
        return s.length <= 24 ? s || "未选择会话" : s.slice(0, 21) + "...";
      }

      function normalizeTerminalOutput(value) {
        var text = String(value || "");
        var normalized = "";
        for (var i = 0; i < text.length; i += 1) {
          var char = text.charAt(i);
          if (char === String.fromCharCode(10)) {
            if (i === 0 || text.charAt(i - 1) !== String.fromCharCode(13)) {
              normalized += String.fromCharCode(13);
            }
            normalized += char;
            continue;
          }
          normalized += char;
        }
        return normalized;
      }

      function showError(el, msg) {
        if (!el) return;
        el.textContent = msg;
        el.classList.remove("hidden");
      }

      function hideError(el) {
        if (!el) return;
        el.textContent = "";
        el.classList.add("hidden");
      }

      function showToast(message, type) {
        var toast = document.createElement("div");
        toast.className = "toast-message" + (type === "error" ? " toast-error" : "");
        if (type !== "error") {
          toast.style.background = "var(--accent)";
          toast.style.color = "white";
        }
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(function() {
          toast.remove();
        }, type === "error" ? 4000 : 2200);
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }
    })();
` + scriptClose + "\n</body>\n</html>";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
