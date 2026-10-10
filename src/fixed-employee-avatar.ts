import { DEFAULT_EMPLOYEE_ID, DEFAULT_EMPLOYEE_KEY, SYSTEM_EMPLOYEE_ID, SYSTEM_EMPLOYEE_KEY } from "./ai-team-types.js";

export const FIXED_EMPLOYEE_AVATARS = [
  { id: DEFAULT_EMPLOYEE_ID, systemKey: DEFAULT_EMPLOYEE_KEY, avatar: "plush-cat:v1:silver" },
  { id: SYSTEM_EMPLOYEE_ID, systemKey: SYSTEM_EMPLOYEE_KEY, avatar: "plush-cat:v1:orange" },
] as const;

/** Stable identity pairs only: names and source employees never determine policy. */
export function fixedEmployeeAvatar(identity: { id?: string | null; systemKey?: string | null }): string | null {
  return FIXED_EMPLOYEE_AVATARS.find((entry) => entry.id === identity.id && entry.systemKey === identity.systemKey)?.avatar ?? null;
}

/** The avatar exception does not change any other built-in employee's edit policy. */
export function isFixedAvatarEmployee(identity: { id?: string | null; systemKey?: string | null }): boolean {
  return fixedEmployeeAvatar(identity) !== null;
}
