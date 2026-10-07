/**
 * 只读平台动作服务（IM-07）：能力目录发现 + employee.search 唯一注册动作。
 * 本模块不接 HTTP/CLI；09/10 的适配器必须调用这里的同一函数。
 * 身份与授权只来自 PlatformActorContext（可信宿主传入），input 永不参与推导。
 */
import { isBuiltinSiliconEmployee, siliconEmployeeTags } from "./ai-team-types.js";
import { getErrorMessage } from "./error-utils.js";
import {
  EMPLOYEE_SEARCH_DEFINITION,
  PlatformActionRegistry,
  validateActionInput,
  type ActionInput,
} from "./platform-action-catalog.js";
import {
  PLATFORM_ACTION_SCHEMA_VERSION,
  type EmployeeSearchMatch,
  type EmployeeSearchOutput,
  type PlatformActionCatalog,
  type PlatformActionCatalogEntry,
  type PlatformActionDefinition,
  type PlatformActionError,
  type PlatformActorContext,
  type PlatformActionRequest,
  type PlatformActionResult,
} from "./platform-action-types.js";

export const EMPLOYEE_SEARCH_SCOPE = EMPLOYEE_SEARCH_DEFINITION.scopes[0];

/** 员工目录的只读投影端口；结构上由 WandStorage.listSiliconEmployees 满足。 */
export interface EmployeeDirectoryRecord {
  id: string;
  name: string;
  duty: string;
  tags?: string[];
  systemKey?: string;
  archivedAt?: string;
  agents: readonly unknown[];
}

export interface EmployeeDirectoryPort {
  listSiliconEmployees(options?: { includeArchived?: boolean }): EmployeeDirectoryRecord[];
}

export interface PlatformActionExecContext {
  actor: PlatformActorContext;
  deps: PlatformActionDeps;
}

export interface PlatformActionDeps {
  employees: EmployeeDirectoryPort;
  registry: PlatformActionRegistry;
}

