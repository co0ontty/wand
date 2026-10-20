import type { WandTaskAgent } from "./task-types.js";
import { DECISION_EXPERT_KEY } from "./decision-expert-identity.js";
export { DECISION_EXPERT_KEY } from "./decision-expert-identity.js";
import { HR_EMPLOYEE_KEY } from "./hr-employee-identity.js";
export { HR_EMPLOYEE_KEY } from "./hr-employee-identity.js";

/** Employee contact entry; identity and execution choices are persisted independently of teams. */
export interface SiliconEmployee {
  id: string; // "e_<uuid>"
  name: string;
  duty: string;
  prompt: string;
  avatar: string;
  agents: WandTaskAgent[];
  /** Built-in tags are fixed by systemKey; ordinary employees' tags are user-maintained. */
  tags?: string[];
  /** Finished system auxiliary history only, excluding agent decisions/dispatch; null/omitted = unlimited, 0 = none. */
  systemSessionLimit?: number | null;
  /** Non-empty = Wand built-in identity; it cannot be archived or deleted. */
  systemKey?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Draft created by the employee assistant; candidates[0] is the preferred agent. */
export interface SiliconEmployeeDraft {
  name: string;
  duty: string;
  prompt: string;
  agent: WandTaskAgent;
  candidates?: WandTaskAgent[];
}

export const SYSTEM_EMPLOYEE_KEY = "wand-ops";
export const SYSTEM_EMPLOYEE_ID = "e_wand_ops";
export const SYSTEM_EMPLOYEE_NAME = "勤劳的初二";
export const SYSTEM_EMPLOYEE_TAG = "系统用户";

export function isSystemSiliconEmployee(
  employee: Pick<SiliconEmployee, "systemKey"> | null | undefined,
): boolean {
  return employee?.systemKey === SYSTEM_EMPLOYEE_KEY;
}

export const DEFAULT_EMPLOYEE_KEY = "wand-default";
export const DEFAULT_EMPLOYEE_ID = "e_wand_default";
export const DEFAULT_EMPLOYEE_NAME = "赛博虎妞";
export const DEFAULT_EMPLOYEE_TAG = "默认用户";

export function isDefaultSiliconEmployee(
  employee: Pick<SiliconEmployee, "systemKey"> | null | undefined,
): boolean {
  return employee?.systemKey === DEFAULT_EMPLOYEE_KEY;
}

export function isDecisionExpertSiliconEmployee(employee: Pick<SiliconEmployee, "systemKey"> | null | undefined): boolean {
  return employee?.systemKey === DECISION_EXPERT_KEY;
}

export function isBuiltinSiliconEmployee(
  employee: Pick<SiliconEmployee, "systemKey"> | null | undefined,
): boolean {
  const key = employee?.systemKey;
  return key === SYSTEM_EMPLOYEE_KEY || key === DEFAULT_EMPLOYEE_KEY || key === DECISION_EXPERT_KEY
    || key === HR_EMPLOYEE_KEY;
}

export const SILICON_EMPLOYEE_MAX_TAGS = 8;
export const SILICON_EMPLOYEE_TAG_MAX_CHARS = 20;

/** Built-in labels can only be projected from the corresponding stable employee identity. */
export function siliconEmployeeTags(
  employee: Pick<SiliconEmployee, "systemKey" | "tags">,
): string[] {
  if (isSystemSiliconEmployee(employee) || isDecisionExpertSiliconEmployee(employee)
    || employee.systemKey === HR_EMPLOYEE_KEY) {
    return [SYSTEM_EMPLOYEE_TAG];
  }
  if (isDefaultSiliconEmployee(employee)) return [DEFAULT_EMPLOYEE_TAG];
  return employee.tags ?? [];
}

/** API / storage / Web common parser: trim, deduplicate, preserve order, never truncate silently. */
export function parseSiliconEmployeeTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("员工标签必须是数组。");
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("员工标签必须是文字。");
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > SILICON_EMPLOYEE_TAG_MAX_CHARS) {
      throw new Error(`每个员工标签不能超过 ${SILICON_EMPLOYEE_TAG_MAX_CHARS} 个字符。`);
    }
    if (/[,，、\x00-\x1f\x7f]/.test(tag)) throw new Error("员工标签不能包含分隔符或控制字符。");
    if (tag === SYSTEM_EMPLOYEE_TAG || tag === DEFAULT_EMPLOYEE_TAG) {
      throw new Error(`「${tag}」是内置标签，不可自定义。`);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > SILICON_EMPLOYEE_MAX_TAGS) {
    throw new Error(`最多 ${SILICON_EMPLOYEE_MAX_TAGS} 个员工标签。`);
  }
  return tags;
}

export function parseSiliconEmployeeTagInput(value: string): string[] {
  return parseSiliconEmployeeTags(value.split(/[,，、\n]+/));
}
