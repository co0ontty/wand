import assert from "node:assert/strict";
import test from "node:test";
import { openTaskSessionCreation } from "../src/web-ui/react/issues/task-session-create.js";
import type { WorkspaceTaskDetail } from "../src/web-ui/react/workspaces/types.js";
import type { NewSessionOpenOptions } from "../src/web-ui/react/new-session/controller.js";

const owner: WorkspaceTaskDetail = { id: "container", name: "任务容器", workspaceId: "project", cwd: "/repo/.worktrees/feature",
  isolated: true, worktree: null, createdAt: "", lastOpenedAt: null, status: "active", layout: null, sessions: [] };
const task = { status: "doing" as const, workspaceTaskId: "container" };

test("task context creation uses the standard dialog with authoritative worktree cwd and container binding", async () => {
  const opened: NewSessionOpenOptions[] = [];
  const result = await openTaskSessionCreation(task, { getTask: async id => { assert.equal(id, owner.id); return owner; },
    getCreationState: () => ({ open: false, revision: 3 }), open: input => { opened.push(input); return true; } });
  assert.equal(result, true);
  assert.deepEqual(opened, [{ initialCwd: owner.cwd, workspaceId: "project", workspaceTaskId: "container", taskName: "任务容器" }]);
  assert.equal("seedPrompt" in opened[0], false, "opening the creation flow must not silently dispatch the task description");
});

test("archived or missing containers cannot start a session, without a read or model execution", async () => {
  let reads = 0;
  for (const input of [{ status: "archived" as const, workspaceTaskId: "container" }, { status: "todo" as const, workspaceTaskId: null }]) {
    await assert.rejects(openTaskSessionCreation(input, { getTask: async () => { reads++; return owner; } }), /恢复任务/);
  }
  assert.equal(reads, 0);
});

test("existing creation drafts are never overwritten", async () => {
  let reads = 0;
  assert.equal(await openTaskSessionCreation(task, { getCreationState: () => ({ open: true, revision: 2 }),
    getTask: async () => { reads++; return owner; } }), false);
  assert.equal(reads, 0);
});

test("late container reads cannot reopen a canceled or superseded creation flow", async () => {
  let resolve!: (value: WorkspaceTaskDetail) => void;
  const pending = new Promise<WorkspaceTaskDetail>(done => { resolve = done; });
  let revision = 1, opens = 0;
  const result = openTaskSessionCreation(task, { getTask: () => pending, getCreationState: () => ({ open: false, revision }),
    open: () => { opens++; return true; } });
  revision++; resolve(owner);
  assert.equal(await result, false); assert.equal(opens, 0);
});

test("closing the task board or archiving its container prevents a delayed creation", async () => {
  assert.equal(await openTaskSessionCreation(task, { getTask: async () => owner, getCreationState: () => ({ open: false, revision: 0 }),
    canContinue: () => false, open: () => { throw new Error("must_not_open"); } }), false);
  await assert.rejects(openTaskSessionCreation(task, { getTask: async () => ({ ...owner, archived: true }),
    getCreationState: () => ({ open: false, revision: 0 }) }), /容器已变化/);
});

test("missing standard runtime produces an explicit error instead of inventing another creation flow", async () => {
  await assert.rejects(openTaskSessionCreation(task, { getTask: async () => owner,
    getCreationState: () => ({ open: false, revision: 0 }), open: () => false }), /环境尚未就绪/);
});
