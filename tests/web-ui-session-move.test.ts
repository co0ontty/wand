import assert from "node:assert/strict";
import test from "node:test";
import { HttpWorkspacesRepository } from "../src/web-ui/react/workspaces/repository.js";
import { subscribeTaskChanges } from "../src/web-ui/react/task-changes.js";
import { draggedSessionId, isSessionDrag, SESSION_DRAG_TYPE, startSessionDrag } from "../src/web-ui/react/workspaces/session-drag.js";

test("session drags cannot be confused with task-card or text drags", () => {
  const data = new Map<string, string>();
  const transfer = {
    effectAllowed: "none",
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? "",
    get types() { return [...data.keys()]; },
  } as DataTransfer;
  transfer.setData("application/x-wand-task", "task-id");
  assert.equal(isSessionDrag(transfer), false);
  assert.equal(draggedSessionId(transfer), "");
  startSessionDrag(transfer, "session-id");
  assert.equal(isSessionDrag(transfer), true);
  assert.equal(draggedSessionId(transfer), "session-id");
  assert.equal(transfer.effectAllowed, "move");
  assert.equal(data.get(SESSION_DRAG_TYPE), "session-id");
});

test("moving a session invalidates both task views only after the server accepts it", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  let changes = 0;
  let failed = false;
  const unsubscribe = subscribeTaskChanges(() => { changes++; });
  try {
    const repository = new HttpWorkspacesRepository(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(failed ? { error: "任务已删除" } : { ok: true }), { status: failed ? 404 : 200 });
    });
    await repository.moveSession("task/a", "session-b");
    assert.deepEqual(requests[0], { url: "/api/workspace-tasks/task%2Fa/sessions", body: { sessionId: "session-b" } });
    assert.equal(changes, 1);
    failed = true;
    await assert.rejects(repository.moveSession("gone", "session-b"), /任务已删除/);
    assert.equal(changes, 1);
  } finally { unsubscribe(); }
});
