/** Explicit employee-owned knowledge, distinct from the default partner's expiring habit profile. */
export const EMPLOYEE_KNOWLEDGE_MAX_ENTRIES = 200;
export const EMPLOYEE_KNOWLEDGE_MAX_CHARS = 4000;

export interface EmployeeKnowledgeEntry {
  id: string;
  employeeId: string;
  content: string;
  createdAt: string;
}

export interface EmployeeKnowledgeView {
  employeeId: string;
  entries: EmployeeKnowledgeEntry[];
  total: number;
  maxEntries: number;
}
