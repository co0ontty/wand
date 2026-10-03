// Development-only component harness: the real WorkspacesPanel with archived
// sessions in a headless Chrome. Not an installed-service acceptance test.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { WorkspacesPanel } from "../../src/web-ui/react/workspaces/workspaces-panel";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles";

installReactUiStyles();
installStyleSheet("harness-archive-styles", aiTeamsChunkStyles);

interface HarnessState {
  calls: Array<{ method: string; url: string; body: unknown }>;
}

const state: HarnessState = { calls: [] };
(window as unknown as { sessionArchiveHarness: HarnessState }).sessionArchiveHarness = state;

const session = (id: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: id,
  provider: "codex",
  sessionKind: "structured",
  status: "idle",
  cwd: "/work/wand",
  startedAt: "2026-10-02T00:00:00.000Z",
  ...patch,
});

const groups = [{
  workspaceId: "workspace-1",
  workspaceName: "Wand",
  workspaceCwd: "/work/wand",
  tasks: [{
    id: "task-1",
    workspaceId: "workspace-1",
    name: "会话归档功能",
    cwd: "/work/wand",
    status: "active",
    worktree: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastOpenedAt: "2026-10-02T00:00:00.000Z",
    layout: null,
    sessions: [session("s-active", { title: "活跃会话" }), session("s-arch", { title: "已归档会话", archived: true })],
    totalSessions: 2,
  }],
  standaloneSessions: [session("s-loose-active", { title: "未分组活跃" }), session("s-loose-arch", { title: "未分组归档", archived: true })],
}];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.includes("/api/tasks")) return json({ unchanged: false, revision: "rev-1", groups });
  if (url.includes("/api/silicon-employees")) return json({ employees: [] });
  if (url.includes("/api/ai-teams")) return json([]);
  if (url.includes("/api/sessions/batch-archive")) {
    state.calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return json({ ok: true, archived: 1 });
  }
  if (/\/api\/sessions\/[^/]+\/(unarchive|archive)$/.test(url)) {
    state.calls.push({ method, url, body: null });
    return json({ ok: true });
  }
  if (url.startsWith("/api/")) return json([]);
  return json({});
};

createRoot(document.getElementById("root")!).render(
  <div className="wand-shell sidebar-host" style={{ width: 320 }}>
    <WorkspacesPanel/>
  </div>,
);
