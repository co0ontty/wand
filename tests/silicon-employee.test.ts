import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";

import { defaultConfig } from "../src/config.js";
import { WAND_LOCAL_DECISION_MODEL } from "../src/decision-expert-identity.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { employeeCandidateAvailable, selectEmployeeCandidate } from "../src/silicon-employee-dispatch.js";
import { EMPLOYEE_CREATION_DEFAULTS_PREF, resolveSiliconEmployeeDefaults } from "../src/silicon-employee-defaults.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import { parseSiliconEmployeeInput, registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import {
  availableEmployeeProviders,
  buildEmployeeDraftPrompt,
  employeeAgentFor,
  generateSiliconEmployeeDraft,
  normalizeSiliconEmployeeDraft,
  parseSiliconEmployeeDraft,
  SiliconEmployeeDraftError,
  validateStructuredEmployeeDraft,
} from "../src/silicon-employee-draft.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import type { StructuredRunnerAdapter } from "../src/structured-runner.js";
import type { AiTeamRunner } from "../src/ai-team-runner.js";

const CODEX = { provider: "codex", model: "default", thinkingEffort: "off", mode: "full-access", kind: "structured" } as const;
const PI = { provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;

function employee(overrides: Partial<SiliconEmployee> = {}): SiliconEmployee {
  return {
    id: "e_test123", name: "测试员工", duty: "自动化测试", prompt: "你是严谨的测试工程师。",
    avatar: "cat:1", agents: [CODEX, PI],
    createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

test("SiliconEmployee storage: CRUD & archive operations", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wand-employee-test-"));
  const dbPath = join(tempDir, "wand.db");
  const storage = new WandStorage(dbPath);

  try {
    const initialList = storage.listSiliconEmployees();
    assert.deepEqual(initialList, []);

    const employee: SiliconEmployee = {
      id: "e_test123",
      name: "测试员工",
      duty: "前端开发与动效实现",
      prompt: "你是一名资深前端工程师",
      avatar: "cat:1",
      agents: [
        {
          provider: "claude",
          model: "claude-3-7-sonnet",
          thinkingEffort: "standard",
          mode: "default",
          kind: "structured",
        },
      ],
      createdAt: "2026-03-30T10:00:00.000Z",
      updatedAt: "2026-03-30T10:00:00.000Z",
    };

    storage.saveSiliconEmployee(employee);

    const fetched = storage.getSiliconEmployee("e_test123");
    assert.ok(fetched);
    assert.equal(fetched.name, "测试员工");
    assert.equal(fetched.agents.length, 1);
    assert.equal(fetched.agents[0]?.provider, "claude");

    // 更新
    storage.saveSiliconEmployee({
      ...employee,
      name: "更新后的员工",
      updatedAt: "2026-03-30T11:00:00.000Z",
    });
    const updated = storage.getSiliconEmployee("e_test123");
    assert.equal(updated?.name, "更新后的员工");

    // 归档
    storage.archiveSiliconEmployee("e_test123", "2026-03-30T12:00:00.000Z");
    assert.equal(storage.listSiliconEmployees().length, 0);
    assert.equal(storage.listSiliconEmployees({ includeArchived: true }).length, 1);

    // 取消归档
    storage.unarchiveSiliconEmployee("e_test123");
    assert.equal(storage.listSiliconEmployees().length, 1);

    // 删除
    storage.deleteSiliconEmployee("e_test123");
    assert.equal(storage.getSiliconEmployee("e_test123"), null);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseSiliconEmployeeInput validation", () => {
  const now = "2026-03-30T10:00:00.000Z";

  // 缺少名字
  assert.throws(() => {
    parseSiliconEmployeeInput({ name: "", agents: [] }, null, now);
  }, /员工名字不能为空/);

  // 缺少候选
  assert.throws(() => {
    parseSiliconEmployeeInput({ name: "小明", agents: [] }, null, now);
  }, /至少需要一个执行候选/);

  // 有效输入
  const valid = parseSiliconEmployeeInput({
    name: "小明",
    duty: "自动化测试",
    prompt: "严谨细致",
    agents: [
      {
        provider: "codex",
        model: "gpt-4o",
        thinkingEffort: "off",
        mode: "default",
        kind: "structured",
      },
    ],
  }, null, now);

  assert.equal(valid.name, "小明");
  assert.match(valid.id, /^e_[0-9a-f]{32}$/);
  assert.equal(valid.agents.length, 1);
  assert.notEqual(parseSiliconEmployeeInput({ ...valid, id: "e_existing" }, null, now).id, "e_existing");
  assert.throws(() => parseSiliconEmployeeInput({
    name: "终端员工", agents: [{ ...PI, kind: "pty" }],
  }, null, now), /只支持结构化会话/);
});

test("employee candidates keep configured order and skip an unavailable CLI", () => {
  const selected = selectEmployeeCandidate(employee(), (agent) => agent.provider === "pi");
  assert.equal(selected.index, 1);
  assert.equal(selected.agent.provider, "pi");
  assert.equal(selectEmployeeCandidate(employee(), () => false).index, 0);
});

test("员工候选不因触发入口跳过 SDK，并保留原始顺序", () => {
  const configured = { ...employee(), agents: [{ ...PI, engine: "sdk" as const }, CODEX] };
  const explicit = selectEmployeeCandidate(configured, () => true);
  assert.equal(explicit.index, 0);
  assert.equal(explicit.agent.engine, "sdk");
  assert.equal(employeeCandidateAvailable(configured.agents[0]!), true, "SDK 不依赖 Pi CLI 安装");
  const unavailable = selectEmployeeCandidate(configured, agent => agent.engine !== "sdk");
  assert.equal(unavailable.index, 1, "仍可按真实可用性跳过尚未接受请求的候选");
});
test("employee HTTP create cannot replace an existing id; sessions and tasks retain identity snapshots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-http-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const teamStarts: Array<{ teamId: string; taskId: string; note?: string }> = [];
  const aiTeams = { async start(input: { teamId: string; taskId: string; note?: string }) {
    teamStarts.push(input);
    return { run: { chatSessionId: "chat-team" } };
  } } as unknown as AiTeamRunner;
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, { storage });
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions);
  registerTaskRoutes(app, { storage, sessions, structured, processes, config, aiTeams });
  registerWorkspaceRoutes(app, storage, sessions);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await whenIterationPromptsSettled();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = async (route: string, method: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: response.status === 204 ? null : await response.json() as Record<string, unknown> };
  };

  storage.saveSiliconEmployee(employee());
  const created = await request("/api/silicon-employees", "POST", {
    ...employee({ name: "新员工" }), id: "e_test123",
  });
  assert.equal(created.status, 201);
  assert.notEqual(created.json?.id, "e_test123");
  assert.equal(storage.getSiliconEmployee("e_test123")?.name, "测试员工");

  const made = await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: "e_test123", provider: "grok", systemPrompt: "客户端冒充规则",
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const sessionId = made.json?.id as string;
  assert.equal(made.json?.employeeId, "e_test123");
  assert.equal(made.json?.employeeName, "测试员工");
  assert.equal(made.json?.employeeAvatar, "cat:1");
  assert.equal(made.json?.employeeCandidateIndex, selectEmployeeCandidate(employee()).index);
  assert.equal(storage.getSession(sessionId)?.systemPrompt, "你是严谨的测试工程师。");
  assert.equal(storage.getSession(sessionId)?.employeeId, "e_test123");
  assert.equal(storage.getSession(sessionId)?.employeeCandidates?.length, 2);

  const customSession = await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: "e_test123", overrideCli: true, provider: "pi", model: "custom-pi-model",
  });
  assert.equal(customSession.status, 201, JSON.stringify(customSession.json));
  assert.equal(customSession.json?.employeeId, "e_test123");
  assert.equal(customSession.json?.provider, "pi");
  assert.equal(customSession.json?.selectedModel, "custom-pi-model");
  assert.equal(customSession.json?.employeeName, "测试员工");

  assert.equal((await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: "e_test123", runner: "pty",
  })).status, 400);
  assert.equal((await request("/api/structured-sessions", "POST", {
    cwd: root, teamId: "team_test",
  })).status, 400);

  const createdTask = await request("/api/wand-tasks", "POST", {
    title: "交给员工", executionSubject: { type: "employee", id: "e_test123" },
  });
  assert.equal(createdTask.status, 201, JSON.stringify(createdTask.json));
  assert.deepEqual(createdTask.json?.executionSubject, { type: "employee", id: "e_test123" });
  assert.equal((createdTask.json?.agent as Record<string, unknown>)?.provider, "codex");
  const changedSubject = await request(`/api/wand-tasks/${createdTask.json?.id}`, "PATCH", {
    executionSubject: { type: "cli", id: "pi" },
  });
  assert.equal(changedSubject.status, 200);
  assert.equal((changedSubject.json?.agent as Record<string, unknown>)?.provider, "pi");
  assert.deepEqual(changedSubject.json?.executionSubject, { type: "cli", id: "pi" });
  const invalidTask = await request("/api/wand-tasks", "POST", {
    title: "错误的终端员工", executionSubject: { type: "employee", id: "e_test123" },
    agent: { ...PI, kind: "pty" },
  });
  assert.equal(invalidTask.status, 400);
  assert.equal(storage.getPreference("pref:taskBoardLastAgent", null), null,
    "rejected task creation must not change the saved CLI preference");
  const invalidPatch = await request(`/api/wand-tasks/${createdTask.json?.id}`, "PATCH", {
    agent: { ...PI, kind: "pty" }, executionSubject: { type: "employee", id: "e_test123" },
  });
  assert.equal(invalidPatch.status, 400);
  assert.equal(storage.getPreference("pref:taskBoardLastAgent", null), null,
    "rejected task edits must not change the saved CLI preference");

  const task = storage.createWandTask({ title: "检查 API", description: "验证员工分派" });
  structured.sendMessage = (async (id: string) => structured.get(id)!) as typeof structured.sendMessage;
  const dispatched = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "employee", id: "e_test123" }, prompt: "执行测试",
  });
  assert.equal(dispatched.status, 202);
  assert.deepEqual(dispatched.json?.subject, { type: "employee", id: "e_test123" });
  const assigned = await request(`/api/wand-tasks/${task.id}`, "GET");
  assert.deepEqual(assigned.json?.executionSubject, { type: "employee", id: "e_test123" });
  assert.equal((assigned.json?.sessions as Array<Record<string, unknown>>)[0]?.employeeName, "测试员工");
  const movedTo = storage.createWorkspace({ name: "另一个项目", cwd: root });
  const rejectedMove = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "employee", id: "e_test123" }, workspaceId: movedTo.id,
  });
  assert.equal(rejectedMove.status, 400, "repeat dispatch needs an explicit prompt");
  assert.equal(storage.getWandTask(task.id)?.workspaceId, null,
    "rejected dispatch must not move the task before validation");
  const workspaceTree = (await request("/api/tasks", "GET")).json as unknown as Array<{
    tasks: Array<{ sessions: Array<{ employeeId?: string; employeeName?: string }> }>;
  }>;
  assert.equal(workspaceTree.flatMap((group) => group.tasks.flatMap((entry) => entry.sessions))
    .some((entry) => entry.employeeId === "e_test123" && entry.employeeName === "测试员工"), true);
  await request(`/api/wand-tasks/${task.id}`, "PATCH", { status: "done" });
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "employee", id: "e_test123" });
  assert.equal((await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "employee", id: "e_test123" }, kind: "pty", prompt: "终端执行",
  })).status, 400);

  storage.saveAiTeam({
    id: "team_test", name: "协作组", description: "", instructions: "",
    members: [{ id: "m_lead", name: "负责人", duty: "计划", agents: [CODEX], agent: CODEX, isLeader: true }],
    requirePlanApproval: false, maxSteps: 10,
    createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
  });
  assert.equal((await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "team", id: "team_test" }, kind: "pty", prompt: "终端执行",
  })).status, 400);
  assert.equal(teamStarts.length, 0);
  const teamDispatch = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "team", id: "team_test" }, prompt: "安排协作",
  });
  assert.equal(teamDispatch.status, 202, JSON.stringify(teamDispatch.json));
  assert.equal((teamDispatch.json?.session as Record<string, unknown>)?.id, "chat-team");
  assert.deepEqual(teamStarts, [{ teamId: "team_test", taskId: task.id, note: "安排协作" }]);
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "team", id: "team_test" });

  const oldCliDispatch = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    agent: PI, prompt: "交给 CLI",
  });
  assert.equal(oldCliDispatch.status, 202, JSON.stringify(oldCliDispatch.json));
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "cli", id: "pi" });

  // Only the engine decision is mocked. No request is submitted to a real model or CLI.
  const resolveEngine = structured.resolveNewSessionPiEngine.bind(structured);
  structured.resolveNewSessionPiEngine = engine => engine === "sdk"
    ? { engine: "core", reason: "mock SDK ready" } : resolveEngine(engine);
  const sdkEmployee = employee({ agents: [{ ...PI, engine: "sdk" }, CODEX] });
  storage.saveSiliconEmployee(sdkEmployee);
  const sdkSession = await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: sdkEmployee.id, engine: "cli",
  });
  assert.equal(sdkSession.status, 201, JSON.stringify(sdkSession.json));
  assert.equal(sdkSession.json?.employeeCandidateIndex, 0);
  assert.equal((sdkSession.json?.structuredState as Record<string, unknown>)?.engine, "core",
    "employee candidate, rather than a client engine override, determines execution");
  const explicitCli = await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: sdkEmployee.id, overrideCli: true, provider: "pi", engine: "cli",
  });
  assert.equal(explicitCli.status, 201, JSON.stringify(explicitCli.json));
  assert.equal((explicitCli.json?.structuredState as Record<string, unknown>)?.engine, "cli",
    "explicit manual tool selection remains authoritative");
  const sdkDispatch = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "employee", id: sdkEmployee.id }, prompt: "mock-only dispatch",
  });
  assert.equal(sdkDispatch.status, 202, JSON.stringify(sdkDispatch.json));
  const sdkDispatchedId = (sdkDispatch.json?.session as Record<string, unknown>)?.id as string;
  assert.equal(structured.get(sdkDispatchedId)?.employeeCandidateIndex, 0);
  assert.equal(structured.get(sdkDispatchedId)?.structuredState?.engine, "core",
    "task dispatch must not skip the preferred SDK candidate");
  const defaultEmployee = storage.getDefaultSiliconEmployee()!;
  storage.saveSiliconEmployee({ ...defaultEmployee, agents: sdkEmployee.agents });
  const defaultTask = storage.createWandTask({ title: "默认员工 SDK 派发" });
  const defaultDispatch = await request(`/api/wand-tasks/${defaultTask.id}/dispatch`, "POST", {
    prompt: "mock-only default dispatch",
  });
  assert.equal(defaultDispatch.status, 202, JSON.stringify(defaultDispatch.json));
  const defaultSessionId = (defaultDispatch.json?.session as Record<string, unknown>)?.id as string;
  assert.equal(structured.get(defaultSessionId)?.structuredState?.engine, "core");
  storage.saveSiliconEmployee(defaultEmployee);
  structured.resolveNewSessionPiEngine = engine => {
    if (engine === "sdk") throw new Error("mock Wand Agent unavailable");
    return resolveEngine(engine);
  };
  const unavailableSdk = await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: sdkEmployee.id,
  });
  assert.equal(unavailableSdk.status, 400);
  assert.match(String(unavailableSdk.json?.error), /Wand Agent unavailable/);
  assert.deepEqual(storage.getSiliconEmployee(sdkEmployee.id)?.agents, sdkEmployee.agents,
    "unavailable SDK must not rewrite saved candidates or impersonate a CLI");
  structured.resolveNewSessionPiEngine = resolveEngine;
  storage.saveSiliconEmployee(employee());

  assert.equal((await request("/api/silicon-employees/e_test123/archive", "POST", {})).status, 200);
  const activeEmployees = (await request("/api/silicon-employees", "GET")).json?.employees as Array<{ id: string }>;
  assert.equal(activeEmployees.some((item) => item.id === "e_test123"), false);
  const archivedEmployees = (await request("/api/silicon-employees?includeArchived=1", "GET")).json?.employees as Array<{ id: string }>;
  assert.equal(archivedEmployees.some((item) => item.id === "e_test123"), true);
  assert.equal((await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: "e_test123",
  })).status, 400);
  assert.equal((await request("/api/silicon-employees/e_test123", "DELETE")).status, 204);
  assert.equal(storage.getSession(sessionId)?.employeeName, "测试员工");
  const list = await request("/api/sessions", "GET");
  assert.equal((list.json as unknown as Array<Record<string, unknown>>).find((entry) => entry.id === sessionId)?.employeeName, "测试员工");
});

