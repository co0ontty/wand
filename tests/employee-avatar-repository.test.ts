import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function fixture() {
  const requests: Array<{ path: string; init?: RequestInit; resolve(payload: unknown): void }> = [];
  const exports: Record<string, any> = {};
  const snapshotExports: Record<string, any> = {};
  const snapshotSource = readFileSync(new URL("../src/web-ui/query-snapshot.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(snapshotSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: snapshotExports });
  const source = readFileSync(new URL("../src/web-ui/react/agents/employee-repository.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require(id: string) {
    if (id.includes("query-snapshot")) return snapshotExports;
    if (id.includes("http-adapter")) return { requestJson: (path: string, init?: RequestInit) => new Promise(resolve => requests.push({ path, init, resolve })) };
    return {};
  } });
  return { requests, ...exports };
}

test("definition changes invalidate the shared employee snapshot and reject stale in-flight publication", async () => {
  const store = fixture(); const changes: Array<string | undefined> = [];
  const unsubscribe = store.subscribeSiliconEmployeeDefinitionChanges((id?: string) => changes.push(id));
  const old = store.siliconEmployeesRepository.list(); assert.equal(store.requests.length, 1);
  assert.equal(store.requests[0].init?.cache, "no-store");
  store.notifySiliconEmployeeDefinitionChanged();
  const fresh = store.siliconEmployeesRepository.list(); assert.equal(store.requests.length, 2);
  const current = { id: "e_same", name: "同一个员工", avatar: "plush-cat:v1:orange" };
  store.requests[1].resolve({ employees: [current] }); await fresh;
  store.requests[0].resolve({ employees: [{ ...current, avatar: "" }] }); await old;
  assert.equal(store.cachedSiliconEmployee(current.id).avatar, current.avatar);
  await store.siliconEmployeesRepository.list(); assert.equal(store.requests.length, 2, "all consumers share the refreshed list");
  store.notifySiliconEmployeeDefinitionChanged(current.id);
  assert.equal(store.cachedSiliconEmployee(current.id), null);
  assert.deepEqual(changes, [undefined, current.id]); unsubscribe();
  const detail = store.siliconEmployeesRepository.get(current.id);
  assert.equal(store.requests[2].init?.cache, "no-store", "pending GETs cannot coalesce an obsolete profile read");
  store.requests[2].resolve(current); await detail;
});

test("the live WebSocket recovery and open profile use the same employee invalidation owner", () => {
  const socket = readFileSync(new URL("../src/web-ui/browser/websocket.ts", import.meta.url), "utf8");
  const profile = readFileSync(new URL("../src/web-ui/react/agents/employee-profile.tsx", import.meta.url), "utf8");
  // Boot HTTP reads are authoritative; only a reconnect may invalidate and resync.
  assert.match(socket, /ws\.onopen = function\(\) \{[\s\S]*?if \(hasOpenedSocket\) \{[\s\S]*?notifySiliconEmployeeDefinitionChanged\(\);/);
  assert.match(socket, /hasOpenedSocket = true;/);
  assert.match(profile, /subscribeSiliconEmployeeDefinitionChanges/);
  assert.match(profile, /employeeId === undefined \|\| employeeId === profile\.id/);
});
