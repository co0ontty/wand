import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";

import {
  DEFAULT_EMPLOYEE_TAG, SYSTEM_EMPLOYEE_TAG,
  parseSiliconEmployeeTagInput, parseSiliconEmployeeTags, siliconEmployeeTags,
  type SiliconEmployee,
} from "../src/ai-team-types.js";
import { parseSiliconEmployeeInput, registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { WandStorage } from "../src/storage.js";

const AGENT = { provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
const NOW = "2026-10-02T00:00:00.000Z";
const input = { name: "测试员工", duty: "测试", prompt: "保留规则", avatar: "", agents: [AGENT] };

function withStorage(run: (storage: WandStorage) => void): void {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-tags-"));
  const storage = new WandStorage(join(root, "wand.db"));
  try { run(storage); }
  finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
}

test("员工自定义标签：规范空白、去重、保序，表单支持中英文分隔符", () => {
  assert.deepEqual(parseSiliconEmployeeTags([" 开发 ", "", "测试", "开发", "Équipe"]), ["开发", "测试", "Équipe"]);
  assert.deepEqual(parseSiliconEmployeeTagInput(" 开发，测试、设计\n开发,Équipe"), ["开发", "测试", "设计", "Équipe"]);
  assert.deepEqual(parseSiliconEmployeeTagInput(""), []);
  for (const value of [null, "开发", {}, [1], ["x".repeat(21)], Array.from({ length: 9 }, (_, i) => `标签${i}`), ["a,b"], ["a\tb"]]) {
    assert.throws(() => parseSiliconEmployeeTags(value), /标签/);
  }
  for (const tag of [SYSTEM_EMPLOYEE_TAG, DEFAULT_EMPLOYEE_TAG]) {
    assert.throws(() => parseSiliconEmployeeTags([` ${tag} `]), /内置标签/);
  }
  assert.equal(parseSiliconEmployeeTags(Array.from({ length: 8 }, (_, i) => `标签${i}`)).length, 8);
  assert.deepEqual(parseSiliconEmployeeTags(["x".repeat(20)]), ["x".repeat(20)]);
});

test("旧客户端省略标签保留已有值，显式空数组清空；内置身份不能被标签冒充", () => {
  const employee = parseSiliconEmployeeInput({ ...input, tags: ["开发", "测试"] }, null, NOW);
  assert.deepEqual(employee.tags, ["开发", "测试"]);
  assert.deepEqual(parseSiliconEmployeeInput(input, employee, NOW).tags, employee.tags);
  assert.deepEqual(parseSiliconEmployeeInput({ ...input, tags: [] }, employee, NOW).tags, []);
  assert.deepEqual(parseSiliconEmployeeInput(input, null, NOW).tags, []);
  assert.throws(() => parseSiliconEmployeeInput({ ...input, tags: null }, employee, NOW), /标签必须是数组/);
  const spoof = parseSiliconEmployeeInput({ ...input, systemKey: "wand-ops" }, null, NOW);
  assert.equal(spoof.systemKey, undefined);
  assert.deepEqual(siliconEmployeeTags(spoof), []);
  assert.deepEqual(siliconEmployeeTags({ systemKey: "wand-ops", tags: ["被改的标签"] }), ["系统用户"]);
  assert.deepEqual(siliconEmployeeTags({ systemKey: "wand-default", tags: [] }), ["默认用户"]);
});

test("员工标签随存储、归档和重启保留；内置标签由身份固定投影", () => {
  withStorage((storage) => {
    const employee = parseSiliconEmployeeInput({ ...input, tags: ["开发"] }, null, NOW);
    storage.saveSiliconEmployee(employee);
    storage.archiveSiliconEmployee(employee.id);
    assert.deepEqual(storage.listSiliconEmployees({ includeArchived: true })[0]?.tags, ["开发"]);
    storage.unarchiveSiliconEmployee(employee.id);
    assert.deepEqual(storage.getSiliconEmployee(employee.id)?.tags, ["开发"]);
    const system = storage.ensureSystemSiliconEmployee();
    const partner = storage.ensureDefaultSiliconEmployee();
    assert.deepEqual(system.tags, ["系统用户"]);
    assert.deepEqual(partner.tags, ["默认用户"]);
    storage.saveSiliconEmployee({ ...system, tags: ["假标签"] });
    storage.saveSiliconEmployee({ ...partner, tags: [] });
    assert.deepEqual(storage.getSystemSiliconEmployee()?.tags, ["系统用户"]);
    assert.deepEqual(storage.getDefaultSiliconEmployee()?.tags, ["默认用户"]);
    assert.throws(() => storage.saveSiliconEmployee({ ...employee, tags: [SYSTEM_EMPLOYEE_TAG] }), /内置标签/);
    assert.deepEqual(storage.getSiliconEmployee(employee.id)?.tags, ["开发"]);
  });
});

test("旧数据库只加标签列，不改员工定义与候选；重新打开后标签持久化", () => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-tags-migration-"));
  const path = join(root, "wand.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE silicon_employees (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, duty TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', agents_json TEXT NOT NULL,
    archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.prepare("INSERT INTO silicon_employees VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("e_old", input.name, input.duty, input.prompt, input.avatar, JSON.stringify([AGENT]), null, NOW, NOW);
  legacy.close();
  let storage = new WandStorage(path);
  try {
    const old = storage.getSiliconEmployee("e_old")!;
    assert.deepEqual(old.tags, []);
    assert.equal(old.prompt, input.prompt);
    assert.deepEqual(old.agents, [AGENT]);
    storage.saveSiliconEmployee({ ...old, tags: ["旧员工"] });
    storage.close();
    storage = new WandStorage(path);
    assert.deepEqual(storage.getSiliconEmployee("e_old")?.tags, ["旧员工"]);
    assert.equal(storage.getSiliconEmployee("e_old")?.createdAt, NOW);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test("员工标签 API：自定义 CRUD、旧客户端兼容、两类内置标签锁定", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-tags-http-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const changes: string[] = [];
  const system = storage.ensureSystemSiliconEmployee();
  const partner = storage.ensureDefaultSiliconEmployee();
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, { storage, notifyEmployeeChanged: (id) => changes.push(id) });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close(); rmSync(root, { recursive: true, force: true });
  });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as SiliconEmployee & { error: string; employees: SiliconEmployee[] } };
  };
  const created = await request("POST", "/api/silicon-employees", { ...input, tags: ["研发", "测试", "研发"] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.tags, ["研发", "测试"]);
  const route = `/api/silicon-employees/${created.body.id}`;
  const edited = await request("PUT", route, { ...input, tags: ["设计"] });
  assert.equal(edited.status, 200);
  assert.deepEqual((await request("GET", route)).body.tags, ["设计"]);
  assert.deepEqual((await request("PUT", route, input)).body.tags, ["设计"]);
  assert.deepEqual((await request("PUT", route, { ...input, tags: [] })).body.tags, []);
  const before = changes.length;
  for (const builtin of [system, partner]) {
    const builtinRoute = `/api/silicon-employees/${builtin.id}`;
    for (const tags of [[], ["自定义"], null, "系统用户", [builtin === system ? DEFAULT_EMPLOYEE_TAG : SYSTEM_EMPLOYEE_TAG]]) {
      const rejected = await request("PUT", builtinRoute, { agents: [AGENT], tags });
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /标签不可修改/);
      assert.deepEqual(storage.getSiliconEmployee(builtin.id)?.agents, builtin.agents);
    }
    assert.deepEqual((await request("GET", builtinRoute)).body.tags, siliconEmployeeTags(builtin));
  }
  for (const tag of [SYSTEM_EMPLOYEE_TAG, DEFAULT_EMPLOYEE_TAG]) {
    assert.equal((await request("POST", "/api/silicon-employees", { ...input, tags: [tag], systemKey: "wand-ops" })).status, 400);
    assert.equal((await request("PUT", route, { ...input, tags: [tag] })).status, 400);
  }
  assert.equal(changes.length, before, "拒绝写入不能发出定义变更通知");
  for (const builtin of [system, partner]) {
    const accepted = await request("PUT", `/api/silicon-employees/${builtin.id}`, { agents: [AGENT], tags: siliconEmployeeTags(builtin) });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body.tags, siliconEmployeeTags(builtin));
    assert.deepEqual(accepted.body.agents, [AGENT]);
  }
  const list = (await request("GET", "/api/silicon-employees")).body.employees;
  assert.deepEqual(list.find((employee) => employee.id === system.id)?.tags, ["系统用户"]);
  assert.deepEqual(list.find((employee) => employee.id === partner.id)?.tags, ["默认用户"]);
});
