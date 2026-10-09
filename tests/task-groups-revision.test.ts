import assert from "node:assert/strict";
import test from "node:test";
import { HttpWorkspacesRepository } from "../src/web-ui/react/workspaces/repository.js";
import { createTaskGroupsStore } from "../src/web-ui/react/workspaces/task-groups-store.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

const groups: TaskDirectoryGroup[] = [{ workspaceId: "project", workspaceName: "项目", workspaceCwd: "/project", tasks: [], standaloneSessions: [{ id: "session" }] }];
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const tick = async () => { for (let index = 0; index < 50; index++) await Promise.resolve(); };

test("repository opts into revision on bootstrap and encodes the returned opaque revision", async () => {
  const revision = "opaque+/=& 中文";
  const requests: string[] = [];
  const repository = new HttpWorkspacesRepository(async (input, init) => {
    const url = new URL(String(input), "http://fixture");
    requests.push(`${url.pathname}${url.search}`);
    assert.equal(init?.credentials, "same-origin");
    // The production endpoint only sends an envelope when revision is present.
    if (!url.searchParams.has("revision")) return response(groups);
    return response(url.searchParams.get("revision") === revision
      ? { groups: [], revision, unchanged: true }
      : { groups, revision, unchanged: false });
  });
  const initial = await repository.listTaskGroups();
  assert.equal(initial.revision, revision, "the first real repository read obtains a revision");
  assert.equal(initial.unchanged, false);
  assert.deepEqual(initial.groups, groups);
  assert.deepEqual(await repository.listTaskGroups(initial.revision), { groups: [], revision, unchanged: true });
  assert.deepEqual(requests, ["/api/tasks?revision=", `/api/tasks?revision=${encodeURIComponent(revision)}`]);
});

test("repository retains legacy bare-array compatibility after opting into revision", async () => {
  const requests: string[] = [];
  const repository = new HttpWorkspacesRepository(async input => { requests.push(String(input)); return response(groups); });
  assert.deepEqual(await repository.listTaskGroups(), { groups, unchanged: false });
  assert.deepEqual(await repository.listTaskGroups("old-revision"), { groups, unchanged: false });
  assert.deepEqual(requests, ["/api/tasks?revision=", "/api/tasks?revision=old-revision"]);
});

test("shared store bootstraps through the HTTP repository and preserves its cached directory on unchanged poll", async () => {
  const requests: string[] = [];
  const revision = "server-revision";
  const repository = new HttpWorkspacesRepository(async input => {
    const url = new URL(String(input), "http://fixture");
    requests.push(`${url.pathname}${url.search}`);
    if (!url.searchParams.has("revision")) return response(groups);
    return response({ groups: url.searchParams.get("revision") === revision ? [] : groups,
      revision, unchanged: url.searchParams.get("revision") === revision });
  });
  let poll!: () => void;
  let cleared = false;
  const store = createTaskGroupsStore(repository, {
    subscribeChanges: () => () => {},
    setInterval: listener => { poll = listener; return 1; },
    clearInterval: () => { cleared = true; },
  });
  const unsubscribe = store.subscribe(() => {});
  try {
    await tick();
    assert.equal(store.getSnapshot().loading, false);
    const cached = store.getSnapshot().groups;
    assert.equal(cached[0].standaloneSessions[0].id, "session");
    poll(); await tick();
    assert.equal(store.getSnapshot().groups, cached);
    assert.equal(store.getSnapshot().loading, false);
    assert.deepEqual(requests, ["/api/tasks?revision=", "/api/tasks?revision=server-revision"]);
  } finally { unsubscribe(); }
  assert.equal(cleared, true);
});
