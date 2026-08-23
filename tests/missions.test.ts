import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { defaultConfig } from "../src/config.js";
import { prepareSessionWorktree } from "../src/git-worktree.js";
import { buildMissionDiff } from "../src/mission-diff.js";
import { Missions } from "../src/missions.js";
import type { Mission, MissionAttempt, MissionReviewComment } from "../src/mission-types.js";
import { WandStorage } from "../src/storage.js";
import { startServer } from "../src/server.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  }).trim();
}

function repo(t: TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-missions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Wand Test");
  git(root, "config", "user.email", "wand@example.com");
  writeFileSync(path.join(root, ".gitignore"), "shared-cache/\n.env.local\n");
  writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", ".gitignore", "tracked.txt");
  git(root, "commit", "-m", "initial");
  return root;
}

test("mission persistence keeps attempts and review lifecycle together", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-mission-db-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const mission: Mission = {
    id: "mission-1", title: "Parallel fix", prompt: "Fix it", cwd: root,
    status: "running", taskId: null, worktree: { baseRef: "main", sharedDirectories: ["shared-cache"], copyPaths: [] },
    createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:01.000Z",
  };
  const attempt: MissionAttempt = {
    id: "attempt-1", missionId: mission.id, sessionId: "session-1", provider: "codex",
    state: "working", branch: "wand/fix", worktreePath: "/tmp/fix", baseRef: "main",
    summary: null, error: null, createdAt: mission.createdAt, updatedAt: mission.updatedAt,
  };
  const comment: MissionReviewComment = {
    id: "comment-1", missionId: mission.id, attemptId: attempt.id, filePath: "src/a.ts",
    line: 12, side: "new", body: "Keep this branch explicit", status: "pending",
    createdAt: mission.createdAt, sentAt: null, resolvedAt: null,
  };
  storage.saveMission(mission);
  storage.saveMissionAttempt(attempt);
  storage.saveMissionReviewComment(comment);
  storage.upsertAgentActivity({
    sessionId: "session-1", missionId: mission.id, attemptId: attempt.id, state: "needs_input",
    title: mission.title, summary: "Choose an approach", provider: "codex", cwd: root,
    updatedAt: mission.updatedAt, readAt: null,
  });

  assert.deepEqual(storage.getMission(mission.id), mission);
  assert.deepEqual(storage.listMissionAttempts(mission.id), [attempt]);
  assert.deepEqual(storage.listMissionReviewComments(mission.id), [comment]);
  assert.equal(storage.listAgentActivity()[0]?.state, "needs_input");

  storage.updateMissionReviewStatus([comment.id], "sent", "2026-08-05T00:00:02.000Z");
  storage.markAgentActivityRead("session-1");
  assert.equal(storage.listMissionReviewComments(mission.id)[0]?.status, "sent");
  assert.ok(storage.listAgentActivity()[0]?.readAt);
  storage.close();
});

test("mission diff includes committed/working changes and untracked files", (t) => {
  const root = repo(t);
  const baseRef = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "tracked.txt"), "changed\n");
  writeFileSync(path.join(root, "new-file.txt"), "new\n");
  const diff = buildMissionDiff({ missionId: "m", attemptId: "a", cwd: root, baseRef });
  assert.deepEqual(diff.files.map((file) => file.path).sort(), ["new-file.txt", "tracked.txt"]);
  assert.match(diff.patch, /-base/);
  assert.match(diff.patch, /\+changed/);
  assert.match(diff.patch, /new-file\.txt/);
  assert.equal(diff.truncated, false);
});

test("task worktree honors a base ref and safely hydrates ignored copy/share paths", (t) => {
  const root = repo(t);
  mkdirSync(path.join(root, "shared-cache"));
  writeFileSync(path.join(root, "shared-cache", "cache.txt"), "shared\n");
  writeFileSync(path.join(root, ".env.local"), "TOKEN=test\n");
  const baseCommit = git(root, "rev-parse", "HEAD");

  const prepared = prepareSessionWorktree({
    cwd: root,
    sessionId: "mission-attempt-1234",
    spec: {
      baseRef: "HEAD",
      taskName: "Review API",
      sharedDirectories: ["shared-cache"],
      copyPaths: [".env.local"],
    },
  });

  assert.equal(prepared.worktree.baseRef, baseCommit);
  assert.equal(git(prepared.cwd, "rev-parse", "HEAD"), baseCommit);
  assert.equal(lstatSync(path.join(prepared.cwd, "shared-cache")).isSymbolicLink(), true);
  assert.equal(readFileSync(path.join(prepared.cwd, "shared-cache", "cache.txt"), "utf8"), "shared\n");
  assert.equal(lstatSync(path.join(prepared.cwd, ".env.local")).isSymbolicLink(), false);
  assert.equal(readFileSync(path.join(prepared.cwd, ".env.local"), "utf8"), "TOKEN=test\n");
});

test("mission HTTP routes expose tasks and validate dispatch before spawning", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-mission-http-"));
  const previousTestMode = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "mission-test-password",
    startupCommands: [],
  }, path.join(root, "config.json"));
  t.after(async () => {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    if (previousTestMode === undefined) delete process.env.WAND_TEST_MODE;
    else process.env.WAND_TEST_MODE = previousTestMode;
  });

  const login = await fetch(`${handle.urls[0]!.url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "mission-test-password" }),
  });
  const cookie = login.headers.get("set-cookie")?.match(/wand_session_local=[^;]+/)?.[0];
  assert.ok(cookie);
  const headers = { Cookie: cookie, "Content-Type": "application/json" };

  const inbox = await fetch(`${handle.urls[0]!.url}/api/inbox`, { headers });
  assert.equal(inbox.status, 200);
  assert.deepEqual(await inbox.json(), { items: [] });
  const missions = await fetch(`${handle.urls[0]!.url}/api/missions`, { headers });
  assert.equal(missions.status, 200);
  assert.deepEqual(await missions.json(), { missions: [] });

  const invalid = await fetch(`${handle.urls[0]!.url}/api/missions`, {
    method: "POST", headers,
    body: JSON.stringify({ prompt: "test", cwd: path.join(root, "missing"), providers: ["claude"] }),
  });
  assert.equal(invalid.status, 400);
  assert.match(JSON.stringify(await invalid.json()), /工作目录不存在/);
});

test("missions linked to a task bind dispatched sessions to it", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-mission-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(root, "wand.db"));

  const created: Array<Record<string, unknown>> = [];
  const structuredStub = {
    createSession(input: Record<string, unknown>) {
      created.push(input);
      return { id: `sess-${created.length}`, worktree: null };
    },
    sendMessage(): Promise<void> {
      return Promise.resolve();
    },
    get(): null {
      return null;
    },
  } as unknown as ConstructorParameters<typeof Missions>[1];
  const missions = new Missions(storage, structuredStub, {} as ConstructorParameters<typeof Missions>[2]);

  // 关联任务：attempt 会话绑定 workspaceTaskId，且不再叠加隔离 worktree。
  const linked = missions.create({
    prompt: "并行修",
    cwd: root,
    providers: ["codex"],
    taskId: "task-1",
  });
  assert.equal(linked.taskId, "task-1");
  assert.ok(created.length >= 1);
  assert.equal(created[0].workspaceTaskId, "task-1");
  assert.equal(created[0].worktreeEnabled, false);

  // 未关联任务：保持旧行为（独立 worktree、无 workspaceTaskId）。
  missions.create({ prompt: "并行修二", cwd: root, providers: ["codex"] });
  assert.equal(created[1].worktreeEnabled, true);
  assert.ok(!("workspaceTaskId" in created[1]));
});
