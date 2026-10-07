/**
 * 平台动作注册表与严格输入校验（IM-07）。
 * validateActionInput 是所有调用方（HTTP/CLI/原生工具/CodeMode）共用的唯一校验入口；
 * 任何适配器都不得绕过 invokePlatformAction 另造执行通路。
 */
import {
  PLATFORM_ACTION_SCHEMA_VERSION,
  type PlatformActionDefinition,
  type PlatformActionError,
  type StrictInputSchemaNode,
  type StrictObjectSchema,
} from "./platform-action-types.js";

const ACTION_NAME_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

export class PlatformActionRegistry {
  private readonly definitions = new Map<string, PlatformActionDefinition>();

  /** 定义与自身安全属性矛盾时抛错，防止元数据谎报“只读/免费”。 */
  register(definition: PlatformActionDefinition): void {
    if (!ACTION_NAME_RE.test(definition.name)) throw new Error(`动作名不合法: ${definition.name}`);
    if (definition.schemaVersion < 1) throw new Error(`动作 ${definition.name} 缺少有效 schemaVersion`);
    if (!definition.summary.trim()) throw new Error(`动作 ${definition.name} 缺少说明`);
    if (definition.scopes.length === 0) throw new Error(`动作 ${definition.name} 必须声明所需 scope`);
    if (definition.inputSchema.type !== "object" || definition.inputSchema.additionalProperties !== false) {
      throw new Error(`动作 ${definition.name} 的输入 schema 必须 additionalProperties:false`);
    }
    if (definition.kind === "read" && (definition.requiresConfirmation || definition.chargesModel)) {
      throw new Error(`只读动作 ${definition.name} 不得声明确认或模型费用`);
    }
    if (definition.kind !== "read" && !definition.requiresConfirmation) {
      throw new Error(`写/执行动作 ${definition.name} 必须 requiresConfirmation`);
    }
    if (this.definitions.has(definition.name)) throw new Error(`动作重复注册: ${definition.name}`);
    this.definitions.set(definition.name, definition);
  }

  get(name: string): PlatformActionDefinition | null {
    return this.definitions.get(name) ?? null;
  }

  has(name: string): boolean { return this.definitions.has(name); }

  list(): PlatformActionDefinition[] { return [...this.definitions.values()]; }
}

export type ActionInput = Record<string, unknown>;

export interface ValidatedActionInput {
  ok: boolean;
  value?: ActionInput;
  error?: PlatformActionError;
}

function err(code: PlatformActionError["code"], message: string, field?: string): PlatformActionError {
  return field === undefined ? { code, message } : { code, message, field };
}

function validateNode(schema: StrictInputSchemaNode, value: unknown, field: string): PlatformActionError | null {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return err("invalid_type", `字段 ${field || "input"} 必须是对象。`, field || undefined);
      }
      const record = value as Record<string, unknown>;
      for (const required of schema.required ?? []) {
        if (!(required in record)) return err("missing_required_field", `缺少必填字段 ${required}。`, required);
      }
      for (const key of Object.keys(record)) {
        if (!(key in schema.properties)) return err("unknown_field", `参数字段 ${key} 未定义，已拒绝。`, key);
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!(key in record)) continue;
        const childField = field ? `${field}.${key}` : key;
        const failure = validateNode(child, record[key], childField);
        if (failure) return failure;
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return err("invalid_type", `字段 ${field} 必须是文字。`, field);
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return err("invalid_value", `字段 ${field} 长度不足。`, field);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return err("invalid_value", `字段 ${field} 超出长度上限 ${schema.maxLength}。`, field);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return err("invalid_value", `字段 ${field} 不在允许的取值内。`, field);
      }
      return null;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return err("invalid_type", `字段 ${field} 必须是整数。`, field);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return err("invalid_value", `字段 ${field} 不能小于 ${schema.minimum}。`, field);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return err("invalid_value", `字段 ${field} 不能大于 ${schema.maximum}。`, field);
      }
      return null;
    }
    case "boolean": {
      return typeof value === "boolean" ? null : err("invalid_type", `字段 ${field} 必须是布尔值。`, field);
    }
    case "array": {
      if (!Array.isArray(value)) return err("invalid_type", `字段 ${field} 必须是数组。`, field);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return err("invalid_value", `字段 ${field} 条目数超过上限 ${schema.maxItems}。`, field);
      }
      for (let i = 0; i < value.length; i++) {
        const failure = validateNode(schema.items, value[i], `${field}[${i}]`);
        if (failure) return failure;
      }
      return null;
    }
  }
}

/** 根输入必须是普通 JSON 对象；未知键、缺失必填、类型/取值错误逐层拒绝。 */
export function validateActionInput(definition: PlatformActionDefinition, input: unknown): ValidatedActionInput {
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
    return { ok: false, error: err("invalid_request", "动作输入必须是 JSON 对象。") };
  }
  const value = (input ?? {}) as ActionInput;
  const failure = validateNode(definition.inputSchema as StrictObjectSchema, value, "");
  if (failure) return { ok: false, error: failure };
  return { ok: true, value };
}

export const EMPLOYEE_SEARCH_INPUT_SCHEMA: StrictObjectSchema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 120 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  },
  required: [],
  additionalProperties: false,
};

export const EMPLOYEE_SEARCH_DEFINITION: PlatformActionDefinition = {
  name: "employee.search",
  schemaVersion: PLATFORM_ACTION_SCHEMA_VERSION,
  summary: "按名字、职责、标签只读检索公开员工目录；不读取私人知识与私聊。",
  group: "people",
  kind: "read",
  requiresConfirmation: false,
  chargesModel: false,
  scopes: ["employee.search"],
  inputSchema: EMPLOYEE_SEARCH_INPUT_SCHEMA,
};
