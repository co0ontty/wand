import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("mobile sidebar drawer swipe-to-open gesture with velocity, acceleration, and real-time tracking", async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-sidebar-gesture-"));

  const fixtureSource = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ShellApp } from "./src/web-ui/react/shell/shell-app";
import { MemoryUiAdapter } from "./src/web-ui/react/shell/ui-store";
import { WandUiProvider } from "./src/web-ui/react/theme";
import { installReactUiStyles } from "./src/web-ui/react/styles";
import { configureQuickTerminalRuntime } from "./src/web-ui/react/quick-terminal/runtime";

installReactUiStyles();
configureQuickTerminalRuntime({
  mount: () => true,
  dispose: () => {},
  retain: () => {},
  focus: () => {},
  reconnect: () => {},
  observe: () => () => {},
});

const mobile = true;
const session = {
  id: "s1",
  source: "wand",
  provider: "codex",
  kind: "structured",
  title: "手势会话",
  description: "移动端手势测试",
  cwd: "/workspace/wand",
  status: "idle",
  statusLabel: "空闲",
  active: true,
  selected: false,
  resumable: true,
  permissionBlocked: false,
  inFlight: false,
  turnActive: false,
  titleGenerating: false,
  startedAt: "2026-07-16T08:00:00Z",
  workspaceId: "ws",
  workspaceTaskId: "t1"
};

let snapshot = {
  auth: { phase: "authenticated" },
  viewport: { mobile: true, online: true, embedTerminal: false, nativeInput: false },
  capabilities: { backToNative: false, switchServer: false },
  layout: {
    sessionsDrawerOpen: false,
    sidebarPinned: false,
    sidebarCollapsed: false,
    sidebarDrawer: true,
    sidebarAnchored: false,
    sessionsBackdropVisible: false,
    filePanelOpen: false,
    filePanelBackdropVisible: false,
    topbarMoreOpen: false,
    currentView: "chat"
  },
  selected: session,
  sidebar: {
    interactiveCount: 1,
    totalCount: 1,
    manageMode: false,
    selectedCount: 0,
    groups: [{ kind: "wand", label: "Wand 会话", expanded: true, entries: [session] }]
  },
  topbar: {
    title: session.title,
    description: session.description,
    statusLabel: "空闲",
    statusTone: "idle",
    cwd: session.cwd,
    currentTask: "",
    titleGenerating: false,
    git: null
  },
  legacyVisibility: { terminal: false, chat: true, blank: false, composer: true }
};

const memory = new MemoryUiAdapter(snapshot);

window.sidebar = {
  memory,
  update: (layout) => {
    snapshot = {
      ...snapshot,
      layout: {
        ...snapshot.layout,
        ...layout,
        sessionsBackdropVisible: layout.sessionsDrawerOpen ?? snapshot.layout.sessionsDrawerOpen
      }
    };
    memory.setSnapshot(snapshot, { sync: true });
  }
};

const store = {
  getSnapshot: () => memory.getSnapshot(),
  subscribe: (cb) => memory.subscribe(cb),
  dispatch: (action) => {
    memory.dispatch(action);
    if (action.type === "layout.drawer.close") window.sidebar.update({ sessionsDrawerOpen: false });
    if (action.type === "layout.drawer.open") window.sidebar.update({ sessionsDrawerOpen: true });
    if (action.type === "layout.drawer.toggle") window.sidebar.update({ sessionsDrawerOpen: !snapshot.layout.sessionsDrawerOpen });
  }
};

function Fixture() {
  return (
    <WandUiProvider>
      <ShellApp store={store}/>
    </WandUiProvider>
  );
}

