import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PLATFORM_ACTION_SCHEMA_VERSION } from "../src/platform-action-types.js";
import {
  EMPLOYEE_SEARCH_DEFINITION,
  PlatformActionRegistry,
} from "../src/platform-action-catalog.js";
import {
  createReadOnlyPlatformActionDeps,
  describePlatformCatalog,
  invokePlatformAction,
  type EmployeeDirectoryPort,
  type EmployeeDirectoryRecord,
} from "../src/platform-action-service.js";
import type {
  EmployeeSearchOutput,
  PlatformActorContext,
} from "../src/platform-action-types.js";
import { WandStorage } from "../src/storage.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";

const SEARCH_SCOPE = "employee.search";

const makeActor = (overrides: Partial<PlatformActorContext> = {}): PlatformActorContext => ({
  actorKind: "employee_session",
  employeeId: "e_caller",
  sessionId: "s_1",
  conversationId: null,
  grantedScopes: [SEARCH_SCOPE],
  ...overrides,
});

const makeRecord = (overrides: Partial<EmployeeDirectoryRecord> & { id: string }): EmployeeDirectoryRecord => ({
  name: overrides.id,
  duty: "",
  tags: [],
  agents: [{ provider: "pi" }],
  ...overrides,
});

function makeFakeDirectory(records: EmployeeDirectoryRecord[]) {
  const calls: (string | null)[] = [];
  const stateBefore = JSON.stringify(records);
  return {
    calls,
    port: {
      listSiliconEmployees(options?: { includeArchived?: boolean }): EmployeeDirectoryRecord[] {
        calls.push(JSON.stringify(options ?? null));
        return records
          .filter((record) => options?.includeArchived || !record.archivedAt)
          .map((record) => ({ ...record }));
      },
    } satisfies EmployeeDirectoryPort,
    assertUnchanged(): void {
      assert.equal(JSON.stringify(records), stateBefore, "只读动作不得修改目录记录");
    },
  };
}

const basicRecords: EmployeeDirectoryRecord[] = [
  makeRecord({ id: "e_hr", name: "HR小陈", duty: "招聘与团队组织", systemKey: "wand-ops", tags: [] }),
  makeRecord({ id: "e_xiangcai", name: "香菜", duty: "前端界面与交互", tags: ["前端", "UI"] }),
  makeRecord({ id: "e_lin1", name: "小林", duty: "后端服务" }),
  makeRecord({ id: "e_lin2", name: "小林", duty: "测试与质量", tags: ["QA"] }),
  makeRecord({ id: "e_archived", name: "阿常", duty: "前端运维", archivedAt: "2026-01-01T00:00:00.000Z" }),
  makeRecord({ id: "e_unconfigured", name: "Fable", duty: "generalist", agents: [] }),
];

function setup(t: { after(fn: () => void | Promise<void>): void }, records = basicRecords) {
  const dir = makeFakeDirectory(records);
  t.after(() => dir.assertUnchanged());
  return { deps: createReadOnlyPlatformActionDeps(dir.port), dir };
}

async function invoke(deps: ReturnType<typeof createReadOnlyPlatformActionDeps>, action: string, input: unknown,
  actor = makeActor(), requestId = "req_1") {
  return await invokePlatformAction({ requestId, action, input }, actor, deps);
}

function expectRejected(result: Awaited<ReturnType<typeof invokePlatformAction>>, code: string, field?: string) {
  assert.equal(result.state, "rejected");
  assert.ok(result.state === "rejected");
  assert.equal(result.error.code, code, `期望 ${code}，实际 ${JSON.stringify(result.error)}`);
  if (field !== undefined) assert.equal(result.error.field, field);
  return result.error;
}

function expectCompleted(result: Awaited<ReturnType<typeof invokePlatformAction>>) {
  assert.equal(result.state, "completed", JSON.stringify(result));
  assert.ok(result.state === "completed");
  return result.output as EmployeeSearchOutput;
}

test("IM-07 A1: 空权限得到空目录与明确拒绝，不默认管理员", async (t) => {
  const { deps } = setup(t);
  const catalog = describePlatformCatalog(makeActor({ grantedScopes: [] }), deps);
  assert.deepEqual(catalog.entries, []);
  const wildcard = expectRejected(await invoke(deps, "employee.search", {},
    makeActor({ grantedScopes: ["*"] })), "scope_denied");
  assert.ok(wildcard);
  const denied = expectRejected(await invoke(deps, "employee.search", {},
    makeActor({ grantedScopes: [], employeeId: null })), "scope_denied");
  assert.equal(denied.message.includes("employee.search"), true);
});