test("a failed spawn falls back before acceptance; a CLI runtime failure never resends", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-fallback-"));
  const storage = new WandStorage(join(root, "wand.db"));
  let codexStarts = 0;
  let piStarts = 0;
  let runtimeFailure = false;
  const result = (spawnError?: NodeJS.ErrnoException) => ({
    state: { blocks: [{ type: "text" as const, text: spawnError || runtimeFailure ? "" : "备用已完成" }], result: "", sessionId: null },
    exitCode: spawnError ? null : runtimeFailure ? 1 : 0,
    signal: null, stderr: runtimeFailure ? "provider failed after accepting input" : "",
    primaryError: null, spawnError,
  });
  const codex = { start() {
    codexStarts++;
    return { args: [], spawnedAt: new Date().toISOString(), pid: null,
      completion: Promise.resolve(result(runtimeFailure ? undefined : Object.assign(new Error("missing"), { code: "ENOENT" }))),
      interrupt() {} };
  } } as StructuredRunnerAdapter;
  const pi = { start() {
    piStarts++;
    return { args: [], spawnedAt: new Date().toISOString(), pid: 1,
      completion: Promise.resolve(result()), interrupt() {} };
  } } as StructuredRunnerAdapter;
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, { codex, pi });
  t.after(async () => {
    manager.dispose();
    await whenIterationPromptsSettled();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const make = (agents: SiliconEmployee["agents"] = [CODEX, PI]) => manager.createSession({ cwd: root, mode: "full-access", provider: "codex",
    employeeId: "e_test123", employeeName: "测试员工", employeeCandidates: agents, employeeCandidateIndex: 0 });
  const first = make();
  await manager.sendMessage(first.id, "请完成任务");
  assert.equal(manager.get(first.id)?.provider, "pi");
  assert.equal(manager.get(first.id)?.employeeCandidateIndex, 1);
  assert.equal(manager.get(first.id)?.messages?.filter((turn) => turn.role === "user").length, 1);
  assert.equal(codexStarts, 1);
  assert.equal(piStarts, 1);

  runtimeFailure = true;
  const second = make();
  await assert.rejects(manager.sendMessage(second.id, "可能已被接受"));
  assert.equal(manager.get(second.id)?.provider, "codex");
  assert.equal(manager.get(second.id)?.employeeCandidateIndex, 0);
  assert.equal(codexStarts, 2);
  assert.equal(piStarts, 1, "结果未知时不能重发到备用 CLI");

  runtimeFailure = false;
  const bounded = { ...PI, engine: "sdk" as const, model: WAND_LOCAL_DECISION_MODEL };
  const third = make([CODEX, bounded, PI]);
  await manager.sendMessage(third.id, "未接受时跳过不可聊天的模型");
  assert.equal(manager.get(third.id)?.employeeCandidateIndex, 2, "跳过 LAYA 仍保留配置中的真实序号");
  assert.equal(manager.get(third.id)?.selectedModel, null, "不把 LAYA selector 送到 Pi chat adapter");
  assert.equal(manager.get(third.id)?.messages?.filter(turn => turn.role === "user").length, 1);
  assert.equal(codexStarts, 3);
  assert.equal(piStarts, 2, "只调用一次正常备用，没有虚构 LAYA 会话");
});

