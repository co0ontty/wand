/**
 * 平台动作类型合同（IM-07）。
 * 合同全文见 output/im-huajie-implementation-20261006/results/07/CONTRACT.md；
 * 08/09/10/12/13 复用这里的类型与错误码，不再另定义平行信封。
 */

/** 动作信封与定义共用的 schema 版本。 */
export const PLATFORM_ACTION_SCHEMA_VERSION = 1;

export type PlatformActionGroup = "people" | "chat" | "task";
export type PlatformActionKind = "read" | "write" | "execute";

export interface StrictObjectSchema {
  type: "object";
  properties: Record<string, StrictInputSchemaNode>;
  required?: string[];
  additionalProperties: false;
}

export type StrictInputSchemaNode =
  | StrictObjectSchema
  | { type: "string"; minLength?: number; maxLength?: number; enum?: readonly string[] }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "array"; items: StrictInputSchemaNode; maxItems?: number };

export interface PlatformActionDefinition {
  name: string;
  schemaVersion: number;
  summary: string;
  group: PlatformActionGroup;
  kind: PlatformActionKind;
  /** read 必须 false；write/execute 必须 true。注册时强制。 */
  requiresConfirmation: boolean;
  /** 是否可能触发模型调用；read 必须 false。 */
  chargesModel: boolean;
  /** 全部授予才可调用；当前约定 scope 字符串与动作名一致。 */
  scopes: readonly string[];
  inputSchema: StrictObjectSchema;
}

export type PlatformActorKind = "employee_session" | "conversation_member" | "codemode" | "host";

/**
 * 调用者身份与授权只由可信宿主构造；request.input 里的任何同名字段不参与推导，
 * 且会被严格输入 schema 作为 unknown_field 拒绝。
 */
export interface PlatformActorContext {
  actorKind: PlatformActorKind;
  /** 可信绑定到的调用员工；null = 无员工身份，不因此获得或失去任何 scope。 */
  employeeId: string | null;
  sessionId: string | null;
  conversationId: string | null;
  /** 用户权限 ∩ 本次委托 ∩ 引擎/资源限制；空数组 = 无权限，不默认管理员。 */
  grantedScopes: readonly string[];
}

export interface PlatformActionRequest {
  /** ≤128 字符、[A-Za-z0-9._:-]；write 动作按 requestId+fingerprint 幂等（08）。 */
  requestId: string;
  action: string;
  input?: unknown;
}

export type PlatformActionErrorCode =
  | "invalid_request"
  | "unknown_action"
  | "scope_denied"
  | "action_unavailable"
  | "unknown_field"
  | "missing_required_field"
  | "invalid_type"
  | "invalid_value"
  | "internal_error";

export interface PlatformActionError {
  code: PlatformActionErrorCode;
  message: string;
  field?: string;
}

export interface PlatformActionCompleted {
  requestId: string;
  action: string;
  schemaVersion: number;
  state: "completed";
  output: unknown;
}

export interface PlatformActionRejected {
  requestId: string;
  action: string;
  schemaVersion: number;
  state: "rejected";
  error: PlatformActionError;
}

/**
 * 只读动作同步产出 completed；write 动作（08+）扩展 needs_confirmation/accepted/
 * unconfirmed，与 ConversationReceipt 的映射见 CONTRACT.md §5。
 */
export type PlatformActionResult = PlatformActionCompleted | PlatformActionRejected;

export interface PlatformActionCatalogEntry {
  name: string;
  schemaVersion: number;
  summary: string;
  group: PlatformActionGroup;
  kind: PlatformActionKind;
  requiresConfirmation: boolean;
  chargesModel: boolean;
  scopes: readonly string[];
  inputSchema: StrictObjectSchema;
  /** 目录只列真实已注册且已授予的动作；未注册动作永远不会以可调用出现。 */
  available: true;
}

export interface PlatformActionCatalog {
  schemaVersion: number;
  entries: PlatformActionCatalogEntry[];
  note: string;
}

export interface EmployeeSearchMatch {
  employeeId: string;
  name: string;
  duty: string;
  tags: string[];
  builtin: boolean;
  availability: "available" | "unconfigured";
}

export interface EmployeeSearchOutput {
  schemaVersion: number;
  matches: EmployeeSearchMatch[];
  /** 截断前命中数。 */
  totalMatched: number;
  truncated: boolean;
  /** matches 内出现 ≥2 次的名字，供上层追问选择。 */
  duplicateNames: string[];
}
