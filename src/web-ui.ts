export function renderApp(configPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Wand Console</title>
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
      --text-primary: #2f241c;
      --text-secondary: #5f4a39;
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
      --shadow-soft: 0 24px 60px rgba(89, 58, 32, 0.10);
      --radius-sm: 8px;
      --radius-md: 14px;
      --radius-lg: 22px;
      --font-sans: "Inter", "Helvetica Neue", "PingFang SC", "Noto Sans SC", sans-serif;
      --font-mono: "Geist Mono", "SF Mono", "Fira Code", monospace;
      --transition-fast: 0.1s ease;
      --transition-normal: 0.2s ease;
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
      min-height: 72px;
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
      box-shadow: 20px 0 48px rgba(89, 58, 32, 0.12);
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
      padding: 16px 18px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .sidebar-header-main {
      display: flex;
      align-items: center;
      gap: 10px;
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
      padding: 4px 8px;
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

    .session-item {
      width: 100%;
      text-align: left;
      background: rgba(255, 250, 244, 0.72);
      border: 1px solid rgba(150, 118, 85, 0.12);
      border-radius: 18px;
      color: var(--text-primary);
      padding: 12px 14px;
      cursor: pointer;
      transition: all var(--transition-fast);
      font-family: var(--font-sans);
      margin-bottom: 8px;
      box-shadow: 0 6px 18px rgba(89, 58, 32, 0.04);
    }

    .session-item:hover { background: rgba(255, 248, 240, 0.96); border-color: var(--accent-soft); transform: translateY(-1px); }
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

    .sidebar-footer {
      padding: 14px 12px 16px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .sidebar-meta {
      display: flex;
      flex-direction: column;
      gap: 8px;
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
    }

    .btn-primary { background: linear-gradient(180deg, #cf754d 0%, #b85c37 100%); color: white; box-shadow: 0 10px 24px rgba(184, 92, 55, 0.22); }
    .btn-primary:hover { background: linear-gradient(180deg, #c96b44 0%, #a94d2b 100%); }
    .btn-secondary { background: rgba(255, 250, 244, 0.9); color: var(--text-secondary); border-color: var(--border-subtle); }
    .btn-secondary:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--accent-soft); }
    .btn-ghost { background: transparent; color: var(--text-secondary); }
    .btn-ghost:hover { background: rgba(240, 229, 215, 0.72); color: var(--text-primary); }
    .btn-danger { background: var(--danger-muted); color: var(--danger); }
    .btn-danger:hover { background: var(--danger); color: white; }
    .btn-block { width: 100%; }
    .btn-sm { font-size: 0.75rem; padding: 6px 10px; }
    .btn-icon { padding: 6px; font-size: 1rem; }

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
      background:
        radial-gradient(circle at top right, rgba(91, 58, 34, 0.16), transparent 28%),
        linear-gradient(180deg, #221d18 0%, #1b1714 100%);
      padding: 18px;
      overflow: hidden;
      min-height: 200px;
      margin: 16px;
      border-radius: 24px;
      border: 1px solid rgba(122, 91, 64, 0.35);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), var(--shadow-soft);
    }

    .terminal-container .xterm { height: 100%; }
    .terminal-container .xterm-viewport { background: transparent !important; }

    .input-panel {
      background: rgba(255, 251, 245, 0.78);
      border-top: 1px solid var(--border-subtle);
      padding: 14px 18px 18px;
      backdrop-filter: blur(12px);
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
    .input-actions { display: flex; gap: 8px; flex-shrink: 0; }
    .input-actions .btn { min-width: 92px; }

    .floating-toggle {
      position: fixed;
      right: 16px;
      bottom: 24px;
      z-index: 40;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      box-shadow: 0 16px 28px rgba(89, 58, 32, 0.18);
    }

    .floating-pad {
      position: fixed;
      right: 16px;
      bottom: 88px;
      z-index: 39;
      width: min(220px, calc(100vw - 32px));
      background: rgba(255, 251, 245, 0.98);
      border: 1px solid rgba(150, 118, 85, 0.18);
      border-radius: 20px;
      box-shadow: var(--shadow-soft);
      padding: 12px;
      backdrop-filter: blur(18px);
    }

    .floating-pad-title {
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 10px;
    }

    .floating-pad-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      align-items: center;
    }

    .floating-pad-grid .btn {
      width: 100%;
      min-height: 42px;
      padding: 8px 10px;
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
      border-radius: 28px;
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
      border-radius: 14px;
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
      border-radius: 16px;
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
      border-radius: 24px;
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

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:focus-visible { outline-offset: 0; }

    @media (max-width: 768px) {
      .topbar {
        grid-template-columns: auto minmax(0, 1fr) auto;
        padding: 10px 14px;
      }
      .sidebar { width: min(304px, calc(100vw - 28px)); }
      .config-path { display: none; }
      .terminal-container { min-height: 180px; }
      .session-summary-value { max-width: 40vw; }
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

      .topbar {
        position: sticky;
        top: 0;
        z-index: 30;
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas:
          "left right"
          "center center";
        align-items: center;
        gap: 10px 12px;
      }

      .topbar-left { grid-area: left; }
      .topbar-center { grid-area: center; justify-content: flex-start; }
      .topbar-right { grid-area: right; width: auto; }
      .brand-subtitle { display: none; }
      .status-badge { display: none; }
      .session-summary {
        align-items: flex-start;
        text-align: left;
      }
      .session-summary-value { max-width: calc(100vw - 32px); }

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
        padding: 12px;
        -webkit-overflow-scrolling: touch;
      }

      .session-item {
        width: 100%;
        max-width: none;
        margin-bottom: 8px;
      }

      .main-content {
        overflow: visible;
      }

      .terminal-header, .input-panel { padding-left: 14px; padding-right: 14px; }

      .terminal-header {
        align-items: flex-start;
        gap: 8px;
      }

      .terminal-title {
        width: 100%;
        flex-direction: column;
        align-items: flex-start;
      }

      .terminal-container {
        flex: none;
        min-height: 46vh;
        max-height: 58vh;
        margin: 12px;
        padding: 14px;
        border-radius: 20px;
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }

      .input-panel {
        position: sticky;
        bottom: 0;
        z-index: 20;
        padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px));
        box-shadow: 0 -10px 30px rgba(89, 58, 32, 0.08);
      }

      .input-row { flex-direction: column; align-items: stretch; }
      .input-actions {
        width: 100%;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .input-actions .btn {
        width: 100%;
        min-width: 0;
      }

      .input-textarea,
      .field-input {
        font-size: 16px;
      }

      .floating-toggle {
        right: 14px;
        bottom: calc(92px + env(safe-area-inset-bottom, 0px));
      }

      .floating-pad {
        right: 14px;
        bottom: calc(154px + env(safe-area-inset-bottom, 0px));
        width: min(220px, calc(100vw - 28px));
      }

      .login-container {
        min-height: 100dvh;
        align-items: flex-start;
        padding: 18px 14px calc(18px + env(safe-area-inset-bottom, 0px));
      }

      .login-card {
        margin-top: max(16px, env(safe-area-inset-top, 0px));
      }
    }

    @media (max-width: 420px) {
      .topbar-left,
      .topbar-center {
        width: 100%;
      }

      .topbar-right {
        gap: 6px;
      }

      .terminal-container {
        min-height: 38vh;
        max-height: 50vh;
      }

      .floating-pad {
        width: calc(100vw - 24px);
        right: 12px;
      }

      .floating-pad-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
  </style>
</head>
<body>
  <div id="app"></div>

  <script src="/vendor/xterm/lib/xterm.js"></script>
  <script>
    (function() {
      var configPath = "${escapeHtml(configPath)}";

      var state = {
        selectedId: null,
        pollTimer: null,
        config: null,
        sessions: [],
        suggestionTimer: null,
        terminal: null,
        terminalSessionId: null,
        terminalOutput: "",
        resizeObserver: null,
        resizeHandler: null,
        resizeTimer: null,
        inputQueue: Promise.resolve(),
        drafts: {},
        isSyncingInputBox: false,
        loginPending: false,
        sessionsDrawerOpen: false,
        modalOpen: false,
        presetValue: "",
        commandValue: "",
        cwdValue: "",
        modeValue: "default",
        lastResize: { cols: 0, rows: 0 }
      };

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
        var selectedSession = state.sessions.find(function(s) { return s.id === state.selectedId; });
        var terminalTitle = selectedSession ? shortCommand(selectedSession.command) : "No session";
        var terminalInfo = selectedSession ? (selectedSession.mode + " | " + selectedSession.status) : "Select or start a session";
        var currentDraft = state.selectedId ? (state.drafts[state.selectedId] || "") : "";
        var statusClass = state.config ? "status-dot active" : "status-dot";
        var statusText = state.config ? "Unlocked" : "Locked";
        var drawerClass = state.sessionsDrawerOpen ? " open" : "";

        return '<div class="app-container">' +
          '<header class="topbar">' +
            '<div class="topbar-left">' +
              '<div class="topbar-actions">' +
                '<button id="sessions-toggle-button" class="btn btn-secondary btn-sm">Menu</button>' +
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
            '</div>' +
            '<div class="topbar-center">' +
              '<div class="session-summary">' +
                '<span class="session-summary-label">Current Session</span>' +
                '<span class="session-summary-value">' + escapeHtml(terminalTitle) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="topbar-right">' +
              '<button id="topbar-new-session-button" class="btn btn-primary btn-sm">+ New Session</button>' +
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
              '</div>' +
              '<div id="output" class="terminal-container"></div>' +
              '<div class="input-panel">' +
                '<div class="input-row">' +
                  '<div class="input-field">' +
                    '<label class="input-label" for="input-box">Send to session</label>' +
                    '<textarea id="input-box" class="input-textarea" placeholder="Type here to send input to the session..." rows="1">' + escapeHtml(currentDraft) + '</textarea>' +
                  '</div>' +
                  '<div class="input-actions">' +
                    '<button id="send-input-button" class="btn btn-primary">Send</button>' +
                    '<button id="stop-button" class="btn btn-danger">Stop</button>' +
                  '</div>' +
                '</div>' +
                '<button id="floating-controls-toggle" class="btn btn-secondary floating-toggle" type="button">+</button>' +
                '<div id="floating-controls" class="floating-pad hidden">' +
                  '<div class="floating-pad-title">Quick Controls</div>' +
                  '<div class="floating-pad-grid">' +
                    '<span class="floating-pad-spacer"></span>' +
                    '<button data-input-key="up" class="btn btn-secondary btn-sm quick-input" type="button">↑</button>' +
                    '<button data-input-key="enter" class="btn btn-secondary btn-sm quick-input" type="button">Enter</button>' +
                    '<button data-input-key="left" class="btn btn-secondary btn-sm quick-input" type="button">←</button>' +
                    '<button data-input-key="down" class="btn btn-secondary btn-sm quick-input" type="button">↓</button>' +
                    '<button data-input-key="right" class="btn btn-secondary btn-sm quick-input" type="button">→</button>' +
                    '<button data-input-key="yes" class="btn btn-secondary btn-sm quick-input" type="button">y</button>' +
                    '<button data-input-key="no" class="btn btn-secondary btn-sm quick-input" type="button">n</button>' +
                    '<button data-input-key="ctrl_c" class="btn btn-secondary btn-sm quick-input" type="button">Ctrl+C</button>' +
                  '</div>' +
                '</div>' +
                '<p id="action-error" class="error-message hidden"></p>' +
              '</div>' +
            '</main>' +
          '</div>' +
        '</div>' + renderSessionModal();
      }

      function renderSessions() {
        if (state.sessions.length === 0) {
          return '<div class="empty-state"><strong>还没有会话</strong>从左下角启动一个新会话，终端输出会显示在右侧。</div>';
        }
        return state.sessions.map(function(session) {
          var activeClass = session.id === state.selectedId ? " active" : "";
          return '<button class="session-item' + activeClass + '" data-session-id="' + session.id + '">' +
            '<div class="session-command">' + escapeHtml(session.command) + '</div>' +
            '<div class="session-meta">' +
              '<span>' + escapeHtml(session.mode) + '</span>' +
              '<span class="session-status ' + session.status + '">' + escapeHtml(session.status) + '</span>' +
            '</div>' +
          '</button>';
        }).join("");
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
        var isLoggedIn = state.config !== null;

        if (!isLoggedIn) {
          document.getElementById("login-button").addEventListener("click", login);
          var passwordEl = document.getElementById("password");
          passwordEl.addEventListener("keydown", function(e) {
            if (e.key === "Enter") login();
          });
          passwordEl.focus();
          return;
        }

        var sessionsList = document.getElementById("sessions-list");
        if (sessionsList) {
          sessionsList.addEventListener("click", function(event) {
            var target = event.target;
            if (!target || !(target instanceof Element)) return;
            var button = target.closest(".session-item");
            if (button && button.dataset.sessionId) {
              selectSession(button.dataset.sessionId);
              closeSessionsDrawer();
            }
          });
        }

        document.getElementById("command").addEventListener("input", function() {
          state.commandValue = this.value;
        });
        document.getElementById("cwd").addEventListener("input", function() {
          state.cwdValue = this.value;
        });
        document.getElementById("cwd").addEventListener("change", function() {
          state.cwdValue = this.value;
        });
        document.getElementById("sessions-toggle-button").addEventListener("click", toggleSessionsDrawer);
        document.getElementById("sessions-drawer-backdrop").addEventListener("click", closeSessionsDrawer);
        document.getElementById("close-drawer-button").addEventListener("click", closeSessionsDrawer);
        document.getElementById("logout-button").addEventListener("click", logout);
        document.getElementById("topbar-new-session-button").addEventListener("click", openSessionModal);
        document.getElementById("drawer-new-session-button").addEventListener("click", openSessionModal);
        document.getElementById("close-modal-button").addEventListener("click", closeSessionModal);
        document.getElementById("run-button").addEventListener("click", runCommand);
        document.getElementById("send-input-button").addEventListener("click", function() { sendInputFromBox(false); });
        document.getElementById("stop-button").addEventListener("click", stopSession);

        document.getElementById("floating-controls-toggle").addEventListener("click", toggleFloatingControls);

        document.querySelectorAll(".quick-input").forEach(function(btn) {
          btn.addEventListener("click", function() {
            sendDirectInput(getControlInput(btn.dataset.inputKey || ""));
            hideFloatingControls();
          });
        });

        document.getElementById("session-modal").addEventListener("click", function(e) {
          if (e.target.id === "session-modal") closeSessionModal();
        });

        document.getElementById("preset-select").addEventListener("change", function() {
          state.presetValue = this.value;
          applyPreset();
        });
        document.getElementById("mode").addEventListener("change", function() { state.modeValue = this.value; });
        document.getElementById("cwd").addEventListener("input", schedulePathSuggestions);
        document.getElementById("cwd").addEventListener("focus", schedulePathSuggestions);
        document.getElementById("cwd").addEventListener("blur", function() { setTimeout(hidePathSuggestions, 120); });
        document.getElementById("input-box").addEventListener("keydown", handleInputBoxKeydown);
        document.getElementById("input-box").addEventListener("paste", handleInputPaste);

        initTerminal();
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

        state.terminal.open(container);

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
          });
      }

      function updateSessionsList() {
        var listEl = document.getElementById("sessions-list");
        var countEl = document.getElementById("session-count");
        if (listEl) listEl.innerHTML = renderSessions();
        if (countEl) countEl.textContent = String(state.sessions.length);
      }

      function loadOutput(id) {
        return fetch("/api/sessions/" + id)
          .then(function(res) { return res.json(); })
          .then(function(data) {
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
          });
      }

      function selectSession(id) {
        state.selectedId = id;
        render();
        loadOutput(id).then(focusInputBox);
      }

      function toggleSessionsDrawer() {
        state.sessionsDrawerOpen = !state.sessionsDrawerOpen;
        render();
      }

      function closeSessionsDrawer() {
        if (!state.sessionsDrawerOpen) return;
        state.sessionsDrawerOpen = false;
        render();
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

        fetch("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: command,
            cwd: cwdEl.value.trim(),
            mode: modeEl.value
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
          commandEl.value = "";
          return refreshAll();
        })
        .then(focusInputBox)
        .catch(function(error) {
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
        if (!panel) return;
        panel.classList.toggle("hidden");
      }

      function hideFloatingControls() {
        var panel = document.getElementById("floating-controls");
        if (panel) {
          panel.classList.add("hidden");
        }
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

      function focusInputBox() {
        var inputBox = document.getElementById("input-box");
        if (!inputBox || !state.selectedId) return;
        if (document.activeElement === inputBox) return;
        inputBox.focus();
        inputBox.setSelectionRange(inputBox.value.length, inputBox.value.length);
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
        state.terminalSessionId = null;
      }

      function scheduleTerminalResize() {
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(syncTerminalSize, 60);
      }

      function syncTerminalSize() {
        var output = document.getElementById("output");
        if (!state.terminal || !output) return;

        var nextSize = measureTerminalSize(output);
        if (!nextSize) return;

        if (state.terminal.cols !== nextSize.cols || state.terminal.rows !== nextSize.rows) {
          state.terminal.resize(nextSize.cols, nextSize.rows);
        }

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

      function measureTerminalSize(container) {
        var style = window.getComputedStyle(container);
        var paddingX = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
        var paddingY = parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
        var width = container.clientWidth - paddingX;
        var height = container.clientHeight - paddingY;
        if (width <= 0 || height <= 0) return null;

        var fontSize = 13;
        var lineHeight = fontSize * 1.5;
        var cellWidth = fontSize * 0.6;
        return {
          cols: Math.max(20, Math.floor(width / cellWidth)),
          rows: Math.max(10, Math.floor(height / lineHeight))
        };
      }

      function startPolling() {
        stopPolling();
        state.pollTimer = setInterval(refreshAll, 1600);
      }

      function stopPolling() {
        if (state.pollTimer) {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      }

      function shortCommand(cmd) {
        var s = String(cmd || "").trim();
        return s.length <= 24 ? s || "Terminal" : s.slice(0, 21) + "...";
      }

      function normalizeTerminalOutput(value) {
        var text = String(value || "");
        text = text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
        text = text.split(String.fromCharCode(13)).join(String.fromCharCode(10));
        return text.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10));
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
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
