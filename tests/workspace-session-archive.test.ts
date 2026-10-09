import assert from "node:assert/strict";
import test from "node:test";
import { archivedSessionCount, groupSessionsByArchive } from "../src/web-ui/react/workspaces/session-archive.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

test("archive projection counts each session once and repeated normalization is stable", () => {
  const source = [{ workspaceId: "w", workspaceName: "项目", workspaceCwd: "/project", tasks: [
    { id: "t", sessions: [{ id: "a" }, { id: "b", archived: true }, { id: "b", archived: true }], archivedSessions: [{ id: "b", archived: true }, { id: "c", archived: true }, { id: "c", archived: true }] },
  ], standaloneSessions: [{ id: "d" }, { id: "e", archived: true }], archivedSessions: [{ id: "e", archived: true }] }] as TaskDirectoryGroup[];
  const [group] = groupSessionsByArchive(source);
  assert.deepEqual(group.tasks[0].sessions.map(session => session.id), ["a"]);
  assert.deepEqual(group.tasks[0].archivedSessions?.map(session => session.id), ["b", "c"]);
  assert.deepEqual(group.archivedSessions?.map(session => session.id), ["e"]);
  assert.equal(archivedSessionCount(group), 3);
  assert.deepEqual(groupSessionsByArchive([group]), [group]);
  assert.equal(source[0].tasks[0].sessions.length, 3, "normalization leaves the server response untouched");
});

test("fresh restored sessions override stale archive entries without being counted twice", () => {
  const source = [{ workspaceId: "w", workspaceName: "项目", workspaceCwd: "/project", tasks: [
    { id: "t", sessions: [{ id: "restored", title: "新名称", archived: false }], archivedSessions: [{ id: "restored", title: "旧名称", archived: true }] },
  ], standaloneSessions: [{ id: "loose", archived: false }], archivedSessions: [{ id: "loose", archived: true }] }] as TaskDirectoryGroup[];
  const [group] = groupSessionsByArchive(source);
  assert.equal(group.tasks[0].sessions[0].title, "新名称");
  assert.equal(group.standaloneSessions.length, 1);
  assert.equal(archivedSessionCount(group), 0);
});
