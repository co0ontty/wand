import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { clearNativeSessionTitleCache, readNativeSessionTitle } from "../src/native-session-title.js";

const THREAD_ID = "01a0e7f5-c35f-7303-a301-8f512d5a3c38";

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("readNativeSessionTitle uses the codex thread name written by the CLI", async () => {
  clearNativeSessionTitleCache();
  const codexHome = tempRoot("wand-native-codex-");
  writeFileSync(path.join(codexHome, "session_index.jsonl"), [
    JSON.stringify({ id: THREAD_ID, thread_name: "分析并精简项目架构", updated_at: "2026-09-28T12:22:32Z" }),
    JSON.stringify({ id: "01a0bf66-1111-4111-8111-111111111111", thread_name: "别的会话", updated_at: "2026-09-20T15:20:04Z" }),
  ].join("\n") + "\n");
  assert.equal(
    await readNativeSessionTitle("codex", THREAD_ID, process.cwd(), { codexHome }),
    "分析并精简项目架构",
  );
  assert.equal(await readNativeSessionTitle("codex", "missing-id", process.cwd(), { codexHome }), "");
});

test("readNativeSessionTitle keeps the latest codex rename and rejects model error text", async () => {
  clearNativeSessionTitleCache();
  const codexHome = tempRoot("wand-native-codex-rename-");
  const index = path.join(codexHome, "session_index.jsonl");
  writeFileSync(index, JSON.stringify({ id: THREAD_ID, thread_name: "旧名字" }) + "\n");
  assert.equal(await readNativeSessionTitle("codex", THREAD_ID, process.cwd(), { codexHome }), "旧名字");
  clearNativeSessionTitleCache();
  writeFileSync(index, [
    JSON.stringify({ id: THREAD_ID, thread_name: "旧名字" }),
    JSON.stringify({ id: THREAD_ID, thread_name: "新名字" }),
  ].join("\n") + "\n");
  assert.equal(await readNativeSessionTitle("codex", THREAD_ID, process.cwd(), { codexHome }), "新名字");
  clearNativeSessionTitleCache();
  writeFileSync(index, JSON.stringify({ id: THREAD_ID, thread_name: "API error: rate limit exceeded" }) + "\n");
  assert.equal(await readNativeSessionTitle("codex", THREAD_ID, process.cwd(), { codexHome }), "");
});

test("readNativeSessionTitle reads the qoder ai-title from its transcript", async () => {
  clearNativeSessionTitleCache();
  const projectsDir = tempRoot("wand-native-qoder-");
  const project = path.join(projectsDir, "-Users-co0ontty-demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "sess-42.jsonl"), [
    JSON.stringify({ type: "user", message: { role: "user", content: "开工" } }),
    JSON.stringify({ type: "ai-title", aiTitle: "补齐会话标题链路" }),
    JSON.stringify({ type: "ai-title", aiTitle: "补齐会话标题与回退" }),
  ].join("\n") + "\n");
  assert.equal(
    await readNativeSessionTitle("qoder", "sess-42", process.cwd(), { qoderProjectsDirs: [projectsDir] }),
    "补齐会话标题与回退",
  );
});

test("readNativeSessionTitle reads the opencode session title and skips placeholders", async () => {
  clearNativeSessionTitleCache();
  const dbPath = path.join(tempRoot("wand-native-opencode-"), "opencode.db");
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT)");
  database.prepare("INSERT INTO session (id, title, directory) VALUES (?, ?, ?)").run(
    "ses_abc123", "重构会话恢复流程", process.cwd(),
  );
  database.prepare("INSERT INTO session (id, title, directory) VALUES (?, ?, ?)").run(
    "ses_placeholder", "New session - 2026-08-22T11:51:39.943Z", process.cwd(),
  );
  database.close();
  assert.equal(
    await readNativeSessionTitle("opencode", "ses_abc123", process.cwd(), { openCodeDatabasePath: dbPath }),
    "重构会话恢复流程",
  );
  assert.equal(await readNativeSessionTitle("opencode", "ses_placeholder", process.cwd(), { openCodeDatabasePath: dbPath }), "");
});

test("readNativeSessionTitle reads the grok generated title for the session cwd", async () => {
  clearNativeSessionTitleCache();
  const cwd = path.join(tempRoot("wand-native-grok-cwd-"), "proj");
  mkdirSync(cwd, { recursive: true });
  const sessionsDir = tempRoot("wand-native-grok-");
  const sessionDir = path.join(sessionsDir, encodeURIComponent(cwd), THREAD_ID);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
    info: { id: THREAD_ID, cwd },
    generated_title: "为会话接入原生标题",
  }));
  assert.equal(
    await readNativeSessionTitle("grok", THREAD_ID, cwd, { grokSessionsDir: sessionsDir }),
    "为会话接入原生标题",
  );
});

test("readNativeSessionTitle returns empty for providers without a native title", async () => {
  clearNativeSessionTitleCache();
  assert.equal(await readNativeSessionTitle("claude", THREAD_ID, process.cwd(), { codexHome: tempRoot("wand-none-") }), "");
  assert.equal(await readNativeSessionTitle("pi", "sess-1", process.cwd(), {}), "");
  assert.equal(await readNativeSessionTitle("gemini", "sess-1", process.cwd(), {}), "");
  assert.equal(await readNativeSessionTitle("codex", "", process.cwd(), {}), "");
});