test("员工起草：解析模型输出、容忍围栏并收敛非法 provider", () => {
  const draft = parseSiliconEmployeeDraft(
    "```json\n" + JSON.stringify({
      name: "接口守夜人", duty: "守护接口稳定", prompt: "你是值守接口的工程师。", provider: "codex",
    }) + "\n```",
    { allowedProviders: ["claude", "codex"], fallbackProvider: "claude" },
  );
  assert.equal(draft.name, "接口守夜人");
  assert.equal(draft.agent.provider, "codex");
  assert.equal(draft.agent.kind, "structured");
  assert.equal(draft.agent.model, "default");

  // provider 不在已安装清单里时退回首选，员工不能带着跑不起来的 CLI 落库。
  const fallback = parseSiliconEmployeeDraft(
    JSON.stringify({ name: "前端小匠", duty: "负责前端实现", prompt: "你是资深前端。", provider: "gemini" }),
    { allowedProviders: ["claude", "pi"], fallbackProvider: "pi" },
  );
  assert.equal(fallback.agent.provider, "pi");

  assert.throws(() => parseSiliconEmployeeDraft("这不是 JSON"), SiliconEmployeeDraftError);
  assert.throws(() => parseSiliconEmployeeDraft(JSON.stringify({ name: "", duty: "", prompt: "" })), /名字/);
  assert.throws(
    () => parseSiliconEmployeeDraft(JSON.stringify({ name: "有名字", duty: "职责", prompt: "" })),
    /角色设定/,
  );
});

