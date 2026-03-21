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

    .main-layout { display: flex; flex: 1; min-height: 0; overflow: hidden; }

    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(42, 28, 18, 0.26);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--transition-normal);
      z-index: 24;
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

    .terminal-container {
      flex: 1;
      display: none;
      background:
        radial-gradient(circle at top right, rgba(91, 58, 34, 0.16), transparent 28%),
        linear-gradient(180deg, #221d18 0%, #1b1714 100%);
      padding: 18px;
      overflow: hidden;
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

    .input-textarea {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      background: rgba(255, 255, 255, 0.65);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      padding: 10px 12px;
      outline: none;
      resize: none;
      min-height: 42px;
      max-height: 120px;
      transition: border-color var(--transition-fast);
    }

    .input-textarea:focus { border-color: var(--accent); }
    .input-textarea::placeholder { color: var(--text-muted); }

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
        padding: 8px 10px;
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
        sessionsDrawerOpen: false,
        modalOpen: false,
        topbarCollapsed: true, // 默认折叠顶栏以最大化终端空间
        presetValue: "",
        commandValue: "",
        cwdValue: "",
        modeValue: "default",
        lastResize: { cols: 0, rows: 0 },
        isOnline: navigator.onLine,
        deferredPrompt: null,
        showInstallPrompt: false,
        ws: null,
        wsConnected: false,
        currentView: "terminal",
        parsedMessages: []
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

        app.innerHTML = isLoggedIn ? renderApp() : renderLogin();
        attachEventListeners();

        // Restore modal state if it was open
        if (wasModalOpen && state.modalOpen) {
          var modal = document.getElementById("session-modal");
          if (modal) {
            modal.classList.remove("hidden");
            // Restore form values
            var presetEl = document.getElementById("preset-select");
            var commandEl = document.getElementById("command");
            var cwdEl = document.getElementById("cwd");
            var modeEl = document.getElementById("mode");
            if (presetEl) presetEl.value = state.presetValue;
            if (commandEl) commandEl.value = state.commandValue;
            if (cwdEl) cwdEl.value = state.cwdValue;
            if (modeEl) modeEl.value = state.modeValue;
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
              '<div class="login-subtitle">Claude 风格的本地 CLI 控制台</div>' +
            '</div>' +
            '<div class="login-body">' +
              '<p class="login-hint">输入配置文件中的访问密码，登录后即可管理本机 CLI 会话。</p>' +
              '<p class="login-tip">访问地址请使用 <strong>http://</strong>。当前服务不是 HTTPS，像 <strong>https://127.0.0.1:8443</strong> 这种地址会直接打开失败。</p>' +
              '<div class="field">' +
                '<label class="field-label" for="password">Password</label>' +
                '<input id="password" type="password" class="field-input" placeholder="Enter password" autocomplete="current-password" />' +
              '</div>' +
              '<button id="login-button" class="btn btn-primary btn-block">Unlock Console</button>' +
              '<p id="login-error" class="error-message hidden"></p>' +
            '</div>' +
          '</div>' +
        '</div>';
      }

      function renderApp() {
        var scriptClose = String.fromCharCode(60) + String.fromCharCode(47) + "script>";
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "No session";
        var terminalInfo = selectedSession ? (selectedSession.mode + " | " + selectedSession.status) : "Select or start a session";
        var currentDraft = state.selectedId ? (state.drafts[state.selectedId] || "") : "";
        var statusClass = state.config ? "status-dot active" : "status-dot";
        var statusText = state.config ? "Unlocked" : "Locked";
        var drawerClass = state.sessionsDrawerOpen ? " open" : "";
        var topbarClass = state.topbarCollapsed ? " topbar-collapsed" : " topbar-expanded";

        return '<div class="app-container">' +
          '<header class="topbar' + topbarClass + '">' +
            '<button id="topbar-toggle-button" class="topbar-toggle" type="button" aria-label="Toggle toolbar">' + (state.topbarCollapsed ? '▾' : '▴') + '</button>' +
            '<div class="topbar-left">' +
              '<div class="topbar-actions">' +
                '<button id="sessions-toggle-button" class="btn btn-secondary btn-sm">Menu</button>' +
              '</div>' +
            '</div>' +
            '<div class="logo-wrap">' +
              '<div class="logo">' +
                '<div class="logo-icon">W</div>' +
              '</div>' +
              '<div class="brand-meta">' +
                '<span class="brand-name">Wand</span>' +
                '<span class="brand-subtitle">Local CLI Console</span>' +
              '</div>' +
            '</div>' +
            '<div class="status-badge">' +
              '<span class="' + statusClass + '" id="status-dot"></span>' +
              '<span id="status-text">' + statusText + '</span>' +
            '</div>' +
            '<div class="topbar-center">' +
              '<div class="session-summary">' +
                '<span class="session-summary-label">Current Session</span>' +
                '<span class="session-summary-value">' + escapeHtml(terminalTitle) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="topbar-right">' +
              '<button id="topbar-new-session-button" class="btn btn-primary btn-sm">+ New</button>' +
              '<button id="settings-button" class="btn btn-ghost btn-sm">⚙</button>' +
              '<button id="logout-button" class="btn btn-ghost btn-sm">Logout</button>' +
            '</div>' +
          '</header>' +
          '<div id="sessions-drawer-backdrop" class="drawer-backdrop' + drawerClass + '"></div>' +
          '<div class="main-layout">' +
            '<aside id="sessions-drawer" class="sidebar' + drawerClass + '">' +
              '<div class="sidebar-header">' +
                '<div class="sidebar-header-main">' +
                  '<span class="sidebar-title">Sessions</span>' +
                  '<span class="session-count" id="session-count">' + state.sessions.length + '</span>' +
                '</div>' +
                '<button id="close-drawer-button" class="btn btn-ghost btn-icon sidebar-close" type="button">×</button>' +
              '</div>' +
              '<div class="sidebar-body">' +
                '<p class="sidebar-intro">Recent sessions are tucked away here so the terminal stays in focus.</p>' +
                '<div class="sessions-list" id="sessions-list">' + renderSessions() + '</div>' +
              '</div>' +
              '<div class="sidebar-footer">' +
                '<button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> New Session</button>' +
                '<div class="sidebar-meta">' +
                  '<span class="protocol-note">Use HTTP only</span>' +
                  '<span class="config-path">' + escapeHtml(configPath) + '</span>' +
                '</div>' +
              '</div>' +
            '</aside>' +
            '<main class="main-content">' +
              '<div class="terminal-header">' +
                '<div class="terminal-title">' +
                  '<span class="terminal-title-text" id="terminal-title">' + terminalTitle + '</span>' +
                  '<span class="terminal-info" id="terminal-info">' + terminalInfo + '</span>' +
                '</div>' +
                '<div class="view-toggle" id="view-toggle">' +
                  '<button class="view-toggle-btn active" data-view="terminal" id="view-terminal-btn">Terminal</button>' +
                  '<button class="view-toggle-btn" data-view="chat" id="view-chat-btn">Chat</button>' +
                '</div>' +
              '</div>' +
              '<div id="output" class="terminal-container"></div>' +
              '<div id="chat-output" class="chat-container"></div>' +
              '<div class="input-panel">' +
                '<div class="input-row">' +
                  '<div class="input-field">' +
                    '<label class="input-label" for="input-box">Send to session</label>' +
                    '<textarea id="input-box" class="input-textarea" placeholder="Type here to send input to the session..." rows="1">' + escapeHtml(currentDraft) + '</textarea>' +
                  '</div>' +
                  '<div class="input-actions">' +
                    '<button id="send-input-button" class="btn btn-send">Send</button>' +
                    '<button id="stop-button" class="btn btn-stop">Stop</button>' +
                    '<button id="floating-controls-toggle" class="btn btn-secondary floating-toggle" type="button" aria-label="More controls">⋯</button>' +
                  '</div>' +
                '</div>' +
                '<div id="floating-backdrop" class="floating-backdrop hidden"></div>' +
                '<div id="floating-controls" class="floating-pad hidden">' +
                  '<div class="floating-pad-title">Quick Controls</div>' +
                  '<div class="floating-pad-grid">' +
                    '<button data-input-key="up" class="btn btn-secondary quick-input" type="button">↑</button>' +
                    '<button data-input-key="enter" class="btn btn-secondary quick-input" type="button">↵</button>' +
                    '<button data-input-key="down" class="btn btn-secondary quick-input" type="button">↓</button>' +
                    '<button data-input-key="left" class="btn btn-secondary quick-input" type="button">←</button>' +
                    '<button data-input-key="yes" class="btn btn-yes quick-input" type="button">Y</button>' +
                    '<button data-input-key="right" class="btn btn-secondary quick-input" type="button">→</button>' +
                    '<button data-input-key="no" class="btn btn-no quick-input" type="button">N</button>' +
                    '<button data-input-key="ctrl_c" class="btn btn-secondary quick-input" type="button">^C</button>' +
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
              '<h2 class="modal-title">Settings</h2>' +
              '<button id="close-settings-button" class="btn btn-ghost btn-icon">×</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label" for="new-password">New Password</label>' +
                '<input id="new-password" type="password" class="field-input" placeholder="Enter new password (min 6 characters)" autocomplete="new-password" />' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="confirm-password">Confirm Password</label>' +
                '<input id="confirm-password" type="password" class="field-input" placeholder="Confirm new password" autocomplete="new-password" />' +
              '</div>' +
              '<button id="save-password-button" class="btn btn-primary btn-block">Save Password</button>' +
              '<p id="settings-error" class="error-message hidden"></p>' +
              '<p id="settings-success" class="hint hidden" style="color: var(--success);"></p>' +
            '</div>' +
          '</div>' +
        '</section>';
      }

      function renderSessions() {
        if (state.sessions.length === 0) {
          return '<div class="empty-state"><strong>还没有会话</strong>从左上角菜单或右上角按钮启动一个新会话，终端输出会显示在主区域。</div>';
        }
        var activeSessions = state.sessions.filter(function(session) { return !session.archived; });
        var archivedSessions = state.sessions.filter(function(session) { return session.archived; });
        var groups = [];
        if (activeSessions.length > 0) {
          groups.push(renderSessionGroup("Recent", activeSessions));
        }
        if (archivedSessions.length > 0) {
          groups.push(renderSessionGroup("Archived", archivedSessions));
        }
        return groups.join("");
      }

      function renderSessionGroup(title, sessions) {
        return '<section class="session-group">' +
          '<div class="session-group-title">' + escapeHtml(title) + '</div>' +
          sessions.map(renderSessionItem).join("") +
        '</section>';
      }

      function renderSessionItem(session) {
        var activeClass = session.id === state.selectedId ? " active" : "";
        var metaStatus = session.archived ? "archived" : session.status;
        var deleteButton = '<button class="btn btn-ghost btn-sm session-action-btn" data-action="delete" data-session-id="' + session.id + '" type="button" aria-label="Delete session">×</button>';
        var resumeButton = "";
        var sessionIdDisplay = "";

        // 如果有 Claude 会话 ID，显示恢复按钮
        if (session.claudeSessionId) {
          var shortId = session.claudeSessionId.slice(0, 8);
          sessionIdDisplay = '<span class="session-id" title="' + escapeHtml(session.claudeSessionId) + '">' + escapeHtml(shortId) + '</span>';
          if (session.status !== "running") {
            resumeButton = '<button class="btn btn-secondary btn-sm session-action-btn" data-action="resume" data-claude-session-id="' + escapeHtml(session.claudeSessionId) + '" data-cwd="' + escapeHtml(session.cwd) + '" type="button" aria-label="Resume session" title="Resume this Claude session">↻</button>';
          }
        }

        return '<div class="session-item' + activeClass + '" data-session-id="' + session.id + '" role="button" tabindex="0">' +
          '<div class="session-item-row">' +
            '<div class="session-main">' +
              '<div class="session-command">' + escapeHtml(session.command) + '</div>' +
              '<div class="session-meta">' +
                '<span>' + escapeHtml(session.mode) + '</span>' +
                '<span class="session-status ' + metaStatus + '">' + escapeHtml(metaStatus) + '</span>' +
                sessionIdDisplay +
              '</div>' +
            '</div>' +
            '<span class="session-actions">' + resumeButton + deleteButton + '</span>' +
          '</div>' +
        '</div>';
      }

      function renderSessionModal() {
        return '<section id="session-modal" class="modal-backdrop hidden">' +
          '<div class="modal">' +
            '<div class="modal-header">' +
              '<h2 class="modal-title">New Session</h2>' +
              '<button id="close-modal-button" class="btn btn-ghost btn-icon">×</button>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="field">' +
                '<label class="field-label" for="preset-select">Preset</label>' +
                '<select id="preset-select" class="field-input"><option value="">Custom command</option></select>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="command">Command</label>' +
                '<textarea id="command" class="field-input" placeholder="claude&#10;codex&#10;gemini" rows="3"></textarea>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="cwd">Working Directory</label>' +
                '<div class="suggestions-wrap">' +
                  '<input id="cwd" type="text" class="field-input" autocomplete="off" placeholder="Defaults to config defaultCwd" />' +
                  '<div id="cwd-suggestions" class="suggestions hidden"></div>' +
                '</div>' +
              '</div>' +
              '<div class="field">' +
                '<label class="field-label" for="mode">Mode</label>' +
                '<select id="mode" class="field-input">' +
                  '<option value="auto-edit">Auto Edit</option>' +
                  '<option value="default">Default</option>' +
                  '<option value="full-access">Full Access</option>' +
                  '<option value="native">Native</option>' +
                '</select>' +
              '</div>' +
              '<button id="run-button" class="btn btn-primary btn-block">Start Session</button>' +
              '<p id="modal-error" class="error-message hidden"></p>' +
              '<p class="hint">Use presets for quick access, or type any CLI command manually.</p>' +
            '</div>' +
          '</div>' +
        '</section>';
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

        var sessionsList = document.getElementById("sessions-list");
        if (sessionsList) {
          sessionsList.addEventListener("click", handleSessionItemClick);
          sessionsList.addEventListener("keydown", handleSessionItemKeydown);
        }

        var commandEl = document.getElementById("command");
        if (commandEl) commandEl.addEventListener("input", function() { state.commandValue = this.value; });
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
        if (sendBtn) sendBtn.addEventListener("click", function() { sendInputFromBox(false); });
        var stopBtn = document.getElementById("stop-button");
        if (stopBtn) stopBtn.addEventListener("click", stopSession);
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
        var presetSelect = document.getElementById("preset-select");
        if (presetSelect) presetSelect.addEventListener("change", function() {
          state.presetValue = this.value;
          applyPreset();
        });
        var modeEl = document.getElementById("mode");
        if (modeEl) modeEl.addEventListener("change", function() { state.modeValue = this.value; });
        var inputBox = document.getElementById("input-box");
        if (inputBox) {
          inputBox.addEventListener("keydown", handleInputBoxKeydown);
          inputBox.addEventListener("paste", handleInputPaste);
        }

        // View toggle handlers
        var viewTermBtn = document.getElementById("view-terminal-btn");
        if (viewTermBtn) viewTermBtn.addEventListener("click", function() { setView("terminal"); });
        var viewChatBtn = document.getElementById("view-chat-btn");
        if (viewChatBtn) viewChatBtn.addEventListener("click", function() { setView("chat"); });

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
          state.terminal.writeln("Select or start a session to begin.");
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
        loginButton.textContent = "Unlocking...";

        fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: passwordEl.value }),
          credentials: "same-origin"
        })
        .then(function(res) {
          if (!res.ok) {
            showError(errorEl, "Password rejected.");
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
          if (statusText) statusText.textContent = "Unlocked";
          return refreshAll();
        })
        .then(function() {
          startPolling();
          render();
        })
        .catch(function(error) {
          if (error !== "Invalid password") {
            showError(errorEl, "Login failed.");
          }
        })
        .finally(function() {
          state.loginPending = false;
          loginButton.disabled = false;
          loginButton.textContent = "Unlock Console";
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
            state.sessions = sessions || [];
            // Clean up drafts for removed sessions
            var sessionIds = new Set(state.sessions.map(function(s) { return s.id; }));
            Object.keys(state.drafts).forEach(function(id) {
              if (!sessionIds.has(id)) delete state.drafts[id];
            });
            if (state.sessions.length > 0) {
              if (!state.selectedId || !state.sessions.some(function(s) { return s.id === state.selectedId; })) {
                state.selectedId = state.sessions[0].id;
              }
            } else {
              state.selectedId = null;
            }
            // Don't full re-render when modal is open to preserve form state
            if (state.modalOpen) {
              updateSessionsList();
            } else {
              // Check if sessions actually changed before re-rendering
              var listEl = document.getElementById("sessions-list");
              var rendered = renderSessions();
              if (listEl && listEl.innerHTML === rendered) {
                // Sessions HTML didn't change, just update count
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              } else {
                // Sessions changed, update the list
                if (listEl) listEl.innerHTML = rendered;
                var countEl = document.getElementById("session-count");
                if (countEl) countEl.textContent = String(state.sessions.length);
              }
            }
            updateShellChrome();
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
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "No session";
        var summaryEl = document.querySelector(".session-summary-value");
        var titleEl = document.getElementById("terminal-title");
        if (summaryEl) summaryEl.textContent = terminalTitle;
        if (titleEl) titleEl.textContent = terminalTitle;
      }

      function updateDrawerState() {
        var drawer = document.getElementById("sessions-drawer");
        var backdrop = document.getElementById("sessions-drawer-backdrop");
        if (drawer) {
          drawer.classList.toggle("open", state.sessionsDrawerOpen);
        }
        if (backdrop) {
          backdrop.classList.toggle("open", state.sessionsDrawerOpen);
        }
      }

      function loadOutput(id) {
        return fetch("/api/sessions/" + id)
          .then(function(res) { return res.json(); })
          .then(function(data) {
            updateShellChrome();
            var terminalInfo = document.getElementById("terminal-info");
            if (terminalInfo) {
              terminalInfo.textContent = data.cwd + " | " + data.mode + " | " + data.status + " | exit=" + (data.exitCode ?? "n/a");
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

            // Update chat view if active
            if (state.currentView === "chat") {
              renderChat();
            }
          });
      }

      function selectSession(id) {
        state.selectedId = id;
        updateSessionsList();
        loadOutput(id).then(focusInputBox);
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
        var modal = document.getElementById("session-modal");
        if (modal) {
          modal.classList.remove("hidden");
          populatePresets();
          schedulePathSuggestions();
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
          errorEl.textContent = "Password must be at least 6 characters.";
          errorEl.classList.remove("hidden");
          return;
        }

        if (newPass !== confirmPass) {
          errorEl.textContent = "Passwords do not match.";
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
          successEl.textContent = "Password saved successfully!";
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

      function runCommand() {
        var commandEl = document.getElementById("command");
        var cwdEl = document.getElementById("cwd");
        var modeEl = document.getElementById("mode");
        var errorEl = document.getElementById("modal-error");

        hideError(errorEl);

        var command = commandEl.value.trim();
        if (!command) {
          showError(errorEl, "Command is required.");
          return;
        }

        // Override mode for this specific command
        var mode = modeEl.value;

        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: command,
            cwd: cwdEl.value.trim(),
            mode: mode
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
          closeSessionModal();
          closeSessionsDrawer();
          commandEl.value = "";
          return refreshAll();
        })
        .then(focusInputBox)
        .catch(function() {
          showError(errorEl, "Failed to start command.");
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

      function sendInputFromBox(appendEnter) {
        var inputBox = document.getElementById("input-box");
        var value = inputBox ? inputBox.value : "";
        if (value) {
          queueDirectInput(value);
          queueDirectInput(getControlInput("enter"));
          inputBox.value = "";
          setDraftValue("");
        } else if (appendEnter) {
          queueDirectInput(getControlInput("enter"));
        }
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
            showError(errorEl, "Failed to delete session.");
          });
      }

      function startCommand(command, cwd, errorEl) {
        return fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: command,
            cwd: cwd || "",
            mode: state.config.defaultMode || "default"
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
            // Real-time output update
            if (msg.sessionId === state.selectedId && state.terminal) {
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
            // Update chat view if active
            if (state.currentView === "chat" && msg.sessionId === state.selectedId) {
              renderChat();
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

        // Update toggle buttons
        document.getElementById("view-terminal-btn").classList.toggle("active", view === "terminal");
        document.getElementById("view-chat-btn").classList.toggle("active", view === "chat");

        // Toggle containers
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        if (terminalContainer) terminalContainer.classList.toggle("active", view === "terminal");
        if (chatContainer) chatContainer.classList.toggle("active", view === "chat");

        // Render chat if switching to chat view
        if (view === "chat") {
          renderChat();
        }
      }

      function renderChat() {
        var chatOutput = document.getElementById("chat-output");
        if (!chatOutput) return;

        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        if (!selectedSession) {
          chatOutput.innerHTML = '<div class="empty-state"><strong>No session selected</strong>Select or start a session to begin.</div>';
          return;
        }

        var messages = parseMessages(selectedSession.output, selectedSession.command);
        state.parsedMessages = messages;

        if (messages.length === 0) {
          chatOutput.innerHTML = '<div class="empty-state"><strong>Waiting for response</strong>Send a message to start the conversation.</div>';
          return;
        }

        chatOutput.innerHTML = '<div class="chat-messages">' + messages.map(renderChatMessage).join("") + '</div>';

        // Scroll to bottom
        chatOutput.scrollTop = chatOutput.scrollHeight;

        // Attach copy handlers
        chatOutput.querySelectorAll(".code-copy").forEach(function(btn) {
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

      function parseMessages(output, command) {
        var messages = [];
        if (!output) return messages;

        // Split output into user/assistant turns
        // Claude CLI format: human: ... assistant: ...
        var turns = output.split(/(?=human:)/i);

        turns.forEach(function(turn) {
          turn = turn.trim();
          if (!turn) return;

          // Check if this is a human turn
          var humanMatch = turn.match(/^human:\s*/i);
          if (humanMatch) {
            var content = turn.slice(humanMatch[0].length).trim();
            if (content) {
              messages.push({ role: "user", content: content });
            }
            return;
          }

          // Check if this is an assistant turn
          var assistantMatch = turn.match(/^assistant:\s*/i);
          if (assistantMatch) {
            var content = turn.slice(assistantMatch[0].length).trim();
            if (content) {
              messages.push({ role: "assistant", content: content });
            }
            return;
          }

          // If no prefix, try to detect based on content
          // User messages are usually shorter and don't have code blocks
          // Assistant messages tend to have more structure and code
          var lines = turn.split(String.fromCharCode(92) + "n");
          var backtick3 = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
          var hasCodeBlock = turn.indexOf(backtick3) >= 0;

          if (hasCodeBlock || lines.length > 3) {
            messages.push({ role: "assistant", content: turn });
          } else {
            messages.push({ role: "user", content: turn });
          }
        });

        return messages;
      }

      function renderChatMessage(msg) {
        var avatar = msg.role === "assistant" ? '<div class="chat-message-avatar">AI</div>' : "";
        var bubbleContent = msg.role === "assistant" ? renderMarkdown(msg.content) : escapeHtml(msg.content);
        return '<div class="chat-message ' + msg.role + '">' +
          avatar +
          '<div class="chat-message-bubble">' + bubbleContent + '</div>' +
        '</div>';
      }

      function renderMarkdown(text) {
        if (!text) return "";

        // Escape HTML first
        var result = escapeHtml(text);

        // Helper for newline
        var nl = String.fromCharCode(92) + "n";

        // Code blocks - use simple string replacement to avoid regex issues
        var bt = String.fromCharCode(96);
        var pos = 0;
        while (true) {
          var start = result.indexOf(bt + bt + bt, pos);
          if (start === -1) break;
          var endTag = result.indexOf(bt + bt + bt, start + 3);
          if (endTag === -1) break;

          var codeBlock = result.slice(start + 3, endTag);
          // Extract language if present
          var langEnd = codeBlock.indexOf(nl);
          var lang = "";
          var code = codeBlock;
          if (langEnd !== -1 && langEnd < 30) {
            var potentialLang = codeBlock.slice(0, langEnd).trim();
            if (/^[a-zA-Z0-9]+$/.test(potentialLang)) {
              lang = potentialLang;
              code = codeBlock.slice(langEnd + 1);
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

        // Inline code - simple string replacement
        pos = 0;
        while (true) {
          var inlineStart = result.indexOf(bt, pos);
          if (inlineStart === -1) break;
          var inlineEnd = result.indexOf(bt, inlineStart + 1);
          if (inlineEnd === -1) break;
          // Check if next char is also backtick (skip code blocks)
          if (inlineEnd === inlineStart + 1) {
            pos = inlineEnd + 1;
            continue;
          }
          var inlineCode = result.slice(inlineStart + 1, inlineEnd);
          var inlineReplacement = '<code class="code-inline">' + inlineCode + '</code>';
          result = result.slice(0, inlineStart) + inlineReplacement + result.slice(inlineEnd + 1);
          pos = inlineStart + inlineReplacement.length;
        }

        // Bold
        result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // Italic
        result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        result = result.replace(/_([^_]+)_/g, '<em>$1</em>');

        // Headers
        result = result.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        result = result.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        result = result.replace(/^# (.+)$/gm, '<h1>$1</h1>');

        // Blockquotes
        result = result.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

        // Lists
        result = result.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
        var liClose = String.fromCharCode(60) + "/li" + String.fromCharCode(62);
        result = result.replace(new RegExp("(<li>.*" + liClose + ")+", 'g'), '<ul>$&</ul>');
        result = result.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

        // Paragraphs
        var paragraphs = result.split(new RegExp(nl + nl + "+"));
        result = paragraphs.map(function(p) {
          p = p.trim();
          if (!p) return "";
          if (/<(div|h[1-6]|ul|ol|li|blockquote|code-block|pre)/.test(p)) {
            return p;
          }
          return '<p>' + p.replace(new RegExp(nl, 'g'), '<br>') + '</p>';
        }).join("");

        return '<div class="markdown-content">' + result + '</div>';
      }

      function highlightCode(code, lang) {
        // Syntax highlighting - escape HTML for display
        code = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return code;
      }

      function shortCommand(cmd) {
        var s = String(cmd || "").trim();
        return s.length <= 24 ? s || "Terminal" : s.slice(0, 21) + "...";
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
