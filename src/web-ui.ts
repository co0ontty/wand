export function renderApp(configPath: string): string {
  var scriptClose = String.fromCharCode(60) + String.fromCharCode(47) + "script>";
  return `<!doctype html>
<html lang="zh-CN">
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

    /* 顶栏优化：简洁三列布局 */
    .topbar {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
      min-height: 52px;
      padding: 8px 12px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-subtle);
      backdrop-filter: blur(18px);
      flex-shrink: 0;
      position: relative;
      z-index: 20;
    }

    .topbar-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .topbar-actions { display: flex; align-items: center; gap: 4px; }
    .logo-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; justify-content: center; }
    .logo { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 0.875rem; }
    .logo-icon {
      width: 24px; height: 24px;
      background: linear-gradient(135deg, #d77a52 0%, #a95130 100%);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
      font-size: 10px; color: white; font-weight: 700;
    }

    .brand-meta { display: none; }
    .status-badge { display: none; }

    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
    .status-dot.active { background: var(--success); box-shadow: 0 0 8px var(--success); }

    .topbar-center {
      min-width: 0;
      display: flex;
      justify-content: center;
      overflow: hidden;
    }

    .session-summary {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      text-align: center;
    }

    .session-summary-label { display: none; }

    .session-summary-value {
      max-width: 180px;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .topbar-right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
    }
    .config-path { display: none; }
    .protocol-note { display: none; }

    .main-layout {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      padding-left: 300px;
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
      width: min(300px, calc(100vw - 20px));
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

    /* 侧边栏头部优化 */
    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(255, 251, 245, 0.6);
      flex-shrink: 0;
    }

    .sidebar-header-main {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .sidebar-title {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .session-count {
      font-size: 0.625rem;
      color: var(--text-muted);
      background: rgba(240, 229, 215, 0.9);
      padding: 2px 6px;
      border-radius: 8px;
    }

    .sidebar-close { flex-shrink: 0; }

    /* 标签切换优化 */
    .sidebar-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(255, 251, 245, 0.6);
      padding: 0 12px;
      flex-shrink: 0;
    }

    .sidebar-tab {
      padding: 8px 10px;
      font-size: 0.75rem;
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

    .file-explorer { flex: 1; overflow-y: auto; padding: 8px 0; min-height: 0; }
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
      padding: 8px 12px 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .file-explorer-path {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    .file-explorer-actions { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }

    .file-explorer-refresh {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 0.875rem;
      padding: 2px 4px;
      border-radius: 4px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .file-explorer-refresh:hover { background: var(--bg-tertiary); color: var(--text-secondary); }

    .file-search-box {
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .file-search-input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.8125rem;
      font-family: var(--font-sans);
      background: var(--bg-secondary);
      color: var(--text-primary);
      outline: none;
      transition: border-color 0.15s ease;
    }

    .file-search-input:focus {
      border-color: var(--accent);
      background: var(--bg-primary);
    }

    .file-search-input::placeholder {
      color: var(--text-muted);
    }

    .file-search-clear {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1rem;
      padding: 4px;
      border-radius: 4px;
      color: var(--text-muted);
      display: none;
      align-items: center;
      justify-content: center;
    }

    .file-search-clear.visible {
      display: flex;
    }

    .file-search-clear:hover {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .sidebar-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    .sidebar-intro {
      padding: 12px 14px 0;
      font-size: 0.75rem;
      color: var(--text-secondary);
      flex-shrink: 0;
    }

    .sessions-list { flex: 1; overflow-y: auto; padding: 10px; }
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
      position: relative;
    }

    .terminal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      background: rgba(255, 251, 245, 0.72);
      border-bottom: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
      flex-shrink: 0;
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
      padding: 14px;
      overflow: hidden;
      min-height: 0;
      margin: 0 14px 14px;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(122, 91, 64, 0.35);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), var(--shadow-soft);
      position: relative;
    }

    .terminal-container.active { display: flex; }
    .terminal-container .xterm { position: absolute; top: 0; left: 0; right: 0; bottom: 0; padding: 4px; }
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
      flex-shrink: 0;
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
      padding: 0 18px 14px;
      position: relative;
    }

    .chat-container.active { display: flex; }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column-reverse;
      gap: 12px;
      padding: 16px 0 8px;
      min-height: 0;
    }

    @keyframes messageSlide {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .chat-message {
      display: flex;
      flex-direction: column;
      max-width: 80%;
      margin: 2px 0;
    }

    .chat-message.user {
      align-self: flex-end;
    }

    .chat-message.assistant {
      align-self: flex-start;
    }

    .chat-message.animate-in {
      animation: messageSlide 0.3s ease;
    }

    .chat-message-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 4px;
      flex-shrink: 0;
    }

    .chat-message.user .chat-message-avatar {
      display: none;
    }

    .chat-message.assistant .chat-message-avatar {
      background: linear-gradient(135deg, #c5653d 0%, #a95130 100%);
      color: white;
    }

    .chat-message-bubble {
      padding: 8px 12px;
      border-radius: var(--radius-md);
      font-size: 0.875rem;
      line-height: 1.5;
      word-wrap: break-word;
      white-space: pre-wrap;
      box-shadow: 0 1px 3px rgba(89, 58, 32, 0.06);
    }

    .chat-message.user .chat-message-bubble {
      background: linear-gradient(135deg, #c5653d 0%, #a95130 100%);
      color: white;
      border-bottom-right-radius: 4px;
      font-family: var(--font-mono);
      font-size: 0.8125rem;
    }

    .chat-message.assistant .chat-message-bubble {
      background: rgba(255, 251, 245, 0.95);
      border: 1px solid var(--border-subtle);
      border-bottom-left-radius: 4px;
      color: var(--text-primary);
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
      margin: 12px 0;
      border-radius: var(--radius-md);
      overflow: hidden;
      background: #1f1b17;
      border: 1px solid rgba(122, 91, 64, 0.35);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    .markdown-content .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: rgba(122, 91, 64, 0.2);
      border-bottom: 1px solid rgba(122, 91, 64, 0.2);
      gap: 8px;
    }
    .markdown-content .code-lang {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      color: #8c735f;
      text-transform: lowercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .markdown-content .code-copy {
      font-family: var(--font-sans);
      font-size: 0.7rem;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.1);
      color: #d9c4b0;
      cursor: pointer;
      transition: all var(--transition-fast);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .markdown-content .code-copy:hover {
      background: rgba(255, 255, 255, 0.18);
      color: white;
      border-color: rgba(255, 255, 255, 0.25);
    }
    .markdown-content .code-copy.copied {
      color: #7fa36f;
      border-color: rgba(127, 163, 111, 0.5);
      background: rgba(127, 163, 111, 0.15);
    }
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
      padding: 12px 18px;
      backdrop-filter: blur(12px);
      flex-shrink: 0;
      position: relative;
      z-index: 10;
    }

    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    .input-field { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .input-label { font-size: 0.6875rem; color: var(--text-muted); font-weight: 500; }
    .input-textarea-wrap { position: relative; display: flex; flex-direction: column; }

    /* Folder picker styles */
    .folder-picker-container {
      margin-bottom: 8px;
    }
    .folder-picker-quick-paths {
      display: flex;
      gap: 6px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .folder-picker-quick-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.6);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font-size: 0.75rem;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);
    }
    .folder-picker-quick-btn:hover {
      background: rgba(255, 255, 255, 0.9);
      border-color: var(--accent);
      color: var(--accent);
    }
    .folder-breadcrumb {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 2px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.4);
      border-radius: 6px;
      font-size: 0.6875rem;
      font-family: var(--font-mono);
      margin-bottom: 4px;
    }
    .folder-breadcrumb-item {
      display: flex;
      align-items: center;
      gap: 2px;
      color: var(--text-muted);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      transition: all var(--transition-fast);
    }
    .folder-breadcrumb-item:hover {
      color: var(--accent);
      background: var(--accent-muted);
    }
    .folder-breadcrumb-item.current {
      color: var(--text-primary);
      font-weight: 500;
    }
    .folder-breadcrumb-separator {
      color: var(--text-muted);
      margin: 0 1px;
    }
    .folder-picker {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: rgba(255, 255, 255, 0.5);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }
    .folder-picker-icon {
      font-size: 1rem;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .folder-picker-input {
      flex: 1;
      border: none;
      background: transparent;
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      color: var(--text-primary);
      outline: none;
      padding: 4px;
    }
    .folder-picker-input:focus {
      background: rgba(255, 255, 255, 0.8);
      border-radius: 4px;
    }
    .folder-picker-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-elevated);
      z-index: 50;
      max-height: 240px;
      overflow-y: auto;
      margin-top: 4px;
    }
    .folder-picker-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      font-size: 0.8125rem;
      transition: background var(--transition-fast);
    }
    .folder-picker-item:hover {
      background: var(--bg-tertiary);
    }
    .folder-picker-item.active {
      background: var(--accent-muted);
    }
    .folder-picker-item-icon {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    .folder-picker-loading {
      padding: 8px 10px;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.75rem;
    }
    .folder-picker-error {
      padding: 8px 10px;
      color: var(--danger);
      font-size: 0.75rem;
      background: var(--danger-muted);
      border-radius: 4px;
      margin: 4px 8px;
    }
    .folder-picker-container.drag-over {
      background: var(--accent-muted);
      border-radius: var(--radius-sm);
    }
    .folder-picker-container.drag-over .folder-picker {
      border-color: var(--accent);
    }
    .folder-recent-section {
      padding: 4px 8px;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 4px;
    }
    .folder-recent-title {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .folder-recent-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      cursor: pointer;
      font-size: 0.75rem;
      border-radius: 4px;
      transition: background var(--transition-fast);
    }
    .folder-recent-item:hover {
      background: var(--bg-tertiary);
    }
    .folder-recent-item-icon {
      color: var(--text-muted);
    }
    .folder-recent-item-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
    }
    .folder-picker-input.invalid {
      border-color: var(--danger);
      background: rgba(178, 79, 69, 0.08);
    }
    .folder-picker-input.invalid:focus {
      box-shadow: 0 0 0 2px rgba(178, 79, 69, 0.2);
    }
    .folder-picker-validation {
      font-size: 0.6875rem;
      color: var(--danger);
      padding: 2px 4px;
      margin-top: 2px;
      display: none;
    }
    .folder-picker-validation.visible {
      display: block;
    }

    /* Simplified compact folder picker for new sessions */
    .folder-picker-compact {
      position: relative;
      margin-bottom: 8px;
    }
    .folder-picker-compact-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.5);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      transition: all var(--transition-fast);
    }
    .folder-picker-compact-row:focus-within {
      background: rgba(255, 255, 255, 0.8);
      border-color: var(--accent);
    }
    .folder-picker-compact-icon {
      font-size: 0.875rem;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .folder-picker-compact-input {
      flex: 1;
      border: none;
      background: transparent;
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      color: var(--text-primary);
      outline: none;
      padding: 2px 0;
      min-width: 0;
    }
    .folder-picker-compact-input::placeholder {
      color: var(--text-muted);
    }
    .folder-picker-toggle {
      background: none;
      border: none;
      padding: 4px 6px;
      font-size: 0.625rem;
      color: var(--text-muted);
      cursor: pointer;
      border-radius: 4px;
      transition: all var(--transition-fast);
    }
    .folder-picker-toggle:hover {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }
    .folder-picker-toggle.open {
      transform: rotate(180deg);
    }
    .folder-picker-quick-row {
      display: flex;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .folder-picker-quick-row .folder-picker-quick-btn {
      flex: 1;
      padding: 4px 8px;
      font-size: 0.6875rem;
    }

    /* Working directory indicator embedded in input box */
    .working-dir-indicator {
      position: absolute;
      left: 12px;
      bottom: 6px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: rgba(197, 101, 61, 0.08);
      border-radius: 4px;
      font-size: 0.6875rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
      cursor: pointer;
      transition: all var(--transition-fast);
      max-width: 200px;
      z-index: 2;
    }
    .working-dir-indicator:hover {
      background: var(--accent-muted);
      color: var(--accent);
    }
    .working-dir-indicator-icon {
      font-size: 0.75rem;
      flex-shrink: 0;
    }
    .working-dir-indicator-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .input-textarea {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      background: rgba(255, 255, 255, 0.65);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      padding: 10px 100px 10px 12px;
      outline: none;
      resize: none;
      min-height: 44px;
      max-height: 120px;
      width: 100%;
      flex: 1;
      transition: border-color var(--transition-fast);
      box-sizing: border-box;
      line-height: 1.5;
    }

    .input-textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-muted);
    }
    .input-textarea::placeholder { color: var(--text-muted); }
    .input-textarea.has-dir-indicator {
      padding-bottom: 28px;
      min-height: 60px;
    }

    .input-inline-controls {
      position: absolute;
      right: 8px;
      top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      pointer-events: none;
    }

    .input-inline-controls > * {
      pointer-events: auto;
      flex-shrink: 0;
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

    /* Folder icon button in input row */
    .folder-icon-btn {
      width: 44px;
      height: 44px;
      min-width: 44px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.6);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font-size: 1.25rem;
      cursor: pointer;
      transition: all var(--transition-fast);
      align-self: flex-end;
    }
    .folder-icon-btn:hover {
      background: var(--accent-muted);
      border-color: var(--accent);
      transform: scale(1.05);
    }
    .folder-icon-btn:active {
      transform: scale(0.95);
    }

    /* Folder picker modal */
    .folder-picker-modal {
      max-width: 480px;
    }
    .folder-picker-modal .modal-body {
      padding: 16px;
    }

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
      width: 44px;
      height: 44px;
      min-width: 44px;
      min-height: 44px;
      border-radius: var(--radius-md);
      box-shadow: 0 4px 16px rgba(89, 58, 32, 0.15);
      padding: 0;
      font-size: 1.2rem;
      line-height: 1;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      z-index: 40;
    }
    .floating-toggle:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 20px rgba(89, 58, 32, 0.2);
    }
    .floating-toggle:active {
      transform: scale(0.95);
    }
    /* Hide floating toggle in Chat mode */
    .floating-toggle.hidden-in-chat {
      display: none;
    }

    .floating-backdrop {
      position: fixed;
      inset: 0;
      z-index: 38;
    }

    .floating-pad {
      position: fixed;
      right: 16px;
      bottom: 80px;
      z-index: 41;
      width: min(220px, calc(100vw - 28px));
      background: rgba(255, 251, 245, 0.98);
      border: 1px solid rgba(150, 118, 85, 0.18);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-soft);
      padding: 12px;
      backdrop-filter: blur(18px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }

    .floating-pad-title {
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 10px;
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
      min-height: 38px;
      padding: 6px 4px;
      font-size: 0.75rem;
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

    .field-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-muted);
    }
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
      padding: 14px 18px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .modal-title { font-size: 1rem; font-weight: 600; }
    .modal-body { padding: 18px; overflow: hidden; }
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
      animation: shake 0.3s ease;
    }

    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-4px); }
      75% { transform: translateX(4px); }
    }

    .field-input[data-error="true"] {
      border-color: var(--danger);
      box-shadow: 0 0 0 3px var(--danger-muted);
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

    /* 平板适配 */
    @media (max-width: 768px) {
      .topbar {
        grid-template-columns: auto 1fr auto;
        padding: 6px 10px;
        min-height: 48px;
        gap: 6px;
      }
      .topbar-center { display: none; }
      .sidebar { width: min(280px, calc(100vw - 24px)); }
      .terminal-container { margin: 0 10px 10px; min-height: 0; }
      .btn { min-height: 38px; }
      .btn-sm { min-height: 32px; padding: 5px 8px; font-size: 0.75rem; }
      .view-toggle {
        display: flex;
        padding: 2px;
        gap: 2px;
      }
      .view-toggle-btn {
        padding: 4px 8px;
        font-size: 0.6875rem;
      }
      .chat-container { padding: 0 10px 10px; }
      .chat-message { max-width: 95%; }
      .thinking-card { padding: 8px 12px; }
      .thinking-content { font-size: 0.75rem; }
      .tool-picker { grid-template-columns: 1fr; }
      /* 平板触摸优化 - 44px触摸区域 */
      .session-item { min-height: 48px; }
      .tree-item { min-height: 44px; padding: 8px 12px; }
      .folder-picker-item { min-height: 44px; }
      .btn { min-height: 44px; }
    }

    @media (min-width: 769px) {
      .drawer-backdrop {
        display: none;
      }
    }

    /* 移动端适配 */
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

      /* 移动端顶栏 */
      .topbar {
        position: sticky;
        top: 0;
        z-index: 30;
        grid-template-columns: auto 1fr auto;
        grid-template-areas: "menu logo actions";
        align-items: center;
        gap: 4px;
        min-height: 44px;
        padding: 6px 8px;
        padding-top: max(6px, env(safe-area-inset-top, 0px));
      }

      .topbar-left { grid-area: menu; display: flex; gap: 4px; }
      .topbar-center { display: none; }
      .topbar-right { grid-area: actions; display: flex; gap: 4px; }
      .topbar-actions { display: contents; }

      /* 移动端logo */
      .logo-wrap { display: flex; align-items: center; gap: 4px; grid-area: logo; justify-content: center; }
      .logo { gap: 4px; font-size: 0.8125rem; }
      .logo-icon { width: 22px; height: 22px; font-size: 9px; border-radius: 6px; }
      .session-summary { display: none; }

      /* 移动端按钮 - 44px触摸区域 */
      .topbar .btn-sm { padding: 6px 10px; font-size: 0.6875rem; min-height: 36px; min-width: 44px; }
      .topbar .btn-icon { min-width: 44px; min-height: 44px; }

      .main-layout {
        flex-direction: column;
        flex: none;
        overflow: visible;
        padding-left: 0;
      }

      .sidebar {
        width: min(280px, calc(100vw - 16px));
        max-height: none;
        border-bottom: none;
      }

      .sessions-list {
        display: block;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 6px;
        -webkit-overflow-scrolling: touch;
      }

      /* 移动端会话项 - 触摸优化 */
      .session-item {
        width: 100%;
        max-width: none;
        margin-bottom: 4px;
        padding: 10px 12px;
        min-height: 48px;
      }

      .session-action-btn {
        width: 36px;
        height: 36px;
        min-height: 36px;
      }

      .main-content {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* 移动端终端 */
      .terminal-header {
        padding: 6px 8px;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .terminal-title {
        flex-direction: row;
        align-items: center;
        gap: 4px;
        font-size: 0.6875rem;
      }
      .terminal-info { font-size: 0.5625rem; }
      .terminal-header-actions .btn-sm { min-height: 36px; min-width: 44px; }

      .terminal-container {
        flex: 1;
        min-height: 0;
        margin: 0 6px 6px;
        padding: 8px;
        border-radius: var(--radius-md);
        overflow: hidden;
      }

      /* 移动端输入面板 - 虚拟键盘优化 */
      .input-panel {
        position: relative;
        z-index: 20;
        padding: 8px;
        padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
        box-shadow: 0 -4px 16px rgba(89, 58, 32, 0.06);
        flex-shrink: 0;
      }

      .input-row { flex-direction: column; align-items: stretch; gap: 6px; }
      .input-field { gap: 4px; min-width: 0; }
      .input-label { font-size: 0.5625rem; }

      /* 移动端输入按钮 - 44px触摸区域 */
      .input-actions {
        width: 100%;
        display: flex;
        flex-wrap: nowrap;
        gap: 6px;
      }
      .input-actions .btn {
        flex: 1;
        min-width: 0;
        min-height: 44px;
        font-size: 0.75rem;
      }
      .floating-toggle {
        flex: 0 0 auto;
        min-width: 44px;
        min-height: 44px;
        border-radius: var(--radius-md);
      }

      /* 防止iOS自动缩放 */
      .input-textarea,
      .field-input {
        font-size: 16px;
      }

      .input-textarea {
        min-height: 44px;
        padding: 10px 80px 10px 10px;
      }

      .input-inline-controls {
        top: 8px;
        right: 8px;
        transform: none;
      }

      .chat-mode-select {
        max-width: 80px;
        height: 32px;
        font-size: 0.6875rem;
        min-height: 32px;
      }

      .floating-pad {
        right: 0;
        bottom: calc(100% + 8px);
        width: min(200px, calc(100vw - 20px));
        padding: 10px;
      }

      /* 浮动面板按钮 - 触摸优化 */
      .floating-pad-grid .btn {
        min-height: 44px;
        font-size: 0.75rem;
      }

      .chat-container {
        min-height: 0;
        flex: 1;
        display: none;
        flex-direction: column;
      }
      .chat-container.active { display: flex; }

      .terminal-container {
        flex: 1;
        min-height: 0;
      }

      /* 目录选择器移动端优化 */
      .folder-picker-container {
        margin-bottom: 6px;
      }

      .folder-picker-quick-paths {
        flex-wrap: wrap;
        gap: 4px;
      }

      .folder-picker-quick-btn {
        min-height: 36px;
        padding: 6px 10px;
        font-size: 0.75rem;
      }

      .folder-breadcrumb {
        padding: 6px 8px;
        font-size: 0.625rem;
        margin-bottom: 4px;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        white-space: nowrap;
        flex-wrap: nowrap;
      }

      .folder-breadcrumb-item {
        padding: 4px 6px;
        min-height: 32px;
        display: inline-flex;
      }

      .folder-picker {
        padding: 8px 10px;
        min-height: 44px;
      }

      .folder-picker-input {
        font-size: 16px;
        padding: 6px;
      }

      .folder-picker-dropdown {
        max-height: 200px;
      }

      .folder-picker-item {
        padding: 10px 12px;
        min-height: 44px;
      }

      .folder-recent-item {
        padding: 8px 10px;
        min-height: 44px;
      }

      .folder-picker-compact-row {
        padding: 8px;
      }
      .folder-picker-compact-input {
        font-size: 0.75rem;
      }

      .working-dir-indicator {
        font-size: 0.625rem;
        padding: 2px 6px;
        max-width: 150px;
      }
      .input-textarea.has-dir-indicator {
        padding-bottom: 26px;
        min-height: 56px;
      }

      .login-container {
        min-height: 100dvh;
        align-items: flex-start;
        padding: 12px 10px calc(12px + env(safe-area-inset-bottom, 0px));
      }

      .login-card {
        margin-top: max(10px, env(safe-area-inset-top, 0px));
      }

      .login-header { padding: 16px 14px 12px; }
      .login-body { padding: 14px; }
      .btn { min-height: 44px; }
      .btn-sm { min-height: 36px; }

      .chat-message-bubble { padding: 8px 10px; font-size: 0.75rem; }
      .chat-message-avatar { width: 22px; height: 22px; font-size: 11px; }

      /* 模态框移动端优化 */
      .modal-backdrop {
        padding: 12px;
        align-items: flex-end;
      }

      .modal {
        max-width: 100%;
        max-height: 90vh;
        border-radius: var(--radius-lg) var(--radius-lg) 0 0;
        margin-bottom: env(safe-area-inset-bottom, 0px);
      }

      .tool-card {
        padding: 12px;
        min-height: 44px;
      }
    }

    /* iPhone 14/15 等标准屏幕 (390px - 420px) */
    @media (min-width: 391px) and (max-width: 420px) {
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
      .topbar .btn-sm { padding: 6px 8px; font-size: 0.6875rem; min-height: 36px; min-width: 44px; }

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
        padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
      }

      .input-actions { gap: 6px; }
      .input-actions .btn { min-height: 44px; font-size: 0.75rem; }
      .floating-toggle { min-width: 44px; min-height: 44px; }

      .floating-pad {
        width: calc(100vw - 20px);
        right: 10px;
        padding: 8px;
      }

      .floating-pad-grid .btn { min-height: 44px; font-size: 0.75rem; }

      .session-item { padding: 10px 12px; min-height: 48px; }
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

      .btn { min-height: 44px; }
      .btn-sm { min-height: 36px; }
    }

    /* iPhone SE 等小屏幕 (<= 390px) */
    @media (max-width: 390px) {
      .topbar {
        padding: 4px 6px;
        min-height: 44px;
        gap: 4px;
      }

      .topbar-left,
      .topbar-right {
        gap: 3px;
      }

      .logo-icon { width: 20px; height: 20px; font-size: 8px; border-radius: 5px; }
      .logo { font-size: 0.75rem; gap: 3px; }
      .topbar .btn-sm {
        padding: 5px 7px;
        font-size: 0.625rem;
        min-height: 32px;
        min-width: 40px;
      }

      .terminal-header { padding: 4px 6px; }
      .terminal-title-text { font-size: 0.6875rem; }
      .terminal-info { display: none; }

      .terminal-container {
        min-height: 35vh;
        max-height: 45vh;
        margin: 4px;
        padding: 6px;
        border-radius: var(--radius-sm);
      }

      .input-panel {
        padding: 6px;
        padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
      }

      .input-row { gap: 4px; }

      .input-actions { gap: 4px; }
      .input-actions .btn {
        min-height: 40px;
        font-size: 0.6875rem;
        padding: 8px 10px;
      }
      .floating-toggle {
        min-width: 40px;
        min-height: 40px;
        font-size: 1rem;
      }

      .floating-pad {
        width: calc(100vw - 16px);
        right: 8px;
        padding: 8px;
        bottom: calc(100% + 4px);
      }

      .floating-pad-grid .btn {
        min-height: 40px;
        font-size: 0.6875rem;
      }

      .session-item {
        padding: 8px 10px;
        min-height: 44px;
      }
      .session-command { font-size: 0.6875rem; }
      .session-meta { font-size: 0.5625rem; gap: 4px; }
      .session-status { padding: 2px 5px; font-size: 0.5625rem; }

      .sidebar-header { padding: 8px 10px; }
      .sidebar-footer { padding: 8px 10px; }
      .sidebar-title { font-size: 0.6875rem; }

      .sidebar-meta {
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
      }

      .modal-body { padding: 12px; }
      .modal-header { padding: 10px 12px; }
      .modal-title { font-size: 0.875rem; }

      .btn { min-height: 40px; padding: 8px 12px; }
      .btn-sm { min-height: 32px; padding: 5px 8px; }

      .tool-picker { gap: 6px; }
      .tool-card { padding: 10px; }
      .tool-card-title { font-size: 0.8125rem; }
      .tool-card-desc { font-size: 0.6875rem; }

      /* 目录选择器小屏幕适配 */
      .folder-picker-quick-btn {
        padding: 5px 8px;
        font-size: 0.6875rem;
        min-height: 32px;
      }

      .folder-breadcrumb {
        font-size: 0.5625rem;
        padding: 4px 6px;
      }

      .folder-picker-compact-row {
        padding: 6px 8px;
      }
      .folder-picker-compact-input {
        font-size: 0.6875rem;
      }

      .working-dir-indicator {
        font-size: 0.5625rem;
        padding: 1px 5px;
        max-width: 120px;
      }
      .input-textarea.has-dir-indicator {
        padding-bottom: 24px;
        min-height: 52px;
      }

      /* Chat 模式优化 */
      .chat-message { max-width: 92%; }
      .chat-message-bubble { padding: 6px 8px; font-size: 0.6875rem; }
      .thinking-card { padding: 6px 10px; gap: 8px; }
      .thinking-content { font-size: 0.6875rem; }
      .prompt-card { padding: 5px 10px; }
      .prompt-content { font-size: 0.6875rem; }
    }

    /* iPad Mini 等平板 (641px - 768px) */
    @media (min-width: 641px) and (max-width: 768px) {
      .topbar {
        min-height: 48px;
        padding: 8px 12px;
      }

      .sidebar {
        width: min(300px, calc(100vw - 40px));
      }

      .session-item {
        min-height: 52px;
      }

      .btn { min-height: 40px; }
      .btn-sm { min-height: 34px; }

      .input-actions .btn { min-height: 40px; }
      .floating-toggle { min-width: 44px; min-height: 44px; }
    }

    /* 横屏模式优化 */
    @media (max-height: 420px) and (orientation: landscape) {
      .topbar {
        min-height: 36px;
        padding: 4px 8px;
      }

      .logo-icon { width: 18px; height: 18px; font-size: 8px; }
      .logo { font-size: 0.75rem; }

      .terminal-container {
        min-height: 50vh;
        margin: 4px;
        padding: 6px;
      }

      .chat-container {
        padding: 0 8px 6px;
      }

      .input-panel {
        padding: 6px;
        padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px));
      }

      .input-row { flex-direction: row; gap: 6px; }
      .input-actions { width: auto; }

      .floating-pad {
        bottom: 60px;
        width: min(160px, calc(100vw - 24px));
      }
    }

    /* Blank chat mobile optimization */
    @media (max-width: 640px) {
      .blank-chat {
        padding: 16px 12px;
        align-items: flex-start;
      }

      .blank-chat-inner {
        max-width: 100%;
      }

      .blank-chat-logo {
        width: 48px;
        height: 48px;
        font-size: 24px;
        border-radius: 12px;
        margin-bottom: 10px;
      }

      .blank-chat-title {
        font-size: 1.125rem;
      }

      .blank-chat-subtitle {
        font-size: 0.75rem;
        margin-bottom: 16px;
      }

      .blank-chat-input-wrap {
        margin-bottom: 12px;
      }

      .blank-chat-input {
        padding: 10px 60px 10px 12px;
        font-size: 16px; /* Prevent iOS zoom */
        border-radius: 10px;
      }

      .blank-chat-send-btn {
        padding: 6px 12px;
        font-size: 0.75rem;
        right: 5px;
      }

      .blank-chat-tools {
        gap: 4px;
        margin-bottom: 8px;
      }

      .blank-chat-tool-btn {
        padding: 6px 10px;
        font-size: 0.75rem;
        min-height: 44px;
      }

      .blank-chat-hint {
        font-size: 0.6875rem;
      }

      .mode-btn-group {
        gap: 4px;
        margin-top: 8px;
      }

      .mode-btn {
        padding: 5px 10px;
        font-size: 0.6875rem;
        min-height: 36px;
      }
    }

    .blank-chat {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: 20px 16px;
      min-height: 0;
      overflow: auto;
    }
    .blank-chat-inner {
      width: 100%;
      max-width: 560px;
      text-align: center;
    }
    .blank-chat-logo {
      width: 56px;
      height: 56px;
      background: linear-gradient(135deg, #d77a52, #a95130);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      font-weight: 700;
      color: white;
      margin: 0 auto 14px;
      box-shadow: 0 4px 16px rgba(197, 101, 61, 0.22);
    }
    .blank-chat-title {
      font-size: 1.375rem;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    .blank-chat-subtitle {
      font-size: 0.8125rem;
      color: var(--text-muted);
      margin: 0 0 20px;
    }
    .blank-chat-input-wrap {
      position: relative;
      margin-bottom: 14px;
    }
    .blank-chat-input {
      width: 100%;
      padding: 12px 70px 12px 16px;
      border: 1.5px solid var(--border-default);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.8);
      color: var(--text-primary);
      font-size: 0.9375rem;
      font-family: var(--font-sans);
      outline: none;
      box-shadow: 0 2px 8px rgba(89, 58, 32, 0.04);
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
      box-sizing: border-box;
    }
    .blank-chat-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-muted), 0 2px 8px rgba(89, 58, 32, 0.04);
    }
    .blank-chat-input::placeholder { color: var(--text-muted); }
    .blank-chat-send-btn {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      padding: 6px 14px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 0.8125rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: background var(--transition-fast);
    }
    .blank-chat-send-btn:hover { background: var(--accent-hover); }
    .blank-chat-tools {
      display: flex;
      gap: 6px;
      justify-content: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .blank-chat-tool-btn {
      padding: 6px 12px;
      border: 1.5px solid var(--border-default);
      border-radius: 8px;
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
      min-width: 0;
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
        pendingMessages: [], // WebSocket 断线期间的消息队列
        drafts: {},
        isSyncingInputBox: false,
        loginPending: false,
        loginChecked: false,
        sessionsDrawerOpen: true,
        modalOpen: false,
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
        renderPending: false,
        fileSearchQuery: "",
        allFiles: [],
        // Load last used working directory from localStorage
        workingDir: (function() {
          try {
            var saved = localStorage.getItem("wand-working-dir");
            return saved || "";
          } catch (e) {
            return "";
          }
        })()
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
            // Render the app shell first, THEN load session data into it.
            // This avoids refreshAll() rendering chat content that render() immediately destroys.
            render();
            startPolling();
            return refreshAll();
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
        // Reset chat render tracking since DOM was fully replaced
        state.lastRenderedHash = 0;
        state.lastRenderedMsgCount = 0;
        state.lastRenderedEmpty = null;
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
                '<input id="password" type="password" class="field-input" placeholder="输入密码" autocomplete="current-password" data-error="false" />' +
                '<p class="hint">密码至少需要 6 个字符</p>' +
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
        var drawerClass = state.sessionsDrawerOpen ? " open" : "";
        var preferredTool = getComposerTool();
        var composerMode = getSafeModeForTool(preferredTool, state.chatMode);

        return '<div class="app-container">' +
          '<header class="topbar">' +
            '<div class="topbar-left">' +
              '<button id="sessions-toggle-button" class="btn btn-secondary btn-sm">≡</button>' +
            '</div>' +
            '<div class="logo-wrap">' +
              '<div class="logo">' +
                '<div class="logo-icon">W</div>' +
              '</div>' +
            '</div>' +
            '<div class="topbar-center">' +
              '<div class="session-summary">' +
                '<span class="session-summary-value">' + escapeHtml(terminalTitle) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="topbar-right">' +
              '<button id="topbar-new-session-button" class="btn btn-primary btn-sm">+ 新对话</button>' +
              '<button id="logout-button" class="btn btn-ghost btn-sm">退出</button>' +
            '</div>' +
          '</header>' +
          '<div id="sessions-drawer-backdrop" class="drawer-backdrop' + drawerClass + '"></div>' +
          '<div class="main-layout' + (state.sessionsDrawerOpen ? ' sidebar-open' : '') + '">' +
            '<aside id="sessions-drawer" class="sidebar' + drawerClass + '">' +
              '<div class="sidebar-header">' +
                '<div class="sidebar-header-main">' +
                  '<span class="sidebar-title">会话</span>' +
                  '<span class="session-count" id="session-count">' + String(state.sessions.length) + '</span>' +
                '</div>' +
                '<button id="close-drawer-button" class="btn btn-ghost btn-sm sidebar-close" type="button" aria-label="关闭菜单">×</button>' +
              '</div>' +
              '<div class="sidebar-tabs">' +
                '<button class="sidebar-tab' + (state.sidebarTab !== "files" ? " active" : "") + '" id="tab-sessions" type="button">会话</button>' +
                '<button class="sidebar-tab' + (state.sidebarTab === "files" ? " active" : "") + '" id="tab-files" type="button">文件</button>' +
              '</div>' +
              '<div class="sidebar-body">' +
                '<div id="sessions-panel"' + (state.sidebarTab === "files" ? ' class="hidden"' : "") + '>' +
                  '<p class="sidebar-intro">最近的会话记录会显示在这里</p>' +
                  '<div class="sessions-list" id="sessions-list">' + renderSessions() + '</div>' +
                '</div>' +
                '<div id="files-panel"' + (state.sidebarTab !== "files" ? ' class="hidden"' : "") + '>' +
                  '<div class="file-explorer-header">' +
                    '<span class="file-explorer-path" id="file-explorer-cwd">' + escapeHtml(state.config && state.config.defaultCwd ? state.config.defaultCwd : "") + '</span>' +
                    '<div class="file-explorer-actions">' +
                      '<button class="file-explorer-refresh" id="file-explorer-refresh" title="刷新" aria-label="刷新文件列表">↻</button>' +
                    '</div>' +
                  '</div>' +
                  '<div class="file-search-box">' +
                    '<input type="text" id="file-search-input" class="file-search-input" placeholder="搜索文件..." autocomplete="off" />' +
                    '<button class="file-search-clear" id="file-search-clear" type="button" aria-label="清除搜索">×</button>' +
                  '</div>' +
                  '<div class="file-explorer" id="file-explorer">' + renderFileExplorer(state.config && state.config.defaultCwd ? state.config.defaultCwd : "") + '</div>' +
                '</div>' +
              '</div>' +
              '<div class="sidebar-footer">' +
                '<button id="drawer-new-session-button" class="btn btn-primary btn-block"><span>+</span> 新会话</button>' +
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
                  // Folder icon button (only for new sessions)
                  (!state.selectedId ? '<button id="folder-picker-btn" class="folder-icon-btn" type="button" title="选择工作目录">📁</button>' : '') +
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
              // Folder picker modal (hidden by default)
              '<section id="folder-picker-modal" class="modal-backdrop hidden">' +
                '<div class="modal folder-picker-modal">' +
                  '<div class="modal-header">' +
                    '<h2 class="modal-title">选择工作目录</h2>' +
                    '<button id="close-folder-picker" class="btn btn-ghost btn-icon">×</button>' +
                  '</div>' +
                  '<div class="modal-body">' +
                    '<div class="folder-picker-quick-row">' +
                      '<button class="folder-picker-quick-btn" data-path="/tmp">🗑️ 临时目录</button>' +
                      '<button class="folder-picker-quick-btn" data-path="/">📁 根目录</button>' +
                    '</div>' +
                    '<div id="folder-breadcrumb" class="folder-breadcrumb"></div>' +
                    '<div class="folder-picker">' +
                      '<span class="folder-picker-icon">📁</span>' +
                      '<input type="text" id="folder-picker-input" class="folder-picker-input" value="" placeholder="输入或选择工作目录..." autocomplete="off" />' +
                    '</div>' +
                    '<div id="folder-picker-dropdown" class="folder-picker-dropdown hidden"></div>' +
                    '<div id="folder-picker-validation" class="folder-picker-validation"></div>' +
                  '</div>' +
                '</div>' +
              '</section>' +
            '</main>' +
            // Floating controls for keyboard shortcuts
            '<button id="floating-controls-toggle" class="floating-toggle" type="button" aria-label="快捷键" title="快捷键">⌨</button>' +
            '<div id="floating-controls" class="floating-pad hidden">' +
              '<div class="floating-pad-title">Claude 快捷键</div>' +
              '<div class="floating-pad-grid">' +
                '<button class="btn btn-secondary quick-input" data-input-key="ctrl_c" type="button" title="中断当前操作">Ctrl+C</button>' +
                '<button class="btn btn-secondary quick-input" data-input-key="ctrl_d" type="button" title="发送 EOF">Ctrl+D</button>' +
                '<button class="btn btn-secondary quick-input" data-input-key="ctrl_l" type="button" title="清屏">Ctrl+L</button>' +
                '<button class="btn btn-secondary quick-input" data-input-key="ctrl_u" type="button" title="删除到行首">Ctrl+U</button>' +
                '<button class="btn btn-secondary quick-input" data-input-key="ctrl_k" type="button" title="删除到行尾">Ctrl+K</button>' +
                '<button class="btn btn-secondary quick-input" data-input-key="ctrl_w" type="button" title="删除前一个单词">Ctrl+W</button>' +
                '<button class="btn btn-secondary quick-input" data-input-key="up" type="button" title="上一条命令">↑</button>' +
                '<button class="btn btn-secondary quick-input" data-input-key="down" type="button" title="下一条命令">↓</button>' +
                '<button class="btn btn-primary quick-input" data-input-key="enter" type="button" title="发送/确认">Enter</button>' +
              '</div>' +
            '</div>' +
            '<div id="floating-backdrop" class="floating-backdrop hidden"></div>' +
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
            state.allFiles = items;
            filterFileTree();
          })
          .catch(function() {
            explorer.innerHTML = '<div class="file-explorer empty">Failed to load files.</div>';
          });
      }

      function filterFileTree() {
        var explorer = document.getElementById("file-explorer");
        var cwdEl = document.getElementById("file-explorer-cwd");
        if (!explorer) return;
        var cwd = cwdEl ? cwdEl.textContent : "";
        if (!cwd) return;

        var query = state.fileSearchQuery;
        var items = state.allFiles || [];

        // 如果没有搜索词，显示所有文件
        if (!query) {
          explorer.innerHTML = '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(cwd) + '">' +
            items.map(function(item) {
              return renderFileTreeItem(item);
            }).join("") +
          '</div>';
          attachFileTreeListeners();
          return;
        }

        // 模糊匹配文件名（大小写不敏感）
        var lowerQuery = query.toLowerCase();
        var filtered = items.filter(function(item) {
          return item.name.toLowerCase().indexOf(lowerQuery) !== -1;
        });

        if (filtered.length === 0) {
          explorer.innerHTML = '<div class="file-explorer empty">没有找到匹配的文件</div>';
          return;
        }

        explorer.innerHTML = '<div class="file-tree" id="file-tree" data-cwd="' + escapeHtml(cwd) + '">' +
          filtered.map(function(item) {
            return renderFileTreeItem(item);
          }).join("") +
        '</div>';
        attachFileTreeListeners();
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

      function renderFolderPicker(state) {
        var currentDir = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");

        // 如果有选中的会话，不显示单独的工作目录标签（已嵌入输入框内部）
        if (state.selectedId) {
          return '';
        }

        // 新建会话时显示简化的目录选择器（单行紧凑设计）
        return '<div class="folder-picker-compact" id="folder-picker-container">' +
          '<div class="folder-picker-compact-row">' +
            '<span class="folder-picker-compact-icon">📁</span>' +
            '<input type="text" id="folder-picker-input" class="folder-picker-compact-input" value="' + escapeHtml(currentDir) + '" placeholder="工作目录" autocomplete="off" />' +
            '<button type="button" id="folder-picker-toggle" class="folder-picker-toggle" title="选择目录">▼</button>' +
          '</div>' +
          '<div id="folder-picker-dropdown" class="folder-picker-dropdown hidden">' +
            '<div class="folder-picker-quick-row">' +
              '<button class="folder-picker-quick-btn" data-path="/tmp">临时</button>' +
              '<button class="folder-picker-quick-btn" data-path="/">根目录</button>' +
            '</div>' +
          '</div>' +
          '<div id="folder-picker-validation" class="folder-picker-validation"></div>' +
        '</div>';
      }

      // 渲染内嵌到输入框的工作目录指示器
      function renderWorkingDirIndicator(state) {
        var currentDir = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
        var displayDir = currentDir;

        // 如果有选中的会话，使用会话的工作目录
        if (state.selectedId) {
          var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
          displayDir = selectedSession && selectedSession.cwd ? selectedSession.cwd : currentDir;
        }

        // 截断显示的路径
        var displayPath = displayDir;
        if (displayPath.length > 28) {
          displayPath = "..." + displayPath.slice(-25);
        }

        return '<div class="working-dir-indicator" id="working-dir-indicator" title="' + escapeHtml(displayDir) + '" data-path="' + escapeHtml(displayDir) + '">' +
          '<span class="working-dir-indicator-icon">📁</span>' +
          '<span class="working-dir-indicator-path">' + escapeHtml(displayPath) + '</span>' +
        '</div>';
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

        // File search
        var fileSearchInput = document.getElementById("file-search-input");
        var fileSearchClear = document.getElementById("file-search-clear");
        if (fileSearchInput) {
          fileSearchInput.addEventListener("input", function(e) {
            state.fileSearchQuery = e.target.value.trim();
            if (fileSearchClear) {
              fileSearchClear.classList.toggle("visible", state.fileSearchQuery.length > 0);
            }
            filterFileTree();
          });
        }
        if (fileSearchClear) {
          fileSearchClear.addEventListener("click", function() {
            state.fileSearchQuery = "";
            if (fileSearchInput) {
              fileSearchInput.value = "";
            }
            fileSearchClear.classList.remove("visible");
          });
        }

        // Folder picker functionality with keyboard navigation
        var folderPickerInput = document.getElementById("folder-picker-input");
        var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
        var folderPickerDebounceTimer = null;
        var selectedIndex = -1;
        var folderItems = [];

        // Helper function to save working directory to localStorage
        function saveWorkingDir(path) {
          state.workingDir = path;
          try {
            localStorage.setItem("wand-working-dir", path);
          } catch (e) {
            // Ignore localStorage errors
          }
          // Also add to recent paths (defined later, will be called after function is available)
          if (typeof addRecentPath === "function") {
            addRecentPath(path);
          }
        }

        // Helper functions for path validation feedback
        function showValidationError(message) {
          if (folderPickerInput) {
            folderPickerInput.classList.add("invalid");
          }
          var validationEl = document.getElementById("folder-picker-validation");
          if (validationEl) {
            validationEl.textContent = message;
            validationEl.classList.add("visible");
          }
        }

        function clearValidationError() {
          if (folderPickerInput) {
            folderPickerInput.classList.remove("invalid");
          }
          var validationEl = document.getElementById("folder-picker-validation");
          if (validationEl) {
            validationEl.textContent = "";
            validationEl.classList.remove("visible");
          }
        }

        // Helper functions for recent paths
        function getRecentPaths() {
          try {
            var saved = localStorage.getItem("wand-recent-paths");
            return saved ? JSON.parse(saved) : [];
          } catch (e) {
            return [];
          }
        }

        function addRecentPath(path) {
          var recent = getRecentPaths();
          // Remove if already exists
          recent = recent.filter(function(p) { return p !== path; });
          // Add to front
          recent.unshift(path);
          // Keep only last 5
          recent = recent.slice(0, 5);
          try {
            localStorage.setItem("wand-recent-paths", JSON.stringify(recent));
          } catch (e) {
            // Ignore localStorage errors
          }
        }

        function renderRecentPaths() {
          var recent = getRecentPaths();
          if (recent.length === 0) return "";

          var html = '<div class="folder-recent-section">' +
            '<div class="folder-recent-title">最近使用</div>';

          recent.forEach(function(path) {
            html += '<div class="folder-recent-item" data-path="' + escapeHtml(path) + '">' +
              '<span class="folder-recent-item-icon">📁</span>' +
              '<span class="folder-recent-item-path">' + escapeHtml(path) + '</span>' +
            '</div>';
          });

          html += '</div>';
          return html;
        }

        function showRecentPathsDropdown() {
          if (!folderPickerDropdown) return;
          var recentHtml = renderRecentPaths();
          if (recentHtml) {
            folderPickerDropdown.innerHTML = recentHtml;
            folderPickerDropdown.classList.remove("hidden");
            // Add click handlers for recent paths
            folderPickerDropdown.querySelectorAll(".folder-recent-item").forEach(function(item) {
              item.addEventListener("click", function() {
                var path = this.dataset.path;
                if (folderPickerInput) {
                  folderPickerInput.value = path;
                  saveWorkingDir(path);
                  loadFolderSuggestions(path);
                }
              });
            });
          } else {
            hideFolderDropdown();
          }
        }

        // Working directory indicator click handler for active sessions
        var workingDirIndicator = document.getElementById("working-dir-indicator");
        if (workingDirIndicator) {
          workingDirIndicator.addEventListener("click", function() {
            // 点击指示器时，取消当前会话选择，显示完整的目录选择器
            state.selectedId = null;
            state.drafts = {};
            renderApp();
            // 聚焦到目录输入框
            setTimeout(function() {
              var folderInput = document.getElementById("folder-picker-input");
              if (folderInput) folderInput.focus();
            }, 50);
          });
        }

        // Compact folder picker toggle
        var folderPickerToggle = document.getElementById("folder-picker-toggle");
        var folderPickerDropdown = document.getElementById("folder-picker-dropdown");
        if (folderPickerToggle && folderPickerDropdown) {
          folderPickerToggle.addEventListener("click", function() {
            folderPickerDropdown.classList.toggle("hidden");
            folderPickerToggle.classList.toggle("open");
          });
        }

        // Drag and drop support
        var folderPickerContainer = document.querySelector(".folder-picker-compact");
        if (folderPickerContainer) {
          folderPickerContainer.addEventListener("dragover", function(e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.add("drag-over");
          });

          folderPickerContainer.addEventListener("dragleave", function(e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("drag-over");
          });

          folderPickerContainer.addEventListener("drop", function(e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.remove("drag-over");

            var items = e.dataTransfer && e.dataTransfer.items;
            if (items) {
              for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item.kind === "file" && item.webkitGetAsEntry) {
                  var entry = item.webkitGetAsEntry();
                  if (entry && entry.isDirectory && folderPickerInput) {
                    var path = entry.fullPath;
                    folderPickerInput.value = path;
                    saveWorkingDir(path);
                    addRecentPath(path);
                    loadFolderSuggestions(path);
                    break;
                  }
                }
              }
            }
          });
        }

        // Quick path buttons (now inside dropdown)
        if (folderPickerDropdown) {
          folderPickerDropdown.addEventListener("click", function(e) {
            var btn = e.target.closest(".folder-picker-quick-btn");
            if (btn && folderPickerInput) {
              var path = btn.dataset.path;
              folderPickerInput.value = path;
              saveWorkingDir(path);
              loadFolderSuggestions(path);
              folderPickerDropdown.classList.add("hidden");
              var toggle = document.getElementById("folder-picker-toggle");
              if (toggle) toggle.classList.remove("open");
            }
          });
        }

        if (folderPickerInput) {
          // Load initial folders from saved or default path
          var initialPath = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
          loadFolderSuggestions(initialPath);

          folderPickerInput.addEventListener("focus", function() {
            var path = this.value.trim();
            if (path) {
              loadFolderSuggestions(path);
            } else {
              // Show recent paths when input is empty
              showRecentPathsDropdown();
            }
          });

          folderPickerInput.addEventListener("input", function(e) {
            var query = e.target.value.trim();
            selectedIndex = -1;
            if (folderPickerDebounceTimer) clearTimeout(folderPickerDebounceTimer);
            folderPickerDebounceTimer = setTimeout(function() {
              if (query) {
                loadFolderSuggestions(query);
              } else {
                hideFolderDropdown();
              }
            }, 150);
          });

          // Keyboard navigation
          folderPickerInput.addEventListener("keydown", function(e) {
            if (e.key === "Escape") {
              hideFolderDropdown();
              this.blur();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (folderItems.length > 0) {
                selectedIndex = Math.min(selectedIndex + 1, folderItems.length - 1);
                updateSelectedIndex();
              }
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (selectedIndex > 0) {
                selectedIndex--;
                updateSelectedIndex();
              }
            } else if (e.key === "Enter" && selectedIndex >= 0) {
              e.preventDefault();
              var selectedItem = folderItems[selectedIndex];
              if (selectedItem) {
                var selectedPath = selectedItem.dataset.path;
                if (selectedPath === "..") {
                  // Navigate to parent
                  var currentPath = folderPickerInput.value.trim();
                  var parentPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
                  if (parentPath) {
                    folderPickerInput.value = parentPath || "/";
                    saveWorkingDir(folderPickerInput.value);
                    loadFolderSuggestions(parentPath || "/");
                  }
                } else {
                  folderPickerInput.value = selectedPath;
                  saveWorkingDir(selectedPath);
                  hideFolderDropdown();
                }
              }
            }
          });

          // Close dropdown when clicking outside
          document.addEventListener("click", function(e) {
            if (!e.target.closest(".folder-picker-container")) {
              hideFolderDropdown();
            }
          });
        }

        function updateSelectedIndex() {
          folderItems.forEach(function(item, index) {
            item.classList.toggle("active", index === selectedIndex);
          });
        }

        function loadFolderSuggestions(query) {
          if (!folderPickerDropdown) return;

          // Show loading state
          folderPickerDropdown.innerHTML = '<div class="folder-picker-loading">加载中...</div>';
          folderPickerDropdown.classList.remove("hidden");
          selectedIndex = -1;
          folderItems = [];

          fetch("/api/folders?q=" + encodeURIComponent(query))
            .then(function(res) {
              return res.json().then(function(data) {
                return { ok: res.ok, status: res.status, data: data };
              });
            })
            .then(function(result) {
              var data = result.data;

              // Handle error responses
              if (!result.ok || data.error) {
                showValidationError(data.error || "路径无效");
                folderPickerDropdown.innerHTML = '<div class="folder-picker-error">' + escapeHtml(data.error || "路径无效") + '</div>';
                return;
              }

              // Clear validation error on success
              clearValidationError();

              // Update breadcrumb navigation
              renderBreadcrumb(data.currentPath || query);

              var items = data.items || [];
              var currentPath = data.currentPath || query;

              if (items.length === 0) {
                folderPickerDropdown.innerHTML = '<div class="folder-picker-loading">空目录</div>';
                return;
              }

              folderPickerDropdown.innerHTML = items.map(function(item) {
                var icon = item.type === "parent" ? "↩️" : "📁";
                var name = item.type === "parent" ? ".. (返回上级)" : item.name;
                return '<div class="folder-picker-item" data-path="' + escapeHtml(item.path) + '" data-type="' + item.type + '">' +
                  '<span class="folder-picker-item-icon">' + icon + '</span>' +
                  '<span>' + escapeHtml(name) + '</span>' +
                '</div>';
              }).join("");

              folderItems = Array.from(folderPickerDropdown.querySelectorAll(".folder-picker-item"));

              // Add click handlers
              folderItems.forEach(function(item) {
                item.addEventListener("click", function() {
                  var selectedPath = this.dataset.path;
                  var type = this.dataset.type;
                  if (folderPickerInput) {
                    if (type === "parent") {
                      // Navigate to parent directory
                      var currentPath = folderPickerInput.value.trim();
                      var parentPath = currentPath.substring(0, currentPath.lastIndexOf("/"));
                      folderPickerInput.value = parentPath || "/";
                      saveWorkingDir(folderPickerInput.value);
                      loadFolderSuggestions(parentPath || "/");
                    } else {
                      folderPickerInput.value = selectedPath;
                      saveWorkingDir(selectedPath);
                      clearValidationError();
                      hideFolderDropdown();
                    }
                  }
                });
              });
            })
            .catch(function(err) {
              showValidationError("加载失败");
              folderPickerDropdown.innerHTML = '<div class="folder-picker-error">加载失败</div>';
            });
        }

        function hideFolderDropdown() {
          if (folderPickerDropdown) {
            folderPickerDropdown.classList.add("hidden");
          }
          selectedIndex = -1;
          folderItems = [];
        }

        // Folder picker modal functionality
        var folderPickerBtn = document.getElementById("folder-picker-btn");
        var folderPickerModal = document.getElementById("folder-picker-modal");
        var closeFolderPicker = document.getElementById("close-folder-picker");

        if (folderPickerBtn && folderPickerModal) {
          folderPickerBtn.addEventListener("click", function() {
            folderPickerModal.classList.remove("hidden");
            // Set initial path in input
            if (folderPickerInput) {
              folderPickerInput.value = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
            }
            // Load initial folders
            var initialPath = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "/tmp");
            loadFolderSuggestions(initialPath);
            renderBreadcrumb(initialPath);
          });
        }

        if (closeFolderPicker && folderPickerModal) {
          closeFolderPicker.addEventListener("click", function() {
            folderPickerModal.classList.add("hidden");
          });
        }

        if (folderPickerModal) {
          folderPickerModal.addEventListener("click", function(e) {
            if (e.target === folderPickerModal) {
              folderPickerModal.classList.add("hidden");
            }
          });
        }

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
          var hint = getModeHint(mode);
          return '<option value="' + escapeHtml(mode) + '"' + (mode === selectedMode ? " selected" : "") + ' title="' + hint + '">' +
            escapeHtml(getModeLabel(mode)) +
          '</option>';
        }).join("");
      }

      function getModeHint(mode) {
        var hints = {
          'default': '标准模式 - 需要确认文件修改',
          'full-access': '完全访问 - 自动确认所有操作',
          'auto-edit': '自动编辑 - 自动确认文件修改',
          'native': '原生模式 - 返回结构化输出'
        };
        return hints[mode] || '';
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
        // 更新模式提示
        var modeHint = document.getElementById("mode-hint");
        if (modeHint) modeHint.textContent = getModeHint(state.chatMode);
      }

      function applyCurrentView() {
        var hasSession = !!state.selectedId;
        var terminalBtn = document.getElementById("view-terminal-btn");
        var chatBtn = document.getElementById("view-chat-btn");
        var terminalContainer = document.getElementById("output");
        var chatContainer = document.getElementById("chat-output");
        var floatingToggle = document.getElementById("floating-controls-toggle");

        if (terminalBtn) terminalBtn.classList.toggle("active", state.currentView === "terminal");
        if (chatBtn) chatBtn.classList.toggle("active", state.currentView === "chat");
        if (terminalContainer) terminalContainer.classList.toggle("active", hasSession && state.currentView === "terminal");
        if (chatContainer) chatContainer.classList.toggle("active", hasSession && state.currentView === "chat");
        // Hide floating shortcut in Chat mode - only useful in Terminal mode
        if (floatingToggle) floatingToggle.classList.toggle("hidden-in-chat", state.currentView === "chat");
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

      // Store last focused element for focus trap
      var lastFocusedElement = null;
      var focusTrapHandler = null;

      function openSessionModal() {
        state.modalOpen = true;
        state.sessionsDrawerOpen = false;
        updateDrawerState();
        var modal = document.getElementById("session-modal");
        if (modal) {
          modal.classList.remove("hidden");
          // Store last focused element to restore on close
          lastFocusedElement = document.activeElement;
          var commandEl = document.getElementById("command");
          var defaultTool = getPreferredTool();
          var fallbackCommand = state.commandValue || state.preferredCommand || defaultTool;
          state.sessionTool = inferToolFromCommand(fallbackCommand) === "codex" ? "codex" : defaultTool;
          state.commandValue = fallbackCommand || state.sessionTool;
          state.modeValue = getSafeModeForTool(state.sessionTool, state.modeValue || state.chatMode);
          if (commandEl) commandEl.value = state.commandValue;
          syncSessionModalUI();
          setTimeout(function() { document.getElementById("command").focus(); }, 20);
          // Setup focus trap
          setupFocusTrap(modal);
        }
      }

      function closeSessionModal() {
        state.modalOpen = false;
        var modal = document.getElementById("session-modal");
        if (modal) {
          modal.classList.add("hidden");
          // Remove focus trap
          if (focusTrapHandler) {
            document.removeEventListener("keydown", focusTrapHandler);
            focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
            lastFocusedElement.focus();
          }
        }
        hidePathSuggestions();
      }

      function setupFocusTrap(modal) {
        // Focusable elements selector
        var focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

        focusTrapHandler = function(e) {
          if (e.key !== "Tab") return;

          var focusableElements = modal.querySelectorAll(focusableSelector);
          var firstEl = focusableElements[0];
          var lastEl = focusableElements[focusableElements.length - 1];

          if (!firstEl || !lastEl) return;

          // Shift + Tab
          if (e.shiftKey) {
            if (document.activeElement === firstEl) {
              e.preventDefault();
              lastEl.focus();
            }
          } else {
            // Tab
            if (document.activeElement === lastEl) {
              e.preventDefault();
              firstEl.focus();
            }
          }
        };

        document.addEventListener("keydown", focusTrapHandler);
      }

      function openSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) {
          modal.classList.remove("hidden");
          lastFocusedElement = document.activeElement;
          document.getElementById("new-password").value = "";
          document.getElementById("confirm-password").value = "";
          hideSettingsMessages();
          setupFocusTrap(modal);
        }
      }

      function closeSettingsModal() {
        var modal = document.getElementById("settings-modal");
        if (modal) {
          modal.classList.add("hidden");
          // Remove focus trap
          if (focusTrapHandler) {
            document.removeEventListener("keydown", focusTrapHandler);
            focusTrapHandler = null;
          }
          // Restore focus to last focused element
          if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
            lastFocusedElement.focus();
          }
        }
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
        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
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

        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
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
          // Allow copy when text is selected; otherwise send SIGINT to terminal
          var inputBox = document.getElementById("input-box");
          var hasSelection = inputBox && (inputBox.selectionStart !== inputBox.selectionEnd);
          if (hasSelection) {
            return; // Let browser handle copy
          }
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_c"));
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
          // Allow copy when text is selected; otherwise send EOF to terminal
          var inputBox2 = document.getElementById("input-box");
          var hasSelection2 = inputBox2 && (inputBox2.selectionStart !== inputBox2.selectionEnd);
          if (hasSelection2) {
            return; // Let browser handle copy
          }
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_d"));
          return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          queueDirectInput(getControlInput("ctrl_l"));
          return;
        }

        // Cmd+A / Ctrl+A: Select all (let browser handle)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          // Let browser handle select-all
          return;
        }

        // Cmd+V / Ctrl+V: Paste (let browser handle)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
          // Let browser handle paste
          return;
        }

        // Cmd+X / Ctrl+X: Cut (let browser handle when text selected)
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "x") {
          var inputBox = document.getElementById("input-box");
          var hasSelection = inputBox && (inputBox.selectionStart !== inputBox.selectionEnd);
          if (hasSelection) {
            // Let browser handle cut
            return;
          }
          // No selection: send Ctrl+X to terminal (rare case)
          event.preventDefault();
          queueDirectInput(String.fromCharCode(24)); // Ctrl+X = 0x18
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
        if (state.selectedId) {
          if (state.drafts[state.selectedId] !== undefined) {
            return state.drafts[state.selectedId];
          }
          // Try to load from localStorage
          try {
            var saved = localStorage.getItem("wand-draft-" + state.selectedId);
            if (saved) return saved;
          } catch (e) { /* ignore */ }
        }
        return "";
      }

      function setDraftValue(value) {
        if (!state.selectedId) return;
        state.drafts[state.selectedId] = value;
        // Persist to localStorage
        try {
          localStorage.setItem("wand-draft-" + state.selectedId, value);
        } catch (e) { /* ignore */ }
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
        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
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
        var defaultCwd = state.workingDir || (state.config && state.config.defaultCwd ? state.config.defaultCwd : "");
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
        // Don't send empty Enter — avoids accidental terminal behavior
        if (appendEnter && value) {
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
          case "ctrl_u":
            return String.fromCharCode(21);
          case "ctrl_k":
            return String.fromCharCode(11);
          case "ctrl_w":
            return String.fromCharCode(23);
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

        // If WebSocket is disconnected, queue the message
        if (!state.wsConnected) {
          // Limit queue size to 100 messages
          if (state.pendingMessages.length >= 100) {
            state.pendingMessages.shift(); // Remove oldest
          }
          state.pendingMessages.push(input);
          // Still try HTTP fallback
        }

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

      function flushPendingMessages() {
        if (state.pendingMessages.length === 0) return;

        // Send queued messages in order
        var queue = state.pendingMessages.slice();
        state.pendingMessages = [];

        queue.forEach(function(input) {
          postInput(input).catch(function() {
            // Ignore errors during flush
          });
        });
      }

      function stopSession() {
        if (!state.selectedId) return;
        fetch("/api/sessions/" + state.selectedId + "/stop", { method: "POST" })
          .then(refreshAll);
      }

      function deleteSession(id) {
        // 二次确认
        if (!confirm("确定要删除这个会话吗？此操作无法撤销。")) {
          return;
        }
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
        var inputPanel = document.querySelector('.input-panel');
        var chatMessages = document.querySelector('.chat-messages');
        var terminalContainer = document.querySelector('.terminal-container');

        // Virtual Keyboard API (Chrome/Edge)
        if ('virtualKeyboard' in navigator) {
          var vk = navigator.virtualKeyboard;

          vk.addEventListener('geometrychange', function() {
            if (inputPanel) {
              var rect = vk.boundingRect;
              var kbHeight = rect ? rect.height : 0;
              inputPanel.style.paddingBottom = kbHeight > 0 ? kbHeight + 'px' : '';
              // Scroll chat into view when keyboard opens
              if (kbHeight > 0 && chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
              }
            }
          });
        }

        // Show virtual keyboard on terminal/chat tap
        var output = document.getElementById('output');
        if (output) {
          output.addEventListener('click', function() {
            if (state.selectedId) {
              var inputBox = document.getElementById('input-box');
              if (inputBox) inputBox.focus();
            }
          });
        }

        // Also focus on chat messages tap
        if (chatMessages) {
          chatMessages.addEventListener('click', function(e) {
            // Only focus if not clicking on a link or button
            if (e.target.tagName !== 'A' && e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
              var inputBox = document.getElementById('input-box');
              if (inputBox && state.selectedId) inputBox.focus();
            }
          });
        }
      }

      // Visual viewport handling for better mobile keyboard support
      function setupVisualViewportHandlers() {
        if (!('visualViewport' in window)) return;

        var vv = window.visualViewport;
        var inputPanel = document.querySelector('.input-panel');
        var appContainer = document.querySelector('.app-container');
        var lastHeight = vv.height;

        function updateViewport() {
          if (!inputPanel || !vv) return;

          var offsetBottom = window.innerHeight - vv.height - vv.offsetTop;
          var isKeyboardOpen = offsetBottom > 50;

          if (isKeyboardOpen) {
            // Keyboard is open - adjust layout
            inputPanel.style.transform = 'translateY(-' + offsetBottom + 'px)';
            inputPanel.style.position = 'relative';
            inputPanel.style.zIndex = '100';

            // Add padding to main content to prevent overlap
            if (appContainer) {
              appContainer.style.paddingBottom = offsetBottom + 'px';
            }
          } else {
            // Keyboard is closed - reset layout
            inputPanel.style.transform = '';
            inputPanel.style.zIndex = '';
            if (appContainer) {
              appContainer.style.paddingBottom = '';
            }
          }

          lastHeight = vv.height;
        }

        // Debounce viewport updates for smoother experience
        var viewportTimer = null;
        function debouncedUpdate() {
          if (viewportTimer) clearTimeout(viewportTimer);
          viewportTimer = setTimeout(updateViewport, 50);
        }

        vv.addEventListener('resize', debouncedUpdate);
        vv.addEventListener('scroll', debouncedUpdate);

        // Initial update
        updateViewport();
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
          // WebSocket will deliver updates; no need for initial refreshAll()
          // since the caller (restoreLoginSession) already called refreshAll()
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
            // Flush pending messages after reconnection
            flushPendingMessages();
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
        var prevHash = state.lastRenderedHash;
        var prevMsgCount = state.lastRenderedMsgCount;
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
          // Full render for first load / restore — no animation to avoid flicker
          // With column-reverse, render messages in reverse order (newest first)
          chatMessages.innerHTML = messages.slice().reverse().map(renderChatMessage).join("");
          attachAllCopyHandlers(chatMessages);
          // Scroll to bottom (which shows newest messages at the bottom visually)
          chatOutput.scrollTop = chatOutput.scrollHeight;
        } else if (msgCount > existingCount) {
          // New messages added — prepend them (column-reverse means prepend = visual append)
          var newMessages = messages.slice(existingCount);
          // Reverse so the newest ends up at the bottom
          newMessages.reverse();
          var fragment = document.createDocumentFragment();
          for (var i = 0; i < newMessages.length; i++) {
            var div = document.createElement("div");
            div.innerHTML = renderChatMessage(newMessages[i]);
            var el = div.firstElementChild;
            if (el) {
              el.classList.add("animate-in");
              fragment.appendChild(el);
            }
          }
          chatMessages.insertBefore(fragment, chatMessages.firstChild);
          attachAllCopyHandlers(chatMessages);
          // Smart scroll: only auto-scroll if user is near bottom
          smartScrollToBottom(chatOutput);
        } else if (msgCount === existingCount && outputHash !== prevHash) {
          // Same message count but content changed (streaming update) — update first message only (which is newest in column-reverse)
          // Optimized: only update if content actually changed to avoid flicker
          var firstEl = chatMessages.querySelector(".chat-message");
          if (firstEl && messages[0]) {
            // Check if the message content actually changed
            var currentContent = firstEl.querySelector(".chat-message-bubble");
            if (currentContent) {
              var newContent = messages[0].role === "assistant"
                ? renderMarkdown(messages[0].content || "")
                : escapeHtml(messages[0].content || "");
              // Only update if HTML content is different
              if (currentContent.innerHTML !== newContent) {
                var tmpDiv = document.createElement("div");
                tmpDiv.innerHTML = renderChatMessage(messages[0]);
                var newEl = tmpDiv.firstElementChild;
                if (newEl) {
                  chatMessages.replaceChild(newEl, firstEl);
                  attachCopyHandler(newEl);
                }
              }
            }
          }
        } else if (msgCount < existingCount) {
          // Message count decreased (session switched or output truncated) - full re-render without animation
          chatMessages.innerHTML = messages.slice().reverse().map(renderChatMessage).join("");
          attachAllCopyHandlers(chatMessages);
          // For session switch, scroll to bottom; otherwise preserve position
          if (state.lastRenderedEmpty === "none" || state.lastRenderedEmpty === "empty") {
            chatOutput.scrollTop = chatOutput.scrollHeight;
          } else {
            smartScrollToBottom(chatOutput);
          }
        }
      }

      // Smart scroll: only auto-scroll if user is near bottom
      function smartScrollToBottom(container) {
        var threshold = 100; // pixels from bottom
        var isNearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < threshold;
        if (isNearBottom) {
          container.scrollTop = container.scrollHeight;
        }
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
        var esc = String.fromCharCode(27);

        // Optimized ANSI escape sequence stripping
        // Handles: CSI sequences, OSC sequences, single-character escapes, control chars
        var nul = String.fromCharCode(0);
        var bs = String.fromCharCode(8);
        var vt = String.fromCharCode(11);
        var ff = String.fromCharCode(12);
        var so = String.fromCharCode(14);
        var us = String.fromCharCode(31);
        var nbsp = String.fromCharCode(160);
        var bel = String.fromCharCode(7);
        var ansiRegex = new RegExp(
          esc + '\\[[0-9;?]*[a-zA-Z]|' +  // CSI sequences
          esc + '\\][^' + bel + ']*(' + bel + '|' + esc + '\\\\\\\\)|' +  // OSC sequences - matches ESC ] ... (BEL or ESC \)
          esc + '[><=eP_X^]|' +  // Single-character escapes
          '[' + nul + '-' + bs + vt + ff + so + '-' + us + ']|' +  // Control chars: 0-8, 11, 12, 14-31
          nbsp + '|' + carriageReturn,
          'g'
        );
        var ansiStripped = text.replace(
          ansiRegex,
          function(m) { return m === nbsp ? ' ' : m === carriageReturn ? newline : ''; }
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
          // Additional noise filters
          if (line.indexOf("npm WARN") !== -1) continue;
          if (line.indexOf("npm notice") !== -1) continue;
          if (line.indexOf("added ") !== -1 && line.indexOf(" packages") !== -1) continue;
          if (line.indexOf("audited ") !== -1) continue;
          if (line.indexOf("found ") !== -1 && line.indexOf(" vulnerabilities") !== -1) continue;
          if (line.indexOf("Using ") !== -1 && line.indexOf(" for ") !== -1 && line.indexOf("session") !== -1) continue;
          if (line.indexOf("Permissions") !== -1 && line.indexOf("mode") !== -1) continue;
          if (line.indexOf("You can use") !== -1) continue;
          if (line.indexOf("Press ") !== -1 && line.indexOf(" for") !== -1) continue;
          if (line.indexOf("type ") === 0 && line.indexOf(" to ") !== -1) continue;
          if (line.indexOf("[wand]") === 0) continue;
          if (line.indexOf("Captured Claude session ID") !== -1) continue;
          // Filter partial/fragmented lines (likely from streaming)
          if (line.length < 3 && !/^[a-zA-Z]{3}$/.test(line)) continue;

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
          // Format and clean up assistant response
          var formattedContent = formatAssistantResponse(assistantLines.join(newline));
          messages.push({ role: "assistant", content: formattedContent });
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

        try {
          for (var i = 0; i < msg.content.length; i++) {
            var block = msg.content[i];
            try {
              blocksHtml += renderContentBlock(block, role);
            } catch (e) {
              // Render error for individual block
              blocksHtml += '<div class="render-error">消息块渲染失败</div>';
            }
          }
        } catch (e) {
          // Render error for entire message
          return '<div class="chat-message ' + role + '">' +
            avatar +
            '<div class="chat-message-bubble"><div class="render-error">消息渲染失败</div></div>' +
          '</div>';
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

      // Format assistant response with Markdown rendering and cleanup
      function formatAssistantResponse(text) {
        if (!text) return "";

        // Clean up the text
        var newline = String.fromCharCode(10);
        var lines = text.split(newline);
        var cleanLines = [];

        // Remove leading/trailing empty lines and common noise
        var started = false;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          var trimmed = line.trim();

          // Skip leading empty lines
          if (!started && !trimmed) continue;
          started = true;

          // Filter out noise patterns
          if (trimmed.indexOf("⏺") === 0 && trimmed.length > 2) {
            cleanLines.push(trimmed.slice(1).trim());
            continue;
          }

          cleanLines.push(line);
        }

        // Remove trailing empty lines
        while (cleanLines.length > 0 && !cleanLines[cleanLines.length - 1].trim()) {
          cleanLines.pop();
        }

        // Render as Markdown
        return renderMarkdown(cleanLines.join(newline));
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
        // Add error state to associated input field
        var inputEl = el.previousElementSibling;
        while (inputEl) {
          if (inputEl.tagName === "INPUT") {
            inputEl.setAttribute("data-error", "true");
            break;
          }
          inputEl = inputEl.previousElementSibling;
        }
      }

      function hideError(el) {
        if (!el) return;
        el.textContent = "";
        el.classList.add("hidden");
        // Remove error state from associated input field
        var inputEl = el.previousElementSibling;
        while (inputEl) {
          if (inputEl.tagName === "INPUT") {
            inputEl.setAttribute("data-error", "false");
            break;
          }
          inputEl = inputEl.previousElementSibling;
        }
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
// Trigger reload