createRoot(document.getElementById("root")).render(<Fixture/>);
`;

  await build({
    stdin: { contents: fixtureSource, resolveDir: root, loader: "tsx" },
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: join(temporary, "app.js"),
    define: { "process.env.NODE_ENV": '"production"' },
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({}));
      return;
    }
    if (url.pathname === "/app.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(readFileSync(join(temporary, "app.js")));
      return;
    }
    if (url.pathname === "/styles.css") {
      res.setHeader("content-type", "text/css");
      res.end(readFileSync(join(root, "src/web-ui/content/styles.css")));
      return;
    }
    if (url.pathname === "/tailwind.css") {
      res.setHeader("content-type", "text/css");
      res.end(readFileSync(join(root, "src/web-ui/content/tailwind.css")));
      return;
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <link rel="stylesheet" href="/tailwind.css">
  <link rel="stylesheet" href="/styles.css">
  <script>window.__wandErrors=[];window.onerror=(m,u,l,c,e)=>{window.__wandErrors.push(String(e?.stack||m))};</script>
  <style>
    html, body { margin:0; padding:0; height:100%; overflow:hidden; touch-action:manipulation; }
    #app { height:100%; }
  </style>
</head>
<body>
  <div id="app" data-react-shell="enabled"><div id="root"></div></div>
  <script src="/app.js"></script>
</body>
</html>`);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  let browser;
  try {
    browser = await openBrowser(origin, 390, 844);
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await browser.wait("!!document.querySelector('#sessions-drawer')", "Sidebar drawer mounted");

    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // 1. Initial state: drawer starts closed in mobile layout
    const initialOpen = await browser.evaluate("document.querySelector('#sessions-drawer')?.classList.contains('open')");
    assert.equal(initialOpen, false, "Drawer starts closed in mobile layout");

    // 2. Perform edge swipe right starting from x=30 (within generous edge zone: >=56px)
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 30, y: 300, id: 1 }],
    });

    // TouchMove slowly to overcome slop (dx=15px)
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 45, y: 301, id: 1 }],
    });
    await pause(30);

    // TouchMove further right (dx=120px)
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 150, y: 302, id: 1 }],
    });
    await pause(30);

    // Verify drawer is tracking in real-time with inline transform and gesture dataset
    const trackingState = await browser.evaluate(`(() => {
      const drawer = document.querySelector('#sessions-drawer');
      const backdrop = document.querySelector('#sessions-drawer-backdrop');
      return {
        drawerDisplay: drawer?.style.display,
        drawerTransform: drawer?.style.transform,
        gestureActive: drawer?.dataset.drawerGesture,
        backdropDisplay: backdrop?.style.display,
        backdropOpacity: backdrop?.style.opacity,
      };
    })()`);

    assert.equal(trackingState.drawerDisplay, "flex", "Drawer made visible during drag");
    assert.ok(trackingState.drawerTransform.includes("translate3d"), "Drawer follows finger displacement");
    assert.equal(trackingState.gestureActive, "active", "Drawer marked with active gesture");
    assert.equal(trackingState.backdropDisplay, "block", "Backdrop visible during drag");
    assert.ok(parseFloat(trackingState.backdropOpacity) > 0, "Backdrop opacity tracks progress");

    // TouchMove with acceleration (fling to x=220) and end
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 220, y: 302, id: 1 }],
    });
    await pause(20);

    await browser.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    // Wait for spring release animation to complete and commit open state
    await browser.wait("document.querySelector('#sessions-drawer')?.classList.contains('open')", "Drawer opened by fling gesture");
    const committedOpen = await browser.evaluate("document.querySelector('#sessions-drawer')?.classList.contains('open')");
    assert.equal(committedOpen, true, "Drawer committed to open state");

    // 3. Test closing swipe left when drawer is open
    await pause(100);
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 200, y: 300, id: 2 }],
    });
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 170, y: 301, id: 2 }],
    });
    await pause(30);

    await browser.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 50, y: 301, id: 2 }],
    });
    await pause(20);

    await browser.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    // Wait for closing transition to complete
    await browser.wait("!document.querySelector('#sessions-drawer')?.classList.contains('open')", "Drawer closed by swipe left");
    const committedClosed = await browser.evaluate("document.querySelector('#sessions-drawer')?.classList.contains('open')");
    assert.equal(committedClosed, false, "Drawer committed to closed state");

    // 4. Test vertical swipe non-interference: vertical scroll must not trigger drawer
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 30, y: 300, id: 3 }],
    });
    // Move vertically downwards (dy=60, dx=5)
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 35, y: 360, id: 3 }],
    });
    await pause(30);
    await browser.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    const stillClosed = await browser.evaluate("document.querySelector('#sessions-drawer')?.classList.contains('open')");
    assert.equal(stillClosed, false, "Vertical gesture did not trigger drawer");

  } finally {
    if (browser) await browser.close();
    server.close();
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
});