test("IM-07 A1: 未知动作、未知参数字段、错误类型被拒绝", async (t) => {
  const { deps } = setup(t);
  expectRejected(await invoke(deps, "employee.create", {}), "unknown_action", "action");
  expectRejected(await invoke(deps, "Employee.Search", {}), "unknown_action", "action");
  expectRejected(await invoke(deps, "employee.search", { limit: "10" }), "invalid_type", "limit");
  expectRejected(await invoke(deps, "employee.search", { query: 123 }), "invalid_type", "query");
  expectRejected(await invoke(deps, "employee.search", { query: "x".repeat(121) }), "invalid_value", "query");
  expectRejected(await invoke(deps, "employee.search", { limit: 0 }), "invalid_value", "limit");
  expectRejected(await invoke(deps, "employee.search", { limit: 51 }), "invalid_value", "limit");
  expectRejected(await invoke(deps, "employee.search", null), "invalid_request");
  expectRejected(await invoke(deps, "employee.search", ["香菜"]), "invalid_request");
  const reqId = expectRejected(await invokePlatformAction({ requestId: "", action: "employee.search" }, makeActor(), deps),
    "invalid_request", "requestId");
  assert.ok(reqId);
});

test("IM-07 A2: employee.search 只读目录，不返回私密字段、不修改记录", async (t) => {
  const { deps, dir } = setup(t);
  const output = expectCompleted(await invoke(deps, "employee.search", {}));
  assert.deepEqual(dir.calls, ["null"], "只允许一次默认（排除归档）目录读取");
  for (const match of output.matches) {
    assert.deepEqual(Object.keys(match).sort(),
      ["availability", "builtin", "duty", "employeeId", "name", "tags"]);
  }
  const serialized = JSON.stringify(output);
  for (const leak of ["prompt", "knowledge", "token", "agents", "archived"]) {
    assert.equal(serialized.includes(leak), false, `输出不应包含 ${leak}`);
  }
  dir.assertUnchanged();
});

test("IM-07 A2: 归档排除、同名提示、可用性口径与有界输出", async (t) => {
  const { deps } = setup(t);
  const all = expectCompleted(await invoke(deps, "employee.search", {}));
  assert.equal(all.matches.some((m) => m.employeeId === "e_archived"), false);
  assert.deepEqual(all.duplicateNames, ["小林"]);
  const unconfigured = all.matches.find((m) => m.employeeId === "e_unconfigured");
  assert.equal(unconfigured?.availability, "unconfigured");
  const hr = all.matches.find((m) => m.employeeId === "e_hr");
  assert.equal(hr?.builtin, true);
  assert.equal(all.matches[0]?.employeeId, "e_hr", "内置员工按目录口径排前");

  const byDuty = expectCompleted(await invoke(deps, "employee.search", { query: "前端" }));
  assert.deepEqual(byDuty.matches.map((m) => m.employeeId), ["e_xiangcai"], "query 命中职责/标签且排除归档");
  const byTag = expectCompleted(await invoke(deps, "employee.search", { query: "ui" }));
  assert.deepEqual(byTag.matches.map((m) => m.employeeId), ["e_xiangcai"], "大小写不敏感");

  const many = Array.from({ length: 100 }, (_, i) => makeRecord({
    id: `e_bulk_${i}`, name: `员工${i}`, duty: "x".repeat(300),
  }));
  const bulk = setup(t, many);
  const bounded = expectCompleted(await invoke(bulk.deps, "employee.search", {}));
  assert.equal(bounded.totalMatched, 100);
  assert.equal(bounded.matches.length, 20);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.matches[0]?.duty.length, 200, "长职责投影截断");
  const limited = expectCompleted(await invoke(bulk.deps, "employee.search", { limit: 5 }));
  assert.equal(limited.matches.length, 5);
  bulk.dir.assertUnchanged();
});