test("员工起草：只把已安装的 CLI 交给模型，并带上重名避让清单", () => {
  const available = availableEmployeeProviders("pi", (agent) => agent.provider !== "claude");
  assert.equal(available[0], "pi");
  assert.equal(available.includes("claude"), false);

  const request = buildEmployeeDraftPrompt("帮我盯着线上接口", available, ["现有员工"]);
  assert.match(request.system, /不要与已有员工重名：现有员工/);
  assert.match(request.system, /"pi"（Pi coding agent）/);
  assert.equal(request.prompt.includes("帮我盯着线上接口"), true);
  assert.match(request.prompt, /帮我盯着线上接口/);

  // 一个 CLI 都没装时仍要给出可用的 provider 清单，而不是空列表。
  const none = availableEmployeeProviders("claude", () => false);
  assert.deepEqual(none, []);
  assert.match(buildEmployeeDraftPrompt("写代码", none).system, /"claude"（Claude Code）/);
});

test("员工起草：空期望与超长期望在调模型前就被拒", async () => {
  await assert.rejects(
    generateSiliconEmployeeDraft("   ", {}, { isProviderAvailable: () => false }),
    (error: unknown) => error instanceof SiliconEmployeeDraftError && error.code === "EMPTY_EXPECTATION",
  );
  await assert.rejects(
    generateSiliconEmployeeDraft("x".repeat(4_001), {}, { isProviderAvailable: () => false }),
    (error: unknown) => error instanceof SiliconEmployeeDraftError && error.code === "EXPECTATION_TOO_LONG",
  );
});

