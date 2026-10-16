import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { webSessionRequestAllowed, filterWebSessionList } from "../src/web-session-access.js";
import { principalHasScope } from "../src/auth.js";
import { WsBroadcastManager } from "../src/ws-broadcast.js";
import type { AuthPrincipal } from "../src/storage.js";

const principal: AuthPrincipal = { kind: "connected-app", scopes: ["sessions"], webSession: { sessionId: "own-session", employeeId: "own-employee" } };
test("scoped Web login is exact-session read-only and default-denies all unrelated capabilities", () => {
  for (const route of ["/api/config", "/api/sessions", "/api/session-list", "/api/sessions/own-session", "/api/sessions/own-session/messages", "/api/sessions/own-session/tool-content/tool-one", "/api/structured-sessions/own-session/messages"]) {
    assert.equal(webSessionRequestAllowed(principal, "GET", route), true, route);
    assert.equal(webSessionRequestAllowed(principal, "POST", route), false, route);
  }
  for (const route of ["/api/sessions/other", "/api/sessions/other/messages", "/api/sessions/own-session/input", "/api/sessions/own-session/pi-execution/tool", "/api/sessions/own-session/git-status", "/api/silicon-employees", "/api/user-memory", "/api/workspaces", "/api/settings", "/api/wand-tasks", "/api/unknown-future-route", "/api/sessions/own-session%2Fother"]) {
    assert.equal(webSessionRequestAllowed(principal, "GET", route), false, route);
  }
  assert.deepEqual(filterWebSessionList(principal, [{ id: "own-session", employeeId: "own-employee" }, { id: "same-employee-other-session", employeeId: "own-employee" }, { id: "other-session", employeeId: "other-employee" }]), [{ id: "own-session", employeeId: "own-employee" }]);
  assert.equal(principalHasScope({ ...principal, kind: "browser-admin", scopes: ["admin", "sessions"] }, "admin"), false);
});

test("scoped Web cookies cannot join the workbench-wide WebSocket notification channel", async t => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const manager = new WsBroadcastManager(wss, () => ({}), false, { validateSession: () => true, authenticateSession: () => principal });
  manager.setup(() => null);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(() => { manager.dispose(); wss.close(); server.close(); });
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { cookie: "wand_session_local=synthetic-scoped-cookie" } });
  let frames = 0; ws.on("message", () => frames++);
  const [code] = await once(ws, "close");
  assert.equal(code, 1008); assert.equal(frames, 0);
});
