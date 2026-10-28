import assert from "node:assert/strict";
import test from "node:test";

import { createQuerySnapshot } from "../src/web-ui/query-snapshot.ts";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
if (!previousWindow) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
}
const windowEvents = globalThis.window as EventTarget;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("query snapshot single-flights reads and releases failed refreshes for retry", async () => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  let calls = 0;
  const snapshot = createQuerySnapshot(() => {
    calls++;
    const next = deferred<string>();
    pending.push(next);
    return next.promise;
  });

  const first = snapshot.load();
  const shared = snapshot.load({ force: true });
  assert.equal(calls, 1, "force joins the in-flight read instead of opening another request");
  pending[0]!.resolve("first");
  assert.deepEqual(await Promise.all([first, shared]), ["first", "first"]);
  assert.equal(snapshot.peek(), "first");

  assert.equal(await snapshot.load(), "first");
  assert.equal(calls, 1, "a committed value serves later readers without IO");

  const failed = snapshot.load({ force: true });
  assert.equal(calls, 2);
  pending[1]!.reject(new Error("offline"));
  await assert.rejects(failed, /offline/);
  assert.equal(snapshot.peek(), "first", "a failed refresh keeps the last committed value");

  const retry = snapshot.load({ force: true });
  assert.equal(calls, 3, "a failure releases the in-flight slot");
  pending[2]!.resolve("second");
  assert.equal(await retry, "second");
});

test("query snapshot publishes and invalidations fence off older reads", async () => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  let calls = 0;
  const snapshot = createQuerySnapshot(() => {
    calls++;
    const next = deferred<string>();
    pending.push(next);
    return next.promise;
  });

  const late = snapshot.load();
  snapshot.publish("saved");
  pending[0]!.resolve("older");
  assert.equal(await late, "saved", "a caller that awaited an older read receives the newer publish");
  assert.equal(snapshot.peek(), "saved");

  const invalidated = snapshot.load({ force: true });
  assert.equal(calls, 2);
  snapshot.invalidate();
  pending[1]!.resolve("stale");
  assert.equal(await invalidated, "stale");
  assert.equal(snapshot.peek(), null, "a read that predates invalidation never commits");

  const fresh = snapshot.load();
  assert.equal(calls, 3, "the next reader owns a fresh request");
  pending[2]!.resolve("fresh");
  assert.equal(await fresh, "fresh");
});

test("config snapshot shares boot reads, merges settings saves and drops late reads", async () => {
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  globalThis.fetch = ((url: string) => {
    assert.equal(url, "/api/config");
    const next = deferred<Response>();
    pending.push(next);
    return next.promise;
  }) as typeof fetch;

  const config = await import("../src/web-ui/react/config-snapshot.ts");
  const profile = await import("../src/web-ui/react/user-profile-repository.ts");

  let applied: Record<string, unknown> | null = null;
  let active = true;
  const switchedAway = config.loadConfigSnapshot().then((value) => { if (active) applied = value; });
  const boot = config.loadConfigSnapshot();
  assert.equal(pending.length, 1, "boot, profile and home share one request");
  active = false;
  pending[0]!.resolve(Response.json({
    userProfile: { name: "初始", avatar: "plush:v1:round:cream:none:beanie" },
    defaultCwd: "/repo",
  }));
  await Promise.all([switchedAway, boot]);
  assert.equal(applied, null, "a page that switched away ignores the late value");
  assert.equal(config.peekConfigSnapshot()?.defaultCwd, "/repo");
  assert.equal(profile.userProfileStore.getSnapshot().name, "初始");

  assert.equal((await config.loadConfigSnapshot()).defaultCwd, "/repo");
  assert.equal(pending.length, 1, "the committed snapshot serves later owners without IO");

  windowEvents.dispatchEvent(new CustomEvent("wand-settings-config-saved", {
    detail: { userProfile: { name: "新资料", avatar: "cat:1" } },
  }));
  assert.equal(config.peekConfigSnapshot()?.defaultCwd, "/repo", "partial saves keep unrelated fields");
  assert.equal(profile.userProfileStore.getSnapshot().name, "新资料");
  assert.equal(pending.length, 1, "a settings save publishes locally instead of re-reading");

  config.invalidateConfigSnapshot();
  const late = config.loadConfigSnapshot();
  assert.equal(pending.length, 2);
  windowEvents.dispatchEvent(new CustomEvent("wand-settings-config-saved", {
    detail: { userProfile: { name: "最新", avatar: "cat:2" } },
  }));
  pending[1]!.resolve(Response.json({
    userProfile: { name: "过期", avatar: "cat:3" },
    defaultCwd: "/old",
  }));
  await late;
  assert.equal(config.peekConfigSnapshot(), null, "a read that predates the save is discarded");
  assert.equal(profile.userProfileStore.getSnapshot().name, "最新", "the saved identity survives the late read");

  const fresh = config.loadConfigSnapshot();
  assert.equal(pending.length, 3);
  pending[2]!.resolve(Response.json({
    userProfile: { name: "最新", avatar: "cat:2" },
    defaultCwd: "/new",
  }));
  await fresh;
  assert.equal(config.peekConfigSnapshot()?.defaultCwd, "/new");
  assert.equal(profile.userProfileStore.getSnapshot().avatar, "cat:2");
});

