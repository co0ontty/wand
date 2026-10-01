// Development-only component harness: the real employee list + card for the built-in
// 「系统运维」employee, in headless Chrome. Not an installed-service acceptance test.
import * as React from "react";
import { createRoot } from "react-dom/client";
import { EmployeeListPage } from "../../src/web-ui/react/agents/employee-list-page";
import { useSiliconEmployees } from "../../src/web-ui/react/agents/employee-repository";
import { SystemAiOwnerSummary } from "../../src/web-ui/react/settings/system-ai-owner";
import { isSystemSiliconEmployee } from "../../src/ai-team-types";
import { aiTeamsChunkStyles } from "../../src/web-ui/react/ai-teams/styles";
import { installReactUiStyles, installStyleSheet } from "../../src/web-ui/react/styles";

installReactUiStyles();
installStyleSheet("harness-employee-styles", aiTeamsChunkStyles);

const CLAUDE = { provider: "claude", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" };
const GROK = { provider: "grok", model: "grok-4.5", thinkingEffort: "off", mode: "default", kind: "structured" };

const SYSTEM_EMPLOYEE = {
  id: "e_wand_ops",
  name: "勤劳的初二",
  duty: "Wand 系统运维：服务与 CLI 线路、更新分发、仓库与会话操作，Wand 自有 AI 任务的执行者。",
  prompt: "你是 Wand 的系统运维「勤劳的初二」。……",
  avatar: "",
  agents: [CLAUDE, GROK],
  systemKey: "wand-ops",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

const DEFAULT_EMPLOYEE = {
  ...SYSTEM_EMPLOYEE, id: "e_wand_default", systemKey: "wand-default", name: "默契的初一",
  duty: "默认任务伙伴", prompt: "默认伙伴基础规则与近期偏好。", agents: [CLAUDE],
};
let memory = { enabled: true, retentionDays: 30, eventCount: 3, features: [],
  profile: { generatedAt: Date.now(), expiresAt: Date.now() + 100_000,
    preferences: [{ category: "communication", text: "偏好先结论后证据", evidenceIds: [1] }] }, refreshing: false };

const USER_EMPLOYEE = {
  id: "e_user",
  name: "接口守夜人",
  duty: "守护线上接口稳定",
  prompt: "你是值守接口的工程师。",
  avatar: "cat:3",
  agents: [CLAUDE],
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

interface HarnessState {
  updates: Array<{ id: string; body: unknown }>;
  mutations: string[];
  memoryCalls: string[];
  knowledgeCalls: Array<{ method: string; employeeId: string }>;
}

const state: HarnessState = { updates: [], mutations: [], memoryCalls: [], knowledgeCalls: [] };
const knowledge: Record<string, string[]> = {
  e_wand_ops: ["系统运维的独立知识"], e_user: ["普通员工的独立知识"], e_wand_default: ["默认伙伴的独立知识"],
};
(window as unknown as { systemEmployeeHarness: HarnessState }).systemEmployeeHarness = state;

// 服务端意义上的当前定义：PUT 之后 GET 必须能读到新候选，
// 否则无法验证「员工页改完，设置页投影跟着变」。
let currentSystemEmployee: typeof SYSTEM_EMPLOYEE = { ...SYSTEM_EMPLOYEE };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.includes("/api/user-memory")) {
    state.memoryCalls.push(method);
    if (method !== "GET") await new Promise((resolve) => setTimeout(resolve, 100));
    if (method === "PATCH") memory = { ...memory, ...JSON.parse(String(init?.body)) };
    if (method === "DELETE") memory = { ...memory, eventCount: 0, profile: null! };
    return json({ ...memory, updated: method === "POST" });
  }
  if (url.includes("/knowledge")) {
    const employeeId = url.split("/api/silicon-employees/")[1].split("/")[0];
    state.knowledgeCalls.push({ method, employeeId });
    if (method === "DELETE") knowledge[employeeId] = [];
    const entries = (knowledge[employeeId] ?? []).map((content, index) => ({
      id: `k_fixture_${index}`, employeeId, content, createdAt: new Date().toISOString(),
    }));
    return json({ employeeId, entries, total: entries.length, maxEntries: 200 });
  }
  if (url.includes("/api/silicon-employees")) {
    if (method === "GET") return json({ employees: [currentSystemEmployee, USER_EMPLOYEE, DEFAULT_EMPLOYEE] });
    const id = decodeURIComponent(url.split("/api/silicon-employees/")[1]?.split("/")[0] ?? "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (/archive|unarchive/.test(url) || method !== "PUT") {
      state.mutations.push(`${method} ${url}`);
      return json({ ok: true });
    }
    state.updates.push({ id, body });
    currentSystemEmployee = { ...currentSystemEmployee, ...body, id };
    return json(currentSystemEmployee);
  }
  return realFetch(input, init);
};

/** 与设置页「系统 AI」同样的数据路径：员工定义一变，投影必须自己刷新。 */
function SettingsOwnerHarness(): React.ReactElement {
  const { employees } = useSiliconEmployees();
  const systemEmployee = employees.find((employee) => isSystemSiliconEmployee(employee)) ?? null;
  return (
    <section className="wand-settings-panel" aria-label="AI 与模型">
      <SystemAiOwnerSummary employee={systemEmployee} />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="wand-employees-layout">
    <SettingsOwnerHarness />
    <EmployeeListPage catalog={null} providerOptions={null} />
  </div>,
);
