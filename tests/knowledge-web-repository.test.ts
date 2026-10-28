import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeRepository, subscribeKnowledgeChanges } from "../src/web-ui/react/knowledge/repository.js";
import type { KnowledgeDocument } from "../src/knowledge-types.js";

const entry: KnowledgeDocument = { id: "k_one", scope: "personal", ownerId: "e_one", title: "约定", content: "正文", folder: "", revision: 3, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" };
test("knowledge responses are checked against the requested employee", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ scope: "personal", ownerId: "e_other", entries: [entry], total: 1, limit: 200 });
  await assert.rejects(knowledgeRepository.list({ scope: "personal", ownerId: "e_one" }), /归属不一致/);
  globalThis.fetch = async () => Response.json({ scope: "personal", ownerId: "e_one", entries: [{ ...entry, ownerId: "e_other" }], total: 1, limit: 200 });
  await assert.rejects(knowledgeRepository.list({ scope: "personal", ownerId: "e_one" }), /归属不一致/);
});

test("revisioned mutations send namespace JSON and notify every projection only after success", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  const notifications: unknown[] = [];
  t.after(subscribeKnowledgeChanges(value => notifications.push({ scope: value.scope, ownerId: value.ownerId })));
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options?.method, body: JSON.parse(String(options?.body)) });
    return Response.json(options?.method === "DELETE" ? { ok: true } : { entry });
  };
  await knowledgeRepository.save({ scope: "personal", ownerId: "e_one" }, { title: "约定", content: "正文", folder: "" }, { id: "k_one", revision: 2 });
  await knowledgeRepository.remove(entry);
  assert.deepEqual(requests, [
    { url: "/api/knowledge/k_one", method: "PATCH", body: { scope: "personal", ownerId: "e_one", title: "约定", content: "正文", folder: "", revision: 2 } },
    { url: "/api/knowledge/k_one", method: "DELETE", body: { scope: "personal", ownerId: "e_one", revision: 3 } },
  ]);
  assert.deepEqual(notifications, [{ scope: "personal", ownerId: "e_one" }, { scope: "personal", ownerId: "e_one" }]);
  globalThis.fetch = async () => Response.json({ error: "文档已更新" }, { status: 409 });
  await assert.rejects(knowledgeRepository.remove(entry), /文档已更新/);
  assert.equal(notifications.length, 2);
});
