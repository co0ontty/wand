import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeRepository } from "../src/storage/knowledge-repository.js";
import { PreferencesRepository } from "../src/storage/preferences-repository.js";
import type { KnowledgeComment, KnowledgeRevision } from "../src/knowledge-types.js";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS global_knowledge (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, folder TEXT NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS knowledge_namespace_versions (scope TEXT NOT NULL, owner_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope, owner_id));
`);

const preferences = new PreferencesRepository(db, null as any);
const mockStorage = {
  db,
  databasePath: () => ":memory:",
  getPreference: <T>(key: string, fallback: T): T => preferences.getPreference(key, fallback),
  setPreference: <T>(key: string, val: T | null | undefined): void => preferences.setPreference(key, val),
  transaction: <T>(fn: () => T): T => fn(),
};

const repo = new KnowledgeRepository(db, mockStorage as any);

// 1. Test Comment persistence with Mention target
const comment: KnowledgeComment = {
  id: "c_test_1",
  author: "用户",
  timestamp: "刚刚",
  text: "希望增加移动端悬浮胶囊筛选说明",
  applied: false,
  mention: {
    employeeId: "e_wand_default",
    employeeName: "赛博虎妞",
    avatar: "plush-cat:v1:silver",
    provider: "claude",
    model: "claude-3-7-sonnet",
    thinkingEffort: "high",
  },
};

repo.saveKnowledgeComment("doc_1", comment);
const comments = repo.getKnowledgeComments("doc_1");
assert.equal(comments.length, 1);
assert.equal(comments[0].text, "希望增加移动端悬浮胶囊筛选说明");
assert.equal(comments[0].mention?.employeeName, "赛博虎妞");
assert.equal(comments[0].mention?.provider, "claude");
assert.equal(comments[0].applied, false);

// 2. Mark comments applied
repo.markKnowledgeCommentsApplied("doc_1", "rev_2");
const updatedComments = repo.getKnowledgeComments("doc_1");
assert.equal(updatedComments[0].applied, true);
assert.equal(updatedComments[0].appliedInRev, "rev_2");

// 3. Test History persistence
const rev1: KnowledgeRevision = {
  id: "rev_1",
  timestamp: "昨天",
  author: "用户",
  summary: "初始版本",
  source: "manual",
  title: "测试标题",
  content: "初始内容",
};
const rev2: KnowledgeRevision = {
  id: "rev_2",
  timestamp: "今天",
  author: "用户",
  summary: "更新版本",
  source: "manual",
  title: "测试标题",
  content: "更新内容\n增加了移动端悬浮胶囊筛选说明",
};

repo.recordKnowledgeRevision("doc_1", rev1);
repo.recordKnowledgeRevision("doc_1", rev2);

const history = repo.getKnowledgeHistory("doc_1");
assert.equal(history.length, 2);
assert.equal(history[0].id, "rev_2");
assert.equal(history[1].id, "rev_1");

// 4. Test delete comment
repo.deleteKnowledgeComment("doc_1", "c_test_1");
assert.equal(repo.getKnowledgeComments("doc_1").length, 0);

console.log("PASS: Knowledge comments and history persistence regression tests verified!");
