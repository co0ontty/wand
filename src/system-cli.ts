import type { WandCliApi } from "./cli-api.js";
import type { SessionSnapshot } from "./types.js";

type Api = Pick<WandCliApi, "get" | "post" | "patch">;
type Operation = (api: Api) => Promise<unknown>;
const MAX_INPUT_BYTES = 1024 * 1024;

async function jsonInput(input: AsyncIterable<string | Buffer>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new Error("系统操作 JSON 超过 1 MiB。");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要 JSON 对象。");
  return value as Record<string, unknown>;
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Error(`不支持字段：${key}`);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${field}。`);
  return value;
}

/** Parse before opening config/authentication; never retries mutations or accepts arbitrary API paths. */
export async function parseSystemCliCommand(
  command: string, args: string[], input: AsyncIterable<string | Buffer> = process.stdin,
): Promise<Operation> {
  const reads: Record<string, string> = {
    "employee:list": "/api/silicon-employees",
    "workspace:list": "/api/workspaces",
    "schedule:list": "/api/scheduled-tasks",
  };
  if (reads[command]) {
    const flag = command === "employee:list" ? "--include-archived" : command === "schedule:list" ? "--include-cancelled" : null;
    if (args.length && !(flag && args.length === 1 && args[0] === flag)) throw new Error(`用法：wand ${command}${flag ? ` [${flag}]` : ""}`);
    const query = args.length ? (command === "employee:list" ? "?includeArchived=1" : "?includeCancelled=1") : "";
    return api => api.get(reads[command]! + query);
  }
  if (command === "schedule:read") {
    if (args.length !== 1 || !args[0] || args[0].startsWith("-")) throw new Error("用法：wand schedule:read <id>");
    return api => api.get(`/api/scheduled-tasks/${encodeURIComponent(args[0]!)}`);
  }
  const withId = command === "schedule:update" || command === "session:resume";
  const id = withId ? args[0] : undefined;
  if ((withId && (!id || id.startsWith("-"))) || args.length !== (withId ? 2 : 1) || args.at(-1) !== "--stdin") {
    throw new Error(`用法：wand ${command}${withId ? " <id>" : ""} --stdin`);
  }
  const body = await jsonInput(input);
  if (command === "session:create") {
    fields(body, ["employeeId", "workspaceId", "cwd", "prompt"]);
    requiredText(body.employeeId, "employeeId（先查询员工列表）");
    // Employee's configured provider, model, role and permissions remain authoritative.
    return api => api.post("/api/structured-sessions", { ...body, respondImmediately: true });
  }
  if (command === "schedule:create") {
    fields(body, ["requestId", "employeeId", "workspaceId", "title", "prompt", "schedule"]);
    requiredText(body.requestId, "requestId（保存后复用，不要重建）");
    requiredText(body.employeeId, "employeeId");
    requiredText(body.prompt, "prompt");
    return api => api.post("/api/scheduled-tasks", body);
  }
  if (command === "schedule:update") {
    fields(body, ["revision", "employeeId", "workspaceId", "title", "prompt", "schedule", "enabled", "cancelled"]);
    if (!Number.isInteger(body.revision) || Number(body.revision) < 1) throw new Error("需要当前 revision。");
    return api => api.patch(`/api/scheduled-tasks/${encodeURIComponent(id!)}`, body);
  }
  if (command === "session:resume") {
    fields(body, ["input"]);
    requiredText(body.input, "input（检查证据及明确的续接要求）");
    return async api => {
      const route = `/api/sessions/${encodeURIComponent(id!)}`;
      const snapshot = await api.get<SessionSnapshot>(route);
      if (snapshot.id !== id) throw new Error("会话 ID 不匹配，未续接。");
      if (snapshot.structuredState?.inFlight || snapshot.ptyCommandRunning || snapshot.ptyBusy
        || snapshot.permissionBlocked || snapshot.pendingEscalation || snapshot.queuedMessages?.length) {
        throw new Error("目标会话仍在执行、等待审批或有排队消息；未打断或重复唤起，请核对。");
      }
      if (snapshot.sessionKind !== "structured") {
        throw new Error("此入口仅续接 Wand 结构化会话；PTY 请通过原终端恢复，不能冒充已恢复。");
      }
      if (snapshot.archived) await api.post(`${route}/unarchive`, {});
      // Managed structured sessions resume their native history through the existing input owner.
      return api.post(`${route}/input`, { input: body.input, respondImmediately: true });
    };
  }
  throw new Error("未知系统操作。");
}