test("员工起草接口：注入生成器返回草稿，失败以 400 回传", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-draft-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const calls: Array<{ expectation: string; existingNames: string[] }> = [];
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, {
    storage,
    generateDraft: async (request) => {
      calls.push(request);
      if (request.expectation === "boom") throw new Error("系统 AI 不可用");
      return { name: "接口守夜人", duty: "守护接口稳定", prompt: "你是值守接口的工程师。", agent: employeeAgentFor("claude") };
    },
  });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/silicon-employees/draft`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };

  storage.saveSiliconEmployee(employee({ name: "既有员工" }));
  const ok = await post({ expectation: "帮我盯着线上接口" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json?.draft, {
    name: "接口守夜人", duty: "守护接口稳定", prompt: "你是值守接口的工程师。", agent: employeeAgentFor("claude"),
  });
  assert.deepEqual(calls[0], { expectation: "帮我盯着线上接口", existingNames: ["既有员工"] });

  const failed = await post({ expectation: "boom" });
  assert.equal(failed.status, 400, JSON.stringify(failed.json));
  assert.match(String(failed.json?.error), /系统 AI 不可用/);
});

test("员工草稿：重名/非法候选在统一校验入口被结构化拒绝", () => {
  // 名字与已有员工重复：结构化可恢复错误，不静默改名。
  assert.throws(
    () => normalizeSiliconEmployeeDraft(
      { name: "既有员工", duty: "职责", prompt: "你是严谨的工程师。", provider: "claude" },
      { existingNames: ["既有员工"] },
    ),
    (error: unknown) => error instanceof SiliconEmployeeDraftError && error.code === "DRAFT_DUPLICATE_NAME",
  );
  // 大小写不敏感的重名判定。
  assert.throws(
    () => normalizeSiliconEmployeeDraft(
      { name: "QA Bot", duty: "职责", prompt: "你是测试工程师。", provider: "claude" },
      { existingNames: ["qa bot"] },
    ),
    /DRAFT_DUPLICATE_NAME|已有名叫/,
  );

  // 严格模式（HR 结构化草稿）：越出允许集合的 provider 直接拒绝，不悄悄换成别的资源。
  assert.throws(
    () => validateStructuredEmployeeDraft(
      { name: "接口守夜人", duty: "守接口", prompt: "你是值守工程师。", agents: [{ provider: "codex" }] },
      { allowedProviders: ["pi", "claude"] },
    ),
    (error: unknown) => error instanceof SiliconEmployeeDraftError && error.code === "DRAFT_PROVIDER_NOT_ALLOWED",
  );
  // 未知 provider：拒绝而非兜底。
  assert.throws(
    () => validateStructuredEmployeeDraft(
      { name: "接口守夜人", duty: "守接口", prompt: "你是值守工程师。", provider: "not-a-cli" },
      { allowedProviders: ["pi"] },
    ),
    (error: unknown) => error instanceof SiliconEmployeeDraftError && error.code === "DRAFT_INVALID_PROVIDER",
  );
  // 缺执行候选：结构化错误并定位字段。
  assert.throws(
    () => validateStructuredEmployeeDraft({ name: "甲", duty: "职责", prompt: "你是……。" }, { allowedProviders: ["pi"] }),
    (error: unknown) => error instanceof SiliconEmployeeDraftError
      && error.code === "DRAFT_MISSING_AGENT" && error.field === "provider",
  );
  // SDK 引擎只允许 Pi；非 Pi 越界拒绝。
  assert.throws(
    () => validateStructuredEmployeeDraft(
      { name: "甲", duty: "职责", prompt: "你是……。", agents: [{ provider: "claude", engine: "sdk" }] },
      { allowedProviders: ["claude", "pi"] },
    ),
    /Wand Agent/,
  );
  // 重复候选拒绝。
  assert.throws(
    () => validateStructuredEmployeeDraft(
      { name: "甲", duty: "职责", prompt: "你是……。", agents: [{ provider: "pi" }, { provider: "pi" }] },
      { allowedProviders: ["pi", "claude"] },
    ),
    /重复/,
  );

  // 完整结构化草稿：agent 与 candidates 一致，旧客户端读 agent 不受影响。
  const ok = validateStructuredEmployeeDraft(
    { name: "接口守夜人", duty: "守接口", prompt: "你是值守工程师。", agents: [{ provider: "pi", model: "default" }] },
    { allowedProviders: ["pi", "claude"] },
  );
  assert.equal(ok.agent.provider, "pi");
  assert.deepEqual(ok.candidates, [ok.agent]);
});

test("员工默认解析：已保存创建配置 → 服务端默认 → 需要用户选择", () => {
  // 1. 已保存的员工创建配置最优先（两端读到同一份）。
  const saved = { provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
  const withSaved = resolveSiliconEmployeeDefaults({ savedAgent: saved, config: { defaultProvider: "codex" } });
  assert.equal(withSaved.source, "saved");
  assert.equal(withSaved.provider, "pi");
  assert.deepEqual(withSaved.agent, saved);

  // 2. 没有保存配置时解析服务端 defaultProvider/defaultModel。
  const server = resolveSiliconEmployeeDefaults({ savedAgent: null, config: { defaultProvider: "codex", defaultCodexModel: "gpt-5" } });
  assert.equal(server.source, "server");
  assert.equal(server.provider, "codex");
  assert.deepEqual(server.agent, employeeAgentFor("codex"));
  assert.equal(server.configured, true);

  // 3. 两者都没有：如实返回需要用户选择，不硬编码任何端的默认。
  const none = resolveSiliconEmployeeDefaults({ savedAgent: null, config: { defaultProvider: undefined } });
  assert.equal(none.configured, false);
  assert.equal(none.requiresUserChoice, true);
  assert.equal(none.provider, undefined);
});

test("员工草稿接口：结构化草稿走同一校验，不调用模型且不改实体", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-structured-draft-"));
  const storage = new WandStorage(join(root, "wand.db"));
  let generateCalls = 0;
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, {
    storage,
    isProviderAvailable: (agent) => ["pi", "claude", "codex"].includes(agent.provider),
    generateDraft: async () => { generateCalls += 1; return { name: "不该出现", duty: "", prompt: "", agent: employeeAgentFor("claude") }; },
  });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const postDraft = async (body: unknown) => {
    const response = await fetch(`${base}/api/silicon-employees/draft`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };

  storage.saveSiliconEmployee(employee({ name: "既有员工" }));
  const employeesBefore = storage.listSiliconEmployees({ includeArchived: true }).length;
  const tasksBefore = storage.listWandTasks().length;

  // 结构化草稿校验：0 次模型调用，usage 如实标注。
  const validated = await postDraft({
    draft: { name: "接口守夜人", duty: "守护接口稳定", prompt: "你是值守接口的工程师。", provider: "pi" },
  });
  assert.equal(validated.status, 200, JSON.stringify(validated.json));
  assert.equal(generateCalls, 0, "结构化草稿不能触发第二次模型调用");
  assert.deepEqual((validated.json.usage as { generateCalls: number }).generateCalls, 0);
  assert.equal((validated.json.usage as { path: string }).path, "validated");
  const draft = validated.json.draft as { name: string; agent: { provider: string }; candidates: unknown[] };
  assert.equal(draft.name, "接口守夜人");
  assert.equal(draft.agent.provider, "pi");
  assert.equal(draft.candidates.length, 1);

  // 非法候选：结构化错误码。
  const illegal = await postDraft({
    draft: { name: "越界员工", duty: "职责", prompt: "你是……。", provider: "gemini" },
  });
  assert.equal(illegal.status, 400);
  assert.equal(illegal.json.code, "DRAFT_PROVIDER_NOT_ALLOWED");

  // 生成路径空期望：调模型前就被拒，且不落任何实体。
  const empty = await postDraft({ expectation: "  " });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "EMPTY_EXPECTATION");

  // 生成路径错误回显原口语输入，客户端可继续编辑。
  const echoed = await postDraft({ expectation: "不该被调用的期望" });
  assert.equal(generateCalls, 1, "普通期望仍走一次生成");
  const duplicate = await postDraft({
    draft: { name: "既有员工", duty: "职责", prompt: "你是……。", provider: "pi" },
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.json.code, "DRAFT_DUPLICATE_NAME");
  assert.equal(duplicate.json.field, "name");
  void echoed;

  assert.equal(storage.listSiliconEmployees({ includeArchived: true }).length, employeesBefore, "草稿接口不能保存员工");
  assert.equal(storage.listWandTasks().length, tasksBefore, "草稿接口不能创建任务");
});

test("员工 defaults 接口：Web/Android 同配置同响应，可显式保存创建默认", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-defaults-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultProvider: "codex" as const };
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, { storage, config });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const getDefaults = async () => {
    const response = await fetch(`${base}/api/silicon-employees/draft/defaults`);
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };

  // 未保存创建配置：解析服务端 defaultProvider；两个客户端各取一次拿到同一份。
  const web = await getDefaults();
  const android = await getDefaults();
  assert.equal(web.status, 200);
  assert.deepEqual(web.json, android.json, "同服务配置下两端 defaults 必须一致");
  assert.equal(web.json.source, "server");
  assert.equal(web.json.provider, "codex");

  // 显式保存后：来源切到 saved，仍是同一解析函数。
  const put = await fetch(`${base}/api/silicon-employees/draft/defaults`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "pi", model: "default", kind: "structured" }),
  });
  assert.equal(put.status, 200);
  const after = await getDefaults();
  assert.equal(after.json.source, "saved");
  assert.equal((after.json.agent as { provider: string }).provider, "pi");

  // PTY 候选拒绝。
  const bad = await fetch(`${base}/api/silicon-employees/draft/defaults`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "claude", kind: "pty" }),
  });
  assert.equal(bad.status, 400);

  // 损坏的已保存配置回落到服务端默认，不 500。
  storage.setPreference(EMPLOYEE_CREATION_DEFAULTS_PREF, { provider: "not-a-cli" });
  const fallback = await getDefaults();
  assert.equal(fallback.json.source, "server");

  // 保存默认不创建员工实体。
  assert.equal(storage.listSiliconEmployees({ includeArchived: true }).length, 0);
});