test("session list snapshot shares every same-dimension reader and validates responses", async () => {
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  globalThis.fetch = ((url: string) => {
    assert.equal(url, "/api/sessions");
    const next = deferred<Response>();
    pending.push(next);
    return next.promise;
  }) as typeof fetch;

  const sessionList = await import("../src/web-ui/react/session-list-snapshot.ts");
  const legacy = sessionList.loadSessionList({ force: true });
  const reactProjection = sessionList.loadSessionList();
  assert.equal(pending.length, 1, "legacy refresh and React projection share one request");
  pending[0]!.resolve(Response.json([{ id: "A" }]));
  assert.deepEqual(await Promise.all([legacy, reactProjection]), [[{ id: "A" }], [{ id: "A" }]]);
  assert.deepEqual(sessionList.peekSessionList(), [{ id: "A" }]);

  assert.deepEqual(await sessionList.loadSessionList(), [{ id: "A" }]);
  assert.equal(pending.length, 1, "a cached list is not downloaded again");

  const forced = sessionList.loadSessionList({ force: true });
  assert.equal(pending.length, 2, "an active refresh still reads the server");
  pending[1]!.resolve(Response.json([{ id: "B" }]));
  await forced;
  assert.deepEqual(sessionList.peekSessionList(), [{ id: "B" }]);

  const invalid = sessionList.loadSessionList({ force: true });
  pending[2]!.resolve(Response.json({ sessions: [] }));
  await assert.rejects(invalid, /Invalid session list response/);
  const retried = sessionList.loadSessionList({ force: true });
  assert.equal(pending.length, 4, "an invalid response does not leave the read slot stuck");
  pending[3]!.resolve(Response.json([{ id: "C" }]));
  await retried;
  assert.deepEqual(sessionList.peekSessionList(), [{ id: "C" }]);

  const expired = sessionList.loadSessionList({ force: true });
  pending[4]!.resolve(Response.json({ error: "expired" }, { status: 401 }));
  await assert.rejects(expired, (error: any) => error?.status === 401);

  sessionList.invalidateSessionList();
  assert.equal(sessionList.peekSessionList(), null);
});

test("employee plain and archived queries keep independent snapshots", async () => {
  const requests: Array<{ url: string; response: ReturnType<typeof deferred<Response>> }> = [];
  globalThis.fetch = ((url: string) => {
    const response = deferred<Response>();
    requests.push({ url, response });
    return response.promise;
  }) as typeof fetch;

  const employees = await import("../src/web-ui/react/agents/employee-repository.ts");
  const plain = employees.siliconEmployeesRepository.list();
  const sharedPlain = employees.siliconEmployeesRepository.list();
  const archived = employees.siliconEmployeesRepository.list({ includeArchived: true });
  assert.deepEqual(requests.map((request) => request.url), [
    "/api/silicon-employees",
    "/api/silicon-employees?includeArchived=1",
  ], "includeArchived is a separate dimension, never merged into the plain cache");

  requests[0]!.response.resolve(Response.json({ employees: [{ id: "e_plain" }] }));
  requests[1]!.response.resolve(Response.json({ employees: [{ id: "e_archived" }] }));
  await Promise.all([plain, sharedPlain, archived]);
  assert.equal(employees.peekSiliconEmployees(false)?.[0]?.id, "e_plain");
  assert.equal(employees.peekSiliconEmployees(true)?.[0]?.id, "e_archived");

  await employees.siliconEmployeesRepository.list();
  await employees.siliconEmployeesRepository.list({ includeArchived: true });
  assert.equal(requests.length, 2, "both dimensions serve committed snapshots");

  employees.invalidateEmployeeList();
  assert.equal(employees.peekSiliconEmployees(false), null);
  assert.equal(employees.cachedSiliconEmployee("e_plain"), null, "invalidation clears directory lookups immediately");
  void employees.siliconEmployeesRepository.list();
  void employees.siliconEmployeesRepository.list({ includeArchived: true });
  assert.equal(requests.length, 4, "the next readers own fresh requests for each dimension");
});

