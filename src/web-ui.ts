export function renderApp(configPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Wand</title>
  <link rel="stylesheet" href="/vendor/xterm/css/xterm.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --base-900: #0a0a0a;
      --base-800: #111111;
      --base-700: #1a1a1a;
      --base-600: #242424;
      --base-500: #2e2e2e;
      --base-400: #3d3d3d;
      --base-300: #525252;
      --base-200: #737373;
      --base-100: #a3a3a3;
      --base-50: #e5e5e5;
      --accent: #c8ff00;
      --accent-dim: rgba(200, 255, 0, 0.15);
      --accent-glow: rgba(200, 255, 0, 0.4);
      --warning: #ff6b35;
      --danger: #ff3366;
      --success: #00ff88;
      --terminal-bg: #000000;
      --terminal-fg: #c8ff00;
      --radius: 4px;
      --radius-lg: 8px;
      --font-display: "Space Grotesk", sans-serif;
      --font-mono: "JetBrains Mono", monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      font-size: 16px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    body {
      font-family: var(--font-mono);
      background: var(--base-900);
      color: var(--base-50);
      min-height: 100vh;
      line-height: 1.5;
      overflow-x: hidden;
    }

    /* Noise texture overlay */
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
      opacity: 0.03;
      pointer-events: none;
      z-index: 1000;
    }

    /* Grid pattern background */
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(rgba(200, 255, 0, 0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(200, 255, 0, 0.02) 1px, transparent 1px);
      background-size: 40px 40px;
      pointer-events: none;
      z-index: 0;
    }

    /* Main container */
    .workshop {
      position: relative;
      z-index: 1;
      max-width: 1400px;
      margin: 0 auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 100vh;
    }

    /* Header panel */
    .header-panel {
      background: var(--base-800);
      border: 1px solid var(--base-600);
      padding: 20px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      position: relative;
      animation: slideDown 0.4s ease-out;
    }

    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Corner brackets decoration */
    .header-panel::before,
    .header-panel::after {
      content: "";
      position: absolute;
      width: 12px;
      height: 12px;
      border-color: var(--accent);
      border-style: solid;
    }

    .header-panel::before {
      top: 6px;
      left: 6px;
      border-width: 2px 0 0 2px;
    }

    .header-panel::after {
      bottom: 6px;
      right: 6px;
      border-width: 0 2px 2px 0;
    }

    .brand {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }

    .logo {
      font-family: var(--font-display);
      font-size: 2rem;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: -0.02em;
      text-transform: uppercase;
    }

    .tagline {
      font-size: 0.75rem;
      color: var(--base-300);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .status-cluster {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--base-200);
    }

    .led {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--base-500);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5);
      transition: all 0.3s ease;
    }

    .led.on {
      background: var(--accent);
      box-shadow:
        inset 0 1px 2px rgba(255, 255, 255, 0.3),
        0 0 8px var(--accent-glow),
        0 0 16px var(--accent-dim);
    }

    .led.warning {
      background: var(--warning);
      box-shadow:
        inset 0 1px 2px rgba(255, 255, 255, 0.3),
        0 0 8px rgba(255, 107, 53, 0.5);
    }

    .led.danger {
      background: var(--danger);
      box-shadow:
        inset 0 1px 2px rgba(255, 255, 255, 0.3),
        0 0 8px rgba(255, 51, 102, 0.5);
    }

    /* Config path display */
    .config-path {
      font-size: 0.6875rem;
      color: var(--base-400);
      padding: 4px 8px;
      background: var(--base-700);
      border: 1px solid var(--base-600);
      font-family: var(--font-mono);
    }

    /* Panel base styles */
    .panel {
      background: var(--base-800);
      border: 1px solid var(--base-600);
      position: relative;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--base-600);
      background: var(--base-700);
    }

    .panel-title {
      font-family: var(--font-display);
      font-size: 0.875rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--base-100);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .panel-title::before {
      content: "//";
      color: var(--accent);
      font-weight: 400;
    }

    .panel-body {
      padding: 16px;
    }

    /* Login panel */
    .login-panel {
      max-width: 420px;
      margin: 10vh auto;
      animation: fadeIn 0.5s ease-out 0.2s both;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.98); }
      to { opacity: 1; transform: scale(1); }
    }

    .login-panel .panel-body {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .login-intro {
      color: var(--base-200);
      font-size: 0.875rem;
      line-height: 1.6;
    }

    /* Form elements */
    .field {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .field-label {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--base-300);
      font-weight: 500;
    }

    .field-input {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      background: var(--base-900);
      border: 1px solid var(--base-500);
      color: var(--base-50);
      padding: 12px 16px;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .field-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-dim);
    }

    .field-input::placeholder {
      color: var(--base-500);
    }

    textarea.field-input {
      resize: vertical;
      min-height: 80px;
      line-height: 1.5;
    }

    /* Buttons */
    .btn {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 12px 20px;
      border: none;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .btn:active {
      transform: translateY(1px);
    }

    .btn-primary {
      background: var(--accent);
      color: var(--base-900);
    }

    .btn-primary:hover {
      background: #d4ff33;
      box-shadow: 0 0 20px var(--accent-dim);
    }

    .btn-secondary {
      background: transparent;
      color: var(--base-100);
      border: 1px solid var(--base-500);
    }

    .btn-secondary:hover {
      border-color: var(--base-300);
      background: var(--base-700);
    }

    .btn-ghost {
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid transparent;
    }

    .btn-ghost:hover {
      background: rgba(200, 255, 0, 0.25);
    }

    .btn-danger {
      background: rgba(255, 51, 102, 0.15);
      color: var(--danger);
      border: 1px solid rgba(255, 51, 102, 0.3);
    }

    .btn-danger:hover {
      background: rgba(255, 51, 102, 0.25);
    }

    .btn-group {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    /* App layout */
    .app-layout {
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 16px;
      flex: 1;
      animation: slideUp 0.5s ease-out 0.1s both;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Session list */
    .sessions-panel {
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 140px);
    }

    .sessions-panel .panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .session-actions {
      display: flex;
      gap: 4px;
    }

    .session-count {
      font-size: 0.6875rem;
      color: var(--base-400);
      padding: 4px 8px;
      background: var(--base-800);
      border: 1px solid var(--base-600);
      margin-right: auto;
    }

    .session-item {
      width: 100%;
      text-align: left;
      background: var(--base-700);
      border: 1px solid transparent;
      color: var(--base-50);
      padding: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: var(--font-mono);
    }

    .session-item:hover {
      background: var(--base-600);
      border-color: var(--base-500);
    }

    .session-item.active {
      background: var(--accent-dim);
      border-color: var(--accent);
    }

    .session-item.active .session-command {
      color: var(--accent);
    }

    .session-command {
      font-weight: 500;
      font-size: 0.8125rem;
      margin-bottom: 4px;
      word-break: break-all;
    }

    .session-meta {
      font-size: 0.6875rem;
      color: var(--base-400);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 6px;
    }

    .session-meta-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .session-status {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .session-status.running {
      background: rgba(0, 255, 136, 0.15);
      color: var(--success);
    }

    .session-status.exited {
      background: var(--base-600);
      color: var(--base-300);
    }

    .session-status.failed {
      background: rgba(255, 51, 102, 0.15);
      color: var(--danger);
    }

    .session-status.stopped {
      background: rgba(255, 107, 53, 0.15);
      color: var(--warning);
    }

    /* Terminal panel */
    .terminal-panel {
      display: flex;
      flex-direction: column;
    }

    .terminal-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .terminal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background: var(--base-700);
      border-bottom: 1px solid var(--base-600);
      font-size: 0.6875rem;
      color: var(--base-400);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .terminal-title {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 500;
    }

    .terminal-controls {
      display: flex;
      gap: 4px;
    }

    .terminal-container {
      flex: 1;
      min-height: 300px;
      max-height: 50vh;
      background: var(--terminal-bg);
      border: none;
      overflow: auto;
      padding: 12px;
      min-width: 0;
    }

    .terminal-container .xterm-screen {
      font-family: '"JetBrains Mono", monospace';
    }

    .terminal-container .xterm {
      padding: 0;
    }

    .terminal-container .xterm-viewport {
      background: var(--terminal-bg) !important;
    }

    /* Input panel */
    .input-panel .panel-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .input-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .quick-inputs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    /* Error message */
    .error-message {
      font-size: 0.75rem;
      color: var(--danger);
      padding: 8px 12px;
      background: rgba(255, 51, 102, 0.1);
      border-left: 2px solid var(--danger);
      margin: 0;
    }

    /* Hint text */
    .hint {
      font-size: 0.6875rem;
      color: var(--base-400);
      font-style: italic;
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      background: rgba(0, 0, 0, 0.85);
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.2s ease-out;
    }

    .modal {
      width: 100%;
      max-width: 480px;
      max-height: 90vh;
      overflow-y: auto;
      animation: scaleIn 0.25s ease-out;
    }

    @keyframes scaleIn {
      from {
        opacity: 0;
        transform: scale(0.95) translateY(-10px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    .modal .panel-body {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Path suggestions dropdown */
    .suggestions-wrap {
      position: relative;
    }

    .suggestions {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 50;
      background: var(--base-700);
      border: 1px solid var(--base-500);
      max-height: 200px;
      overflow-y: auto;
    }

    .suggestion-item {
      width: 100%;
      text-align: left;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: var(--base-50);
      cursor: pointer;
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      display: flex;
      flex-direction: column;
      gap: 2px;
      transition: background 0.15s ease;
    }

    .suggestion-item:hover {
      background: var(--accent-dim);
    }

    .suggestion-item small {
      font-size: 0.6875rem;
      color: var(--base-400);
    }

    /* Chip tags */
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .chip {
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 4px 8px;
      background: var(--base-700);
      border: 1px solid var(--base-600);
      color: var(--base-200);
      font-family: var(--font-mono);
    }

    .chip-accent {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-dim);
    }

    /* Select dropdown */
    select.field-input {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 36px;
    }

    select.field-input option {
      background: var(--base-800);
      color: var(--base-50);
    }

    /* Hidden utility */
    .hidden {
      display: none !important;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 24px 16px;
      color: var(--base-400);
      font-size: 0.8125rem;
    }

    /* Responsive */
    @media (max-width: 800px) {
      .app-layout {
        grid-template-columns: 1fr;
      }

      .sessions-panel {
        max-height: 200px;
      }

      .terminal-container {
        min-height: 250px;
        max-height: none;
      }

      .modal-backdrop {
        align-items: flex-end;
        padding: 0;
      }

      .modal {
        max-width: none;
        max-height: 85vh;
        border-radius: 0;
      }

      .brand {
        flex-direction: column;
        gap: 4px;
      }

      .tagline {
        display: none;
      }
    }

    /* Scrollbar styling */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    ::-webkit-scrollbar-track {
      background: var(--base-800);
    }

    ::-webkit-scrollbar-thumb {
      background: var(--base-500);
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--base-400);
    }

    /* Focus visible */
    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    button:focus-visible {
      outline-offset: 0;
    }
  </style>
</head>
<body>
  <div class="workshop">
    <!-- Header -->
    <header class="header-panel">
      <div class="brand">
        <div class="logo">Wand</div>
        <div class="tagline">CLI Control Console</div>
      </div>
      <div class="status-cluster">
        <div class="status-indicator">
          <span class="led" id="status-led"></span>
          <span id="status-text">Locked</span>
        </div>
        <div class="config-path">${escapeHtml(configPath)}</div>
      </div>
    </header>

    <!-- Login Panel -->
    <section id="login-panel" class="login-panel panel">
      <div class="panel-header">
        <h2 class="panel-title">Authentication Required</h2>
      </div>
      <div class="panel-body">
        <p class="login-intro">Enter the web password from your config file to unlock the console.</p>
        <div class="field">
          <label class="field-label" for="password">Password</label>
          <input
            id="password"
            type="password"
            class="field-input"
            placeholder="Enter password"
            autocomplete="current-password"
          />
        </div>
        <div class="btn-group">
          <button id="login-button" class="btn btn-primary">Unlock Console</button>
        </div>
        <p id="login-error" class="error-message hidden"></p>
      </div>
    </section>

    <!-- App Panel -->
    <div id="app-panel" class="app-layout hidden">
      <!-- Sessions Sidebar -->
      <aside class="sessions-panel panel">
        <div class="panel-header">
          <h2 class="panel-title">Sessions</h2>
          <div class="session-actions">
            <span class="session-count" id="session-count">0</span>
            <button id="refresh-button" class="btn btn-secondary" title="Refresh">↻</button>
            <button id="logout-button" class="btn btn-secondary" title="Logout">Logout</button>
          </div>
        </div>
        <div class="panel-body" id="sessions-list">
          <div class="empty-state">No sessions yet</div>
        </div>
        <div class="panel-body" style="padding-top: 0; border-top: 1px solid var(--base-600);">
          <button id="open-session-modal-button" class="btn btn-primary" style="width: 100%;">+ New Session</button>
        </div>
      </aside>

      <!-- Main Content -->
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <!-- Terminal -->
        <section class="terminal-panel panel">
          <div class="terminal-header">
            <span>Terminal: <span id="terminal-title" class="terminal-title">No session</span></span>
            <div class="terminal-controls">
              <button id="send-enter-button" class="btn btn-ghost">Enter</button>
              <button id="send-ctrlc-button" class="btn btn-ghost">Ctrl+C</button>
              <button id="stop-button" class="btn btn-danger">Stop</button>
            </div>
          </div>
          <div id="session-meta" class="terminal-header" style="border-top: none;">
            Select or start a session
          </div>
          <div id="output" class="terminal-container"></div>
        </section>

        <!-- Input Panel -->
        <section class="input-panel panel">
          <div class="panel-header">
            <h2 class="panel-title">Input</h2>
            <span class="hint">Live sync while typing. Enter submits, Shift+Enter inserts newline.</span>
          </div>
          <div class="panel-body">
            <div class="field">
              <label class="field-label" for="input-box">Send to selected session</label>
              <textarea
                id="input-box"
                class="field-input"
                placeholder="Type here and it streams into the selected session immediately..."
              ></textarea>
            </div>
            <div class="input-controls">
              <button id="send-input-button" class="btn btn-primary">Send Line</button>
              <div class="quick-inputs">
                <button data-input="y\r" class="btn btn-secondary quick-input">y</button>
                <button data-input="n\r" class="btn btn-secondary quick-input">n</button>
                <button data-input="\u001b[A" class="btn btn-secondary quick-input">↑</button>
                <button data-input="\u001b[B" class="btn btn-secondary quick-input">↓</button>
              </div>
            </div>
            <p id="action-error" class="error-message hidden"></p>
          </div>
        </section>
      </div>
    </div>
  </div>

  <!-- New Session Modal -->
  <section id="session-modal" class="modal-backdrop hidden">
    <div class="modal panel">
      <div class="panel-header">
        <h2 class="panel-title">New Session</h2>
        <button id="close-session-modal-button" class="btn btn-secondary">Close</button>
      </div>
      <div class="panel-body">
        <div class="field">
          <label class="field-label" for="preset-select">Preset</label>
          <select id="preset-select" class="field-input">
            <option value="">Custom command</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="command">Command</label>
          <textarea
            id="command"
            class="field-input"
            placeholder="codex&#10;cloud-code&#10;gemini"
            rows="3"
          ></textarea>
        </div>
        <div class="field">
          <label class="field-label" for="cwd">Working Directory</label>
          <div class="suggestions-wrap">
            <input
              id="cwd"
              type="text"
              class="field-input"
              autocomplete="off"
              placeholder="Defaults to config defaultCwd"
            />
            <div id="cwd-suggestions" class="suggestions hidden"></div>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for="mode">Mode</label>
          <select id="mode" class="field-input">
            <option value="auto-edit">Auto Edit</option>
            <option value="default">Default</option>
            <option value="full-access">Full Access</option>
          </select>
        </div>
        <div class="btn-group">
          <button id="run-button" class="btn btn-primary">Start Session</button>
        </div>
        <p class="hint">Use presets for quick access, or type any CLI command manually.</p>
      </div>
    </div>
  </section>

  <script src="/vendor/xterm/lib/xterm.js"></script>
  <script>
    const state = {
      selectedId: null,
      pollTimer: null,
      config: null,
      sessions: [],
      suggestionTimer: null,
      terminal: null,
      terminalSessionId: null,
      terminalOutput: "",
      resizeObserver: null,
      resizeTimer: null,
      inputQueue: Promise.resolve(),
      drafts: {},
      isSyncingInputBox: false
    };

    const els = {
      loginPanel: document.getElementById("login-panel"),
      appPanel: document.getElementById("app-panel"),
      loginError: document.getElementById("login-error"),
      actionError: document.getElementById("action-error"),
      sessionsList: document.getElementById("sessions-list"),
      output: document.getElementById("output"),
      sessionMeta: document.getElementById("session-meta"),
      terminalTitle: document.getElementById("terminal-title"),
      statusLed: document.getElementById("status-led"),
      statusText: document.getElementById("status-text"),
      sessionCount: document.getElementById("session-count"),
      sessionModal: document.getElementById("session-modal"),
      presetSelect: document.getElementById("preset-select"),
      command: document.getElementById("command"),
      cwd: document.getElementById("cwd"),
      mode: document.getElementById("mode"),
      password: document.getElementById("password"),
      inputBox: document.getElementById("input-box"),
      cwdSuggestions: document.getElementById("cwd-suggestions")
    };

    // Event listeners
    document.getElementById("login-button").addEventListener("click", login);
    document.getElementById("logout-button").addEventListener("click", logout);
    document.getElementById("open-session-modal-button").addEventListener("click", openSessionModal);
    document.getElementById("close-session-modal-button").addEventListener("click", closeSessionModal);
    document.getElementById("run-button").addEventListener("click", runCommand);
    document.getElementById("refresh-button").addEventListener("click", refreshAll);
    document.getElementById("send-input-button").addEventListener("click", () => sendInputFromBox(false));
    document.getElementById("send-enter-button").addEventListener("click", () => sendDirectInput("\\r"));
    document.getElementById("send-ctrlc-button").addEventListener("click", () => sendDirectInput("\\u0003"));
    document.getElementById("stop-button").addEventListener("click", stopSession);

    els.presetSelect.addEventListener("change", applyPreset);
    els.cwd.addEventListener("input", schedulePathSuggestions);
    els.cwd.addEventListener("focus", schedulePathSuggestions);
    els.cwd.addEventListener("blur", () => setTimeout(hidePathSuggestions, 120));
    els.sessionModal.addEventListener("click", (e) => {
      if (e.target === els.sessionModal) closeSessionModal();
    });
    els.password.addEventListener("keydown", (e) => {
      if (e.key === "Enter") login();
    });
    els.inputBox.addEventListener("keydown", handleInputBoxKeydown);
    els.inputBox.addEventListener("paste", handleInputPaste);

    document.querySelectorAll(".quick-input").forEach((btn) => {
      btn.addEventListener("click", () => sendDirectInput(btn.dataset.input || ""));
    });

    initTerminal();

    function initTerminal() {
      state.terminal = new Terminal({
        cols: 120,
        rows: 36,
        convertEol: false,
        disableStdin: true,
        cursorBlink: false,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        theme: {
          background: "#000000",
          foreground: "#c8ff00",
          cursor: "#c8ff00",
          selectionBackground: "rgba(200, 255, 0, 0.3)"
        }
      });
      state.terminal.open(els.output);
      state.terminal.writeln("Select or start a session.");
      state.terminal.onData((data) => {
        queueDirectInput(data);
      });
      els.output.addEventListener("click", () => focusInputBox());
      observeTerminalResize();
    }

    async function login() {
      hideError(els.loginError);
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: els.password.value })
      });

      if (!res.ok) {
        showError(els.loginError, "Password rejected.");
        return;
      }

      els.statusLed.classList.add("on");
      els.statusText.textContent = "Unlocked";
      els.loginPanel.classList.add("hidden");
      els.appPanel.classList.remove("hidden");
      closeSessionModal();
      await loadConfig();
      await refreshAll();
      startPolling();
    }

    async function logout() {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch {}

      stopPolling();
      state.selectedId = null;
      state.sessions = [];
      els.statusLed.classList.remove("on");
      els.statusText.textContent = "Locked";
      els.appPanel.classList.add("hidden");
      els.loginPanel.classList.remove("hidden");
      closeSessionModal();
      renderTerminal("Select or start a session.", null);
      els.sessionMeta.textContent = "Select or start a session";
      els.terminalTitle.textContent = "No session";
      els.sessionsList.innerHTML = '<div class="empty-state">No sessions yet</div>';
      syncInputBox();
      hideError(els.actionError);
    }

    async function loadConfig() {
      const res = await fetch("/api/config");
      if (res.status === 401) {
        await logout();
        return;
      }
      const data = await res.json();
      state.config = data;
      els.cwd.placeholder = data.defaultCwd || "Defaults to config defaultCwd";
      els.mode.value = data.defaultMode || "default";

      els.presetSelect.innerHTML = '<option value="">Custom command</option>';
      (data.commandPresets || []).forEach((preset, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = preset.label + " — " + preset.command;
        els.presetSelect.appendChild(opt);
      });
    }

    function schedulePathSuggestions() {
      if (state.suggestionTimer) clearTimeout(state.suggestionTimer);
      state.suggestionTimer = setTimeout(loadPathSuggestions, 120);
    }

    async function loadPathSuggestions() {
      if (!els.loginPanel.classList.contains("hidden")) return;
      if (els.sessionModal.classList.contains("hidden")) {
        hidePathSuggestions();
        return;
      }

      try {
        const res = await fetch("/api/path-suggestions?q=" + encodeURIComponent(els.cwd.value.trim()));
        if (!res.ok) {
          hidePathSuggestions();
          return;
        }
        const data = await res.json();
        renderPathSuggestions(data);
      } catch {
        hidePathSuggestions();
      }
    }

    function renderPathSuggestions(items) {
      if (!items.length) {
        hidePathSuggestions();
        return;
      }

      els.cwdSuggestions.innerHTML = "";
      items.forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "suggestion-item";
        btn.innerHTML = "<strong>" + escapeHtml(item.name) + "</strong><small>" + escapeHtml(item.path) + "</small>";
        btn.addEventListener("click", () => {
          els.cwd.value = item.path;
          hidePathSuggestions();
        });
        els.cwdSuggestions.appendChild(btn);
      });
      els.cwdSuggestions.classList.remove("hidden");
    }

    function hidePathSuggestions() {
      els.cwdSuggestions.classList.add("hidden");
      els.cwdSuggestions.innerHTML = "";
    }

    function applyPreset() {
      if (!state.config || els.presetSelect.value === "") return;
      const preset = state.config.commandPresets[Number(els.presetSelect.value)];
      if (!preset) return;
      els.command.value = preset.command;
      els.mode.value = preset.mode || state.config.defaultMode || "default";
    }

    async function runCommand() {
      hideError(els.actionError);
      const command = els.command.value.trim();
      if (!command) {
        showError(els.actionError, "Command is required.");
        return;
      }

      const res = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          cwd: els.cwd.value.trim(),
          mode: els.mode.value
        })
      });
      const data = await res.json();

      if (!res.ok) {
        showError(els.actionError, data.error || "Command failed to start.");
        return;
      }

      state.selectedId = data.id;
      state.drafts[data.id] = "";
      syncInputBox();
      closeSessionModal();
      await refreshAll();
      focusInputBox();
    }

    function openSessionModal() {
      els.sessionModal.classList.remove("hidden");
      schedulePathSuggestions();
      setTimeout(() => els.command.focus(), 20);
    }

    function closeSessionModal() {
      els.sessionModal.classList.add("hidden");
      hidePathSuggestions();
    }

    async function refreshAll() {
      await loadSessions();
      if (state.selectedId) await loadOutput(state.selectedId);
    }

    async function loadSessions() {
      const res = await fetch("/api/sessions");
      if (res.status === 401) {
        await logout();
        return;
      }

      const data = await res.json();
      state.sessions = data;
      els.sessionCount.textContent = String(data.length);

      if (!data.length) {
        els.sessionsList.innerHTML = '<div class="empty-state">No sessions yet</div>';
        if (state.selectedId) state.selectedId = null;
        return;
      }

      if (!state.selectedId || !data.some((s) => s.id === state.selectedId)) {
        state.selectedId = data[0].id;
      }

      els.sessionsList.innerHTML = "";
      data.forEach((session) => {
        const btn = document.createElement("button");
        btn.className = "session-item" + (session.id === state.selectedId ? " active" : "");
        btn.innerHTML =
          '<div class="session-command">' + escapeHtml(session.command) + '</div>' +
          '<div class="session-meta">' +
            '<span class="session-meta-item">' + escapeHtml(session.mode) + '</span>' +
            '<span class="session-status ' + session.status + '">' + escapeHtml(session.status) + '</span>' +
          '</div>';
        btn.addEventListener("click", async () => {
          state.selectedId = session.id;
          renderSessionList();
          await loadOutput(session.id);
          syncInputBox();
          focusInputBox();
        });
        els.sessionsList.appendChild(btn);
      });

      syncInputBox();
    }

    function renderSessionList() {
      Array.from(els.sessionsList.children).forEach((child, i) => {
        const session = state.sessions[i];
        if (session) {
          child.className = "session-item" + (session.id === state.selectedId ? " active" : "");
        }
      });
    }

    async function loadOutput(id) {
      const res = await fetch("/api/sessions/" + id);
      if (!res.ok) {
        renderTerminal("Unable to load session output.", null);
        return;
      }

      const data = await res.json();
      els.terminalTitle.textContent = shortCommand(data.command);
      els.sessionMeta.textContent = data.cwd + "  |  " + data.mode + "  |  " + data.status + "  |  exit=" + (data.exitCode ?? "n/a");
      renderTerminal(data.output || "[no output yet]", data.id);
      scheduleTerminalResize();
    }

    async function sendInputFromBox(appendEnter) {
      const value = getDraftValue();
      if (!value && !appendEnter) {
        showError(els.actionError, "Input is empty.");
        return;
      }
      if (value) {
        await queueDirectInput(value);
      }
      if (appendEnter || value) {
        await queueDirectInput("\\r");
      }
      setDraftValue("");
    }

    async function sendDirectInput(input) {
      return queueDirectInput(input);
    }

    async function queueDirectInput(input) {
      if (!input) {
        return;
      }

      state.inputQueue = state.inputQueue.then(() => postInput(input));
      return state.inputQueue;
    }

    async function postInput(input) {
      hideError(els.actionError);
      if (!state.selectedId) {
        showError(els.actionError, "No session selected.");
        return;
      }

      const res = await fetch("/api/sessions/" + state.selectedId + "/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input })
      });
      const data = await res.json();

      if (!res.ok) {
        showError(els.actionError, data.error || "Failed to send input.");
        return;
      }
    }

    async function stopSession() {
      hideError(els.actionError);
      if (!state.selectedId) {
        showError(els.actionError, "No session selected.");
        return;
      }

      const res = await fetch("/api/sessions/" + state.selectedId + "/stop", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        showError(els.actionError, data.error || "Failed to stop session.");
        return;
      }

      await refreshAll();
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
      const s = String(cmd || "").trim();
      return s.length <= 28 ? s || "Terminal" : s.slice(0, 25) + "...";
    }

    function renderTerminal(value, sessionId) {
      if (!state.terminal) return;

      const output = normalizeTerminalOutput(String(value || ""));
      if (state.terminalSessionId !== sessionId || !output.startsWith(state.terminalOutput)) {
        state.terminal.reset();
        state.terminal.write(output);
      } else {
        state.terminal.write(output.slice(state.terminalOutput.length));
      }

      state.terminalSessionId = sessionId;
      state.terminalOutput = output;
      state.terminal.scrollToBottom();
    }

    function handleInputBoxKeydown(event) {
      if (event.isComposing) return;

      if (event.key === "Enter") {
        if (event.shiftKey) {
          event.preventDefault();
          queueDraftInput("\n");
          return;
        }
        event.preventDefault();
        queueDirectInput("\\r");
        setDraftValue("");
        return;
      }

      if (event.key === "Backspace") {
        if (!getDraftValue()) return;
        event.preventDefault();
        queueDirectInput("\\u007f");
        setDraftValue(getDraftValue().slice(0, -1));
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        queueDraftInput("\\t");
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        queueDirectInput("\\u001b");
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        queueDirectInput("\\u0003");
        setDraftValue("");
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        queueDirectInput("\\u0004");
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        queueDirectInput("\\u000c");
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        queueDirectInput("\\u001b[A");
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        queueDirectInput("\\u001b[B");
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        queueDirectInput("\\u001b[C");
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        queueDirectInput("\\u001b[D");
        return;
      }

      if (event.key.length === 1) {
        event.preventDefault();
        queueDraftInput(event.key);
      }
    }

    function handleInputPaste(event) {
      const pasted = event.clipboardData ? event.clipboardData.getData("text") : "";
      if (!pasted) return;
      event.preventDefault();
      queueDraftInput(pasted);
    }

    function queueDraftInput(text) {
      queueDirectInput(text);
      setDraftValue(getDraftValue() + text);
    }

    function getDraftValue() {
      if (!state.selectedId) {
        return "";
      }
      return state.drafts[state.selectedId] || "";
    }

    function setDraftValue(value) {
      if (!state.selectedId) {
        setInputBoxValue("");
        return;
      }

      state.drafts[state.selectedId] = value;
      setInputBoxValue(value);
    }

    function syncInputBox() {
      setInputBoxValue(getDraftValue());
    }

    function setInputBoxValue(value) {
      state.isSyncingInputBox = true;
      els.inputBox.value = value;
      state.isSyncingInputBox = false;
    }

    function focusInputBox() {
      if (!state.selectedId) return;
      if (document.activeElement === els.inputBox) return;
      els.inputBox.focus();
      const length = els.inputBox.value.length;
      els.inputBox.setSelectionRange(length, length);
    }

    function observeTerminalResize() {
      if (typeof ResizeObserver === "function") {
        state.resizeObserver = new ResizeObserver(() => scheduleTerminalResize());
        state.resizeObserver.observe(els.output);
      }
      window.addEventListener("resize", scheduleTerminalResize);
      requestAnimationFrame(scheduleTerminalResize);
    }

    function scheduleTerminalResize() {
      if (state.resizeTimer) clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(syncTerminalSize, 60);
    }

    async function syncTerminalSize() {
      if (!state.terminal || !els.output) return;

      const nextSize = measureTerminalSize(els.output);
      if (!nextSize) return;

      if (state.terminal.cols !== nextSize.cols || state.terminal.rows !== nextSize.rows) {
        state.terminal.resize(nextSize.cols, nextSize.rows);
      }

      if (!state.selectedId) return;

      try {
        await fetch("/api/sessions/" + state.selectedId + "/resize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextSize)
        });
      } catch {}
    }

    function measureTerminalSize(container) {
      const style = window.getComputedStyle(container);
      const paddingX = parseFloat(style.paddingLeft || "0") + parseFloat(style.paddingRight || "0");
      const paddingY = parseFloat(style.paddingTop || "0") + parseFloat(style.paddingBottom || "0");
      const width = container.clientWidth - paddingX;
      const height = container.clientHeight - paddingY;
      if (width <= 0 || height <= 0) return null;

      const fontSize = 13;
      const lineHeight = fontSize * 1.4;
      const cellWidth = fontSize * 0.62;
      return {
        cols: Math.max(20, Math.floor(width / cellWidth)),
        rows: Math.max(10, Math.floor(height / lineHeight))
      };
    }

    function normalizeTerminalOutput(value) {
      return value.replace(/\r?\n/g, "\r\n");
    }

    function showError(el, msg) {
      el.textContent = msg;
      el.classList.remove("hidden");
    }

    function hideError(el) {
      el.textContent = "";
      el.classList.add("hidden");
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
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
