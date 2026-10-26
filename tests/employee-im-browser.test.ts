import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";
import { EMPLOYEE_IM_EVENTS, EMPLOYEE_IM_EVENT_GROUPS, EMPLOYEE_IM_PRIMARY_EVENTS, EMPLOYEE_IM_MORE_EVENT_GROUPS } from "../src/employee-im-types.js";
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("employee IM settings use production fields in real Chrome, protect secrets, and isolate late acknowledgements", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 120_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-employee-im-browser-harness.mjs", { timeoutMs: 115_000 });
});
test("event routing groups contain every supported event exactly once", () => {
  const grouped = EMPLOYEE_IM_EVENT_GROUPS.flatMap(group => group.events);
  assert.equal(grouped.length, EMPLOYEE_IM_EVENTS.length);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual([...grouped].sort(), EMPLOYEE_IM_EVENTS.map(event => event.value).sort());
});
test("progressive disclosure preserves all events without duplicating primary choices", () => {
  const choices = [...EMPLOYEE_IM_PRIMARY_EVENTS, ...EMPLOYEE_IM_MORE_EVENT_GROUPS.flatMap(group => group.events)];
  assert.equal(EMPLOYEE_IM_PRIMARY_EVENTS.length, 6);
  assert.equal(choices.length, 13);
  assert.equal(new Set(choices).size, 13);
  assert.deepEqual(choices.slice().sort(), EMPLOYEE_IM_EVENTS.map(event => event.value).sort());
});
test("Mac and Web use the identical selectable IM event contract", t => {
  const file = new URL("../macos/Wand/EmployeeImModels.swift", import.meta.url);
  if (!existsSync(file)) { t.skip("macOS submodule not checked out"); return; }
  const swift = readFileSync(file, "utf8");
  const events = [...swift.matchAll(/\("([a-z_]+)", "([^"]+)"\)/g)].map(match => ({ value: match[1], label: match[2] }));
  assert.deepEqual(events, EMPLOYEE_IM_EVENTS);
  const primary = swift.match(/let employeeImPrimaryEvents = \[([^\]]+)\]/)?.[1] ?? "";
  assert.deepEqual([...primary.matchAll(/"([a-z_]+)"/g)].map(match => match[1]), EMPLOYEE_IM_PRIMARY_EVENTS);
});
