import type { Express, Request, Response } from "express";
import { KnowledgeError, type KnowledgeDocumentInput, type KnowledgeScope } from "./knowledge-types.js";
import type { WandStorage } from "./storage.js";

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeError("请求必须包含知识库归属。");
  return value as Record<string, unknown>;
}
function namespace(value: unknown): { scope: KnowledgeScope; ownerId: string } {
  const data = fields(value);
  if (data.scope !== "global" && data.scope !== "personal" && data.scope !== "project") throw new KnowledgeError("请选择全局、个人或项目知识库。");
  if (typeof data.ownerId !== "string" || !data.ownerId.trim() || data.ownerId.length > 200) throw new KnowledgeError("请选择员工或项目。");
  return { scope: data.scope, ownerId: data.ownerId };
}
function documentInput(value: unknown): KnowledgeDocumentInput {
  const data = fields(value);
  if (typeof data.content !== "string" || typeof data.title !== "string" || typeof data.folder !== "string") {
    throw new KnowledgeError("正文、标题和目录必须是文字。");
  }
  return { content: data.content, title: data.title, folder: data.folder };
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new KnowledgeError("请先读取文档的最新版本。");
  return value;
}

/** Mounted after requireAuth and the sessions scope guard. No capability/credential DTOs. */
export function registerKnowledgeRoutes(app: Express, storage: WandStorage): void {
  const handle = (fn: (req: Request) => unknown) => (req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(fn(req)); }
    catch (error) {
      if (error instanceof KnowledgeError) res.status(error.status).json({ error: error.message });
      else res.status(500).json({ error: "知识库暂时不可用，请稍后重试。" });
    }
  };
  app.get("/api/knowledge/owners", handle(() => storage.knowledgeOwners()));
  app.get("/api/knowledge", handle(req => {
    const { scope, ownerId } = namespace(req.query);
    if (req.query.q !== undefined && typeof req.query.q !== "string") throw new KnowledgeError("搜索内容必须是文字。");
    return storage.readKnowledgeLibrary(scope, ownerId, req.query.q as string | undefined);
  }));
  app.post("/api/knowledge", handle(req => {
    const { scope, ownerId } = namespace(req.body);
    return storage.createKnowledgeDocument(scope, ownerId, documentInput(req.body));
  }));
  app.patch("/api/knowledge/:id", handle(req => {
    const { scope, ownerId } = namespace(req.body);
    return { entry: storage.updateKnowledgeDocument(scope, ownerId, String(req.params.id), revision(req.body.revision), documentInput(req.body)) };
  }));
  app.delete("/api/knowledge/:id", handle(req => {
    const { scope, ownerId } = namespace(req.body);
    storage.deleteKnowledgeDocument(scope, ownerId, String(req.params.id), revision(req.body.revision));
    return { ok: true };
  }));
}