test("the engine publish feeds the React projection without another download", async () => {
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  globalThis.fetch = ((url: string) => {
    assert.equal(url, "/api/sessions");
    const next = deferred<Response>();
    pending.push(next);
    return next.promise;
  }) as typeof fetch;

  const sessionList = await import("../src/web-ui/react/session-list-snapshot.ts");
  const conversations = await import("../src/web-ui/react/conversations/repository.ts");

  const read = sessionList.loadSessionList();
  assert.equal(pending.length, 1);
  pending[0]!.resolve(Response.json([{ id: "sys_1", automationId: "system-ai:system-text:1", employeeId: "e_1" }]));
  await read;
  assert.equal(pending.length, 1);

  // 轮询式的读取复用已提交快照：同一份全量不再下载。
  await conversations.conversationsRepository.systemSessions();
  await conversations.conversationsRepository.systemSessions();
  assert.equal(pending.length, 1, "the poll reuses the committed list instead of downloading it again");

  // 引擎发布新列表后，投影直接读到新值，仍然不需要请求。
  let notified = 0;
  const unsubscribe = sessionList.subscribeSessionList(() => { notified++; });
  sessionList.publishSessionList(sessionList.projectSessionSummaries([
    { id: "sys_1", automationId: "system-ai:system-text:1", employeeId: "e_1", status: "exited" },
    { id: "sys_2", automationId: "system-ai:system-text:2", employeeId: "e_2" },
  ]));
  unsubscribe();
  assert.equal(notified, 1, "the projection is notified once per publish");
  assert.equal(pending.length, 1, "an engine publish never triggers a download");
  assert.deepEqual(
    conversations.conversationsRepository.peekSystemSessions().map(session => session.id),
    ["sys_1", "sys_2"],
  );
  assert.deepEqual(
    (await conversations.conversationsRepository.systemSessions()).map(session => session.id),
    ["sys_1", "sys_2"],
  );
  assert.equal(pending.length, 1);

  // 用户主动刷新才绕过快照重新下载。
  const forced = conversations.conversationsRepository.systemSessions({ fresh: true });
  assert.equal(pending.length, 2, "an explicit refresh still reads the server");
  pending[1]!.resolve(Response.json([{ id: "sys_3", automationId: "system-ai:system-text:3", employeeId: "e_3" }]));
  await forced;
  assert.equal(conversations.conversationsRepository.peekSystemSessions()[0]?.id, "sys_3");
});

test("session list projection keeps DTO fields and drops local buffers", async () => {
  const sessionList = await import("../src/web-ui/react/session-list-snapshot.ts");
  const projected = sessionList.projectSessionSummaries([
    {
      id: "A", status: "running", title: "任务", employeeId: "e_1", employeeName: "伙伴",
      automationId: "system-ai:system-text:1", archived: false, teamChat: { teamId: "t" },
      output: "本地终端缓冲", messages: [{ role: "user", content: "本地消息" }],
      messageOffset: 12,
    },
    { title: "没有 id 的条目" },
    { id: "quick", sessionKind: "pty", sessionSource: "quick-terminal", status: "running" },
    null,
  ]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.id, "A");
  assert.equal(projected[0]?.employeeName, "伙伴");
  assert.equal(projected[0]?.automationId, "system-ai:system-text:1");
  assert.deepEqual(projected[0]?.teamChat, { teamId: "t" });
  assert.equal((projected[0] as Record<string, unknown>).output, undefined, "local output buffers stay in the engine");
  assert.equal((projected[0] as Record<string, unknown>).messages, undefined, "local message windows stay in the engine");
  assert.equal((projected[0] as Record<string, unknown>).messageOffset, undefined);
});

test("a stale session list forces one re-read while a fresh one is served from memory", async () => {
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  globalThis.fetch = ((url: string) => {
    assert.equal(url, "/api/sessions");
    const next = deferred<Response>();
    pending.push(next);
    return next.promise;
  }) as typeof fetch;

  const sessionList = await import("../src/web-ui/react/session-list-snapshot.ts");
  sessionList.invalidateSessionList();
  const read = sessionList.loadSessionList();
  pending[0]!.resolve(Response.json([{ id: "A" }]));
  await read;
  assert.equal(pending.length, 1);

  // 轮询：快照还新鲜时复用，不重复下载。
  await sessionList.loadSessionList({ maxAgeMs: 60_000 });
  assert.equal(pending.length, 1, "a fresh snapshot is not downloaded again");

  // 快照被标记过期：保留旧值给界面，但下一次读必须回服务端。
  sessionList.markSessionListStale();
  assert.deepEqual(sessionList.peekSessionList(), [{ id: "A" }], "a stale list keeps its value for the UI");
  const reread = sessionList.loadSessionList({ maxAgeMs: 60_000 });
  assert.equal(pending.length, 2, "a stale list is downloaded again exactly once");
  pending[1]!.resolve(Response.json([{ id: "B" }]));
  await reread;
  assert.deepEqual(sessionList.peekSessionList(), [{ id: "B" }]);

  await sessionList.loadSessionList({ maxAgeMs: 60_000 });
  assert.equal(pending.length, 2, "the fresh read serves later readers without IO");
});

test.after(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
