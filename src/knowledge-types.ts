/** Public projections; personal records continue to live in employee_knowledge. */
export type KnowledgeScope = "global" | "personal" | "project";
/** One library for this Wand installation, independent of employees and workspaces. */
export const GLOBAL_KNOWLEDGE_OWNER_ID = "global";
/** All global content is injected; reject overflow at write time instead of omitting rules. */
export const GLOBAL_KNOWLEDGE_MAX_BYTES = 24000;
export interface KnowledgeDocument {
  id: string;
  scope: KnowledgeScope;
  ownerId: string;
  title: string;
  content: string;
  folder: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeLibrary {
  scope: KnowledgeScope;
  ownerId: string;
  ownerName: string;
  readOnly: boolean;
  entries: KnowledgeDocument[];
  total: number;
  limit: number;
  totalBytes?: number;
  maxTotalBytes?: number;
  cliSync?: Array<{ provider: string; path: string; error?: string }>;
}
export interface KnowledgeDocumentInput { title?: string; content: string; folder?: string; }
export interface KnowledgeAccess {
  sessionId: string;
  employeeId: string | null;
  workspaceId: string | null;
}
export class KnowledgeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "KnowledgeError"; }
}
