/** Public projections; personal records continue to live in employee_knowledge. */
export type KnowledgeScope = "personal" | "project";
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