test("IM-07 A3: 目录条目带 schemaVersion、说明与真实可用状态；未注册写操作不可调用", async (t) => {
  const { deps } = setup(t);
  const catalog = describePlatformCatalog(makeActor(), deps);
  assert.equal(catalog.schemaVersion, PLATFORM_ACTION_SCHEMA_VERSION);
  assert.equal(catalog.entries.length, 1);
  const entry = catalog.entries[0];
  assert.equal(entry.name, "employee.search");
  assert.equal(entry.schemaVersion, PLATFORM_ACTION_SCHEMA_VERSION);
  assert.ok(entry.summary.length > 0);
  assert.equal(entry.available, true);
  assert.equal(entry.kind, "read");
  assert.equal(entry.chargesModel, false);
  assert.equal(catalog.entries.some((e) => e.name.startsWith("conversation.") || e.name.startsWith("task.")), false);

  const registry = new PlatformActionRegistry();
  assert.throws(() => registry.register({ ...EMPLOYEE_SEARCH_DEFINITION, requiresConfirmation: true }),
    /只读/);
  assert.throws(() => registry.register({ ...EMPLOYEE_SEARCH_DEFINITION, chargesModel: true }), /只读/);
  assert.throws(() => registry.register({
    ...EMPLOYEE_SEARCH_DEFINITION, name: "employee.create", kind: "write", requiresConfirmation: false,
  }), /必须 requiresConfirmation/);
  assert.throws(() => registry.register({ ...EMPLOYEE_SEARCH_DEFINITION,
    inputSchema: { ...EMPLOYEE_SEARCH_DEFINITION.inputSchema, additionalProperties: true as never } }),
    /additionalProperties/);
});

test("IM-07 A4: 身份与授权不从 input 字段推导，只认 ActorContext", async (t) => {
  const { deps } = setup(t);
  const spoof = { employeeId: "e_hr", role: "admin", approved: true, actorKind: "host", grantedScopes: [SEARCH_SCOPE] };
  expectRejected(await invoke(deps, "employee.search", spoof,
    makeActor({ grantedScopes: [], employeeId: null })), "scope_denied");
  expectRejected(await invoke(deps, "employee.search", { query: "ok", approved: true }), "unknown_field", "approved");
  const output = expectCompleted(await invoke(deps, "employee.search", { query: "小林" }));
  assert.equal(output.matches.length, 2);
});

test("IM-07 A5: CodeMode 与普通调用共用同一校验/执行函数", async (t) => {
  const { deps } = setup(t);
  const codemode = makeActor({ actorKind: "codemode" });
  const normal = makeActor({ actorKind: "employee_session" });
  const badInput = { limit: "10" };
  const cmError = expectRejected(await invoke(deps, "employee.search", badInput, codemode), "invalid_type", "limit");
  const normalError = expectRejected(await invoke(deps, "employee.search", badInput, normal), "invalid_type", "limit");
  assert.deepEqual(cmError, normalError, "同一校验产出同一错误");
  const cmDenied = expectRejected(await invoke(deps, "employee.search", {},
    makeActor({ actorKind: "codemode", grantedScopes: [] })), "scope_denied");
  assert.ok(cmDenied);
  const cmOutput = expectCompleted(await invoke(deps, "employee.search", { query: "招聘" }, codemode));
  assert.deepEqual(cmOutput.matches.map((m) => m.employeeId), ["e_hr"]);
});

test("IM-07: 目录合同与真实 WandStorage 结构兼容（隔离临时库，默认排除归档）", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-platform-action-"));
  const storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const agent = [{ provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" }] as SiliconEmployee["agents"];
  const make = (id: string, name: string, duty: string): SiliconEmployee => ({
    id, name, duty, prompt: `私密人设-${name}`, avatar: "", agents: agent, tags: ["前端"],
    createdAt: now, updatedAt: now,
  });
  storage.saveSiliconEmployee(make("e_real_a", "阿查", "数据工程"));
  storage.saveSiliconEmployee(make("e_real_b", "阿查乙", "数据平台"));
  storage.saveSiliconEmployee(make("e_real_archived", "阿查丙", "数据归档"));
  storage.archiveSiliconEmployee("e_real_archived");

  const deps = createReadOnlyPlatformActionDeps(storage);
  const catalog = describePlatformCatalog(makeActor(), deps);
  assert.equal(catalog.entries.length, 1);
  return invokePlatformAction({ requestId: "req_real", action: "employee.search", input: { query: "阿查" } },
    makeActor(), deps).then((result) => {
      const output = expectCompleted(result);
      assert.deepEqual(output.matches.map((m) => m.employeeId), ["e_real_a", "e_real_b"]);
      assert.equal(output.matches[0]?.duty.includes("私密人设"), false);
      assert.deepEqual(output.matches[0]?.tags, ["前端"]);
    });
});
