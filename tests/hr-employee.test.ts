import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig, loadConfigWithStorage } from "../src/config.js";
import { isBuiltinSiliconEmployee, siliconEmployeeTags } from "../src/ai-team-types.js";
import { hrEmployeeDefinition } from "../src/hr-employee.js";
import { HR_EMPLOYEE_ID, HR_EMPLOYEE_KEY, HR_EMPLOYEE_AVATAR } from "../src/hr-employee-identity.js";
import { employeeDraftAiOptions } from "../src/server-employee-routes.js";
import { encodePlushDogAvatar, parsePlushDogAvatar, resolveEmployeeAvatar } from "../src/plush-avatar.js";
import { WandStorage } from "../src/storage.js";

test("HR is seeded as locked 嘟嘟, keeps independent ordered candidates across restart", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-hr-")), storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  await loadConfigWithStorage(join(root, "config.json"), storage);
  const role = storage.getSystemSiliconEmployee(HR_EMPLOYEE_KEY)!;
  assert.equal(role.id, HR_EMPLOYEE_ID); assert.equal(role.name, "嘟嘟"); assert.equal(role.avatar, HR_EMPLOYEE_AVATAR);
  assert.equal(isBuiltinSiliconEmployee(role), true); assert.deepEqual(siliconEmployeeTags(role), ["系统用户"]);
  assert.deepEqual(role.agents, storage.getSystemSiliconEmployee()!.agents);
  const agents = [{ provider: "pi" as const, engine: "sdk" as const, model: "user-selected", thinkingEffort: "off" as const, mode: "default" as const, kind: "structured" as const }];
  storage.saveSiliconEmployee({ ...role, agents });
  await loadConfigWithStorage(join(root, "config.json"), storage);
  assert.deepEqual(storage.getSystemSiliconEmployee(HR_EMPLOYEE_KEY)!.agents, agents);
  const before = storage.getSiliconEmployeeDefinition(role.id);
  storage.ensureHrEmployee(); assert.deepEqual(storage.getSiliconEmployeeDefinition(role.id), before);
  const ai = employeeDraftAiOptions(storage, defaultConfig());
  assert.deepEqual(ai.cliCandidates?.map(c => [c.provider, c.engine, c.model]), [["pi", "sdk", "user-selected"]]);
  assert.equal(ai.opsPersona, role.prompt); assert.equal(ai.employeeChannelOnly, true);
  assert.ok(ai.employeeText, "SDK uses the existing employee text harness");
  assert.notEqual(ai.opsPersona, storage.getSystemSiliconEmployee()!.prompt);
});

test("recruitment never silently falls back to ops when HR is absent or has no candidates", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-hr-missing-")), storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  storage.ensureSystemSiliconEmployee();
  assert.throws(() => employeeDraftAiOptions(storage, defaultConfig()), /HR.*未初始化/);
  const hr = hrEmployeeDefinition("now");
  storage.saveSiliconEmployee({ ...hr, agents: [] });
  const ai = employeeDraftAiOptions(storage, defaultConfig());
  assert.equal(ai.employeeChannelOnly, true); assert.equal(ai.cliCandidates, undefined);
});

test("Shiba avatar has a versioned red scarf contract; same names never select its identity", () => {
  const config = parsePlushDogAvatar(HR_EMPLOYEE_AVATAR)!;
  assert.deepEqual(config, { version: 1, kind: "dog", breed: "shiba", scarf: "red" });
  assert.equal(encodePlushDogAvatar(config), HR_EMPLOYEE_AVATAR);
  assert.deepEqual(resolveEmployeeAvatar(hrEmployeeDefinition("now")), config);
  assert.notDeepEqual(resolveEmployeeAvatar({ id: "ordinary", name: "嘟嘟" }), config);
  for (const value of ["plush-dog:v2:shiba:red-scarf", "plush-dog:v1:shiba:blue-scarf", "plush-dog:v1:cat:red-scarf"]) assert.equal(parsePlushDogAvatar(value), null);
});
