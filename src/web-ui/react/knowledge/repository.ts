import { jsonBody, requestJson } from "../http-adapter";
import type { KnowledgeDocument, KnowledgeLibrary, KnowledgeScope } from "../../../knowledge-types.js";
export type { KnowledgeDocument, KnowledgeLibrary, KnowledgeScope } from "../../../knowledge-types.js";

export interface KnowledgeOwners {
  employees: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; readOnly: boolean }>;
}
export interface KnowledgeInput { title: string; content: string; folder: string }
export interface KnowledgeNamespace { scope: KnowledgeScope; ownerId: string }
const listeners = new Set<(namespace: KnowledgeNamespace) => void>();
export function notifyKnowledgeChanges(namespace: KnowledgeNamespace): void { listeners.forEach(listener => listener(namespace)); }
export function subscribeKnowledgeChanges(listener: (namespace: KnowledgeNamespace) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Both the library and employee settings read the same server-owned documents. */
export const knowledgeRepository = {
  owners: (): Promise<KnowledgeOwners> => requestJson("/api/knowledge/owners", { cache: "no-store" }),
  async list(namespace: KnowledgeNamespace): Promise<KnowledgeLibrary> {
    const query = new URLSearchParams({ scope: namespace.scope, ownerId: namespace.ownerId });
    const result = await requestJson<KnowledgeLibrary>(`/api/knowledge?${query}`, { cache: "no-store" });
    if (result.scope !== namespace.scope || result.ownerId !== namespace.ownerId
      || result.entries.some(entry => entry.scope !== namespace.scope || entry.ownerId !== namespace.ownerId)) {
      throw new Error("知识库归属不一致，请重新读取。");
    }
    return result;
  },
  async save(namespace: KnowledgeNamespace, input: KnowledgeInput, existing?: { id: string; revision: number }): Promise<KnowledgeDocument> {
    const result = await requestJson<{ entry: KnowledgeDocument }>(existing ? `/api/knowledge/${encodeURIComponent(existing.id)}` : "/api/knowledge",
      jsonBody({ ...namespace, ...input, ...(existing ? { revision: existing.revision } : {}) }, existing ? "PATCH" : "POST"));
    if (result.entry.scope !== namespace.scope || result.entry.ownerId !== namespace.ownerId) throw new Error("保存回执归属不一致，请刷新确认；草稿已保留。");
    notifyKnowledgeChanges(namespace);
    return result.entry;
  },
  async remove(entry: KnowledgeDocument): Promise<void> {
    await requestJson(`/api/knowledge/${encodeURIComponent(entry.id)}`, jsonBody({ scope: entry.scope, ownerId: entry.ownerId, revision: entry.revision }, "DELETE"));
    notifyKnowledgeChanges(entry);
  },
  async clearPersonal(ownerId: string): Promise<void> {
    await requestJson(`/api/silicon-employees/${encodeURIComponent(ownerId)}/knowledge`, { method: "DELETE" });
    notifyKnowledgeChanges({ scope: "personal", ownerId });
  },
};
