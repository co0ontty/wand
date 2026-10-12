import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIXED_EMPLOYEE_AVATARS } from "../src/fixed-employee-avatar.js";
import { parsePlushCatAvatar, resolveEmployeeAvatar } from "../src/plush-avatar.js";
import { WandStorage } from "../src/storage.js";
import { registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { freezeTeamEmployees, projectTeamDefinition, projectTeamEmployees, requireTeamEmployee } from "../src/ai-team-employee-binding.js";
import { EmployeeAvatar } from "../src/web-ui/react/agents/employee-avatar.js";
import { EmployeeAvatarWorkspace } from "../src/web-ui/react/agents/employee-avatar-workspace.js";
import type { AiTeam } from "../src/ai-team-types.js";

const AGENT = { provider: "pi", engine: "sdk", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
const NOW = "2026-10-10T00:00:00.000Z";
function configs(markup: string): unknown[] {
  return [...markup.matchAll(/data-avatar-config="([^"]*)"/g)].map(match => JSON.parse(match[1]!.replace(/&quot;/g, '"')));
}
function legacyStorage(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "wand-avatar-consistency-"));
  const path = join(root, "wand.db");
  const storage = new WandStorage(path);
  storage.ensureDefaultSiliconEmployee(); storage.ensureSystemSiliconEmployee();
  const db = new DatabaseSync(path);
  for (const target of FIXED_EMPLOYEE_AVATARS) db.prepare("UPDATE silicon_employees SET avatar = ? WHERE id = ?").run("", target.id);
  db.close();
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  return storage;
}

test("stale fixed employee data renders the same avatar in summary and workspace without mutation", () => {
  for (const target of FIXED_EMPLOYEE_AVATARS) for (const avatar of ["", "legacy-value", "plush:v1:round:ochre:ink:beanie"]) {
    const identity = Object.freeze({ ...target, name: "用户自定义名字", avatar });
    const expected = parsePlushCatAvatar(target.avatar);
    assert.deepEqual(resolveEmployeeAvatar(identity), expected);
    const summary = configs(renderToStaticMarkup(createElement(EmployeeAvatar, { employee: identity, provider: "" })));
    const workspace = configs(renderToStaticMarkup(createElement(EmployeeAvatarWorkspace, { employee: identity, disabled: false, onChange() {} })));
    assert.deepEqual(summary, [expected]); assert.deepEqual(workspace, [expected]);
    assert.equal(identity.avatar, avatar);
  }
});

test("public employee reads, team projections and new execution bindings share the fixed avatar source without migrating storage", (t) => {
  const storage = legacyStorage(t);
  const saved = FIXED_EMPLOYEE_AVATARS.map(target => storage.getSiliconEmployeeDefinition(target.id));
  const team: AiTeam = { id: "team-avatar", name: "头像回归", description: "", maxSteps: 30, createdAt: NOW, updatedAt: NOW,
    members: FIXED_EMPLOYEE_AVATARS.map((target, index) => ({ id: "member-" + index, employeeId: target.id,
      name: "旧名字", avatar: "", duty: "团队职责", agents: [AGENT], agent: AGENT, isLeader: index === 0 })) };
  for (const target of FIXED_EMPLOYEE_AVATARS) {
    assert.equal(storage.getSiliconEmployee(target.id)?.avatar, target.avatar);
    assert.equal(storage.getSystemSiliconEmployee(target.systemKey)?.avatar, target.avatar);
    assert.equal(storage.listSiliconEmployees().find(e => e.id === target.id)?.avatar, target.avatar);
    assert.equal(requireTeamEmployee(storage, target.id).avatar, target.avatar);
  }
  for (const projection of [projectTeamDefinition, projectTeamEmployees, freezeTeamEmployees]) {
    assert.deepEqual(projection(team, storage).members.map(member => member.avatar), FIXED_EMPLOYEE_AVATARS.map(target => target.avatar));
  }
  assert.equal(storage.ensureDefaultSiliconEmployee().avatar, FIXED_EMPLOYEE_AVATARS[0].avatar);
  assert.equal(storage.ensureSystemSiliconEmployee().avatar, FIXED_EMPLOYEE_AVATARS[1].avatar);
  assert.deepEqual(FIXED_EMPLOYEE_AVATARS.map(target => storage.getSiliconEmployeeDefinition(target.id)), saved);
});

test("list/detail/save echoes use one uncached employee projection and canonical echoes do not overwrite legacy columns", async (t) => {
  const storage = legacyStorage(t);
  const app = express(); app.use(express.json()); registerSiliconEmployeeRoutes(app, { storage });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const listResponse = await fetch(base + "/api/silicon-employees");
  assert.match(listResponse.headers.get("cache-control") ?? "", /no-store/);
  const list = (await listResponse.json()).employees;
  for (const target of FIXED_EMPLOYEE_AVATARS) {
    const path = base + "/api/silicon-employees/" + target.id;
    const response = await fetch(path); const detail = await response.json();
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(detail.avatar, target.avatar);
    assert.equal(list.find((employee: { id: string }) => employee.id === target.id).avatar, detail.avatar);
    for (const avatar of [target.avatar, ""]) {
      const savedResponse = await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ avatar, name: "改名不换头像" }) });
      assert.equal(savedResponse.status, 200);
      assert.match(savedResponse.headers.get("cache-control") ?? "", /no-store/);
      assert.equal((await savedResponse.json()).avatar, target.avatar);
      assert.equal(storage.getSiliconEmployeeDefinition(target.id)?.avatar, "", "a display echo is not a migration");
    }
    const rejected = await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ avatar: "cat:0" }) });
    assert.equal(rejected.status, 400, "the shared source must not unlock a fixed avatar");
  }
});