const EMPLOYEE_SEARCH_DEFAULT_LIMIT = 20;
const EMPLOYEE_NAME_MAX_CHARS = 80;
const EMPLOYEE_DUTY_MAX_CHARS = 200;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function fail(code: PlatformActionError["code"], message: string, field?: string): PlatformActionError {
  return field === undefined ? { code, message } : { code, message, field };
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function executeEmployeeSearch(input: ActionInput, ctx: PlatformActionExecContext): EmployeeSearchOutput {
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const limit = typeof input.limit === "number" ? input.limit : EMPLOYEE_SEARCH_DEFAULT_LIMIT;
  // 默认口径即排除归档；不读取 prompt、知识与任何私人内容。
  const records = ctx.deps.employees.listSiliconEmployees();
  const matched: EmployeeDirectoryRecord[] = [];
  for (const record of records) {
    if (!query) { matched.push(record); continue; }
    const tags = siliconEmployeeTags(record).map((tag) => tag.toLowerCase());
    const haystack = [record.name.toLowerCase(), record.duty.toLowerCase(), ...tags];
    if (haystack.some((part) => part.includes(query))) matched.push(record);
  }
  const limited = matched.slice(0, limit);
  const matches: EmployeeSearchMatch[] = limited.map((record) => ({
    employeeId: record.id,
    name: truncate(record.name, EMPLOYEE_NAME_MAX_CHARS),
    duty: truncate(record.duty, EMPLOYEE_DUTY_MAX_CHARS),
    tags: [...siliconEmployeeTags(record)],
    builtin: isBuiltinSiliconEmployee(record),
    availability: record.agents.length > 0 ? "available" : "unconfigured",
  }));
  const nameCounts = new Map<string, number>();
  for (const match of matches) nameCounts.set(match.name, (nameCounts.get(match.name) ?? 0) + 1);
  return {
    schemaVersion: PLATFORM_ACTION_SCHEMA_VERSION,
    matches,
    totalMatched: matched.length,
    truncated: matched.length > limited.length,
    duplicateNames: [...nameCounts.entries()].filter(([, count]) => count >= 2).map(([name]) => name),
  };
}

/** 已注册但此处未接线执行器的动作一律 action_unavailable，不冒充可调用。 */
const READ_ONLY_EXECUTORS: Record<string, (input: ActionInput, ctx: PlatformActionExecContext) => unknown> = {
  [EMPLOYEE_SEARCH_DEFINITION.name]: executeEmployeeSearch,
};

export function createReadOnlyPlatformActionDeps(employees: EmployeeDirectoryPort): PlatformActionDeps {
  const registry = new PlatformActionRegistry();
  registry.register(EMPLOYEE_SEARCH_DEFINITION);
  return { employees, registry };
}

function hasAllScopes(definition: PlatformActionDefinition, grantedScopes: readonly string[]): boolean {
  const granted = new Set(grantedScopes);
  return definition.scopes.every((scope) => granted.has(scope));
}

/**
 * 两阶段发现的目录视图：只返回“本作用域真实已注册且已授予”的动作。
 * 空权限得到空目录，而不是默认管理员视角；未注册写动作永不出现在这里。
 */
export function describePlatformCatalog(
  actor: PlatformActorContext,
  deps: PlatformActionDeps,
): PlatformActionCatalog {
  const entries: PlatformActionCatalogEntry[] = deps.registry
    .list()
    .filter((definition) => hasAllScopes(definition, actor.grantedScopes))
    .map((definition) => ({
      name: definition.name,
      schemaVersion: definition.schemaVersion,
      summary: definition.summary,
      group: definition.group,
      kind: definition.kind,
      requiresConfirmation: definition.requiresConfirmation,
      chargesModel: definition.chargesModel,
      scopes: [...definition.scopes],
      inputSchema: definition.inputSchema,
      available: true,
    }));
  return {
    schemaVersion: PLATFORM_ACTION_SCHEMA_VERSION,
    entries,
    note: "目录仅列出当前授权下真实可调用的已注册动作；未列出的动作（包括任何写操作）不可调用。",
  };
}

/**
 * 唯一校验+执行入口。CodeMode 脚本、原生工具、CLI、HTTP 适配器共用本函数，
 * 不得另造绕过 validateActionInput/scope 检查的执行通路。
 */
export function invokePlatformAction(
  request: PlatformActionRequest,
  actor: PlatformActorContext,
  deps: PlatformActionDeps,
): Promise<PlatformActionResult> {
  const envelope = (schemaVersion: number) => ({
    requestId: typeof request?.requestId === "string" ? request.requestId : "",
    action: typeof request?.action === "string" ? request.action : "",
    schemaVersion,
  });
  const rejected = (error: PlatformActionError, definition: PlatformActionDefinition | null) =>
    Promise.resolve({ ...envelope(definition?.schemaVersion ?? PLATFORM_ACTION_SCHEMA_VERSION), state: "rejected" as const, error });

  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return rejected(fail("invalid_request", "动作请求必须是 JSON 对象。"), null);
  }
  if (typeof request.requestId !== "string" || !REQUEST_ID_RE.test(request.requestId)) {
    return rejected(fail("invalid_request", "requestId 必须是非空、不超过 128 字符的稳定标识。", "requestId"), null);
  }
  if (typeof request.action !== "string") {
    return rejected(fail("invalid_request", "action 必须是字符串。", "action"), null);
  }
  const definition = deps.registry.get(request.action);
  if (!definition) {
    return rejected(fail("unknown_action", `动作 ${request.action} 未注册，当前不可调用。`, "action"), null);
  }
  if (!hasAllScopes(definition, actor.grantedScopes)) {
    return rejected(fail("scope_denied", `当前授权缺少动作 ${definition.name} 所需 scope。`), definition);
  }
  const validated = validateActionInput(definition, request.input);
  if (!validated.ok || !validated.value) {
    return rejected(validated.error ?? fail("invalid_request", "动作输入校验失败。"), definition);
  }
  const executor = READ_ONLY_EXECUTORS[definition.name];
  if (!executor) {
    return rejected(fail("action_unavailable", `动作 ${definition.name} 已注册但当前作用域未启用。`), definition);
  }
  try {
    const output = executor(validated.value, { actor, deps });
    return Promise.resolve({ ...envelope(definition.schemaVersion), state: "completed" as const, output });
  } catch (error) {
    return rejected(fail("internal_error", `动作 ${definition.name} 执行失败：${getErrorMessage(error)}`), definition);
  }
}
