import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ProviderHistoryScanner } from "../src/provider-history-scanner.js";

test("provider history scanner reparses only changed JSONL files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-history-index-"));
  try {
    const claudeHome = path.join(root, ".claude");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    const claudeProject = path.join(claudeHome, "projects", encoded);
    mkdirSync(claudeProject, { recursive: true });
    const claudeId = "11111111-1111-4111-8111-111111111111";
    const claudeFile = path.join(claudeProject, `${claudeId}.jsonl`);
    writeFileSync(claudeFile, [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "hi" } }),
      "",
    ].join("\n"));

    const codexDir = path.join(root, ".codex", "sessions", "2026", "01", "01");
    mkdirSync(codexDir, { recursive: true });
    const codexId = "22222222-2222-4222-8222-222222222222";
    const codexFile = path.join(codexDir, `rollout-test-${codexId}.jsonl`);
    writeFileSync(codexFile, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "session_meta", id: codexId, cwd } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ship it" }] } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }),
      "",
    ].join("\n"));

    const scanner = new ProviderHistoryScanner({
      claudeHome,
      codexSessionsDir: path.join(root, ".codex", "sessions"),
    });
    assert.equal(scanner.listClaudeHistorySessions()[0]?.firstUserMessage, "hello");
    assert.equal(scanner.listCodexHistorySessions()[0]?.firstUserMessage, "ship it");
    assert.equal(scanner.getDiagnostics().parsedFiles, 2);

    scanner.listClaudeHistorySessions();
    scanner.listCodexHistorySessions();
    assert.equal(scanner.getDiagnostics().parsedFiles, 2, "unchanged files should reuse indexed summaries");

    appendFileSync(claudeFile, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "again" } })}\n`);
    scanner.listClaudeHistorySessions();
    assert.equal(scanner.getDiagnostics().parsedFiles, 3);

    assert.equal(scanner.deleteCodexHistoryFiles([codexId]), 1);
    assert.equal(scanner.hasCodexSessionFile(codexId), false);
    assert.equal(scanner.deleteClaudeHistoryFiles([{ claudeSessionId: claudeId, cwd }]), 1);
    assert.deepEqual(scanner.listClaudeHistorySessions(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider history scanner hides legacy Wand quick-commit Codex sessions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-quick-commit-history-"));
  try {
    const codexDir = path.join(root, ".codex", "sessions", "2026", "07", "15");
    mkdirSync(codexDir, { recursive: true });

    const writeCodexSession = (id: string, prompt: string): void => {
      writeFileSync(path.join(codexDir, `rollout-test-${id}.jsonl`), [
        JSON.stringify({ type: "session_meta", timestamp: "2026-07-15T00:00:00.000Z", payload: { id, cwd: root, source: "exec", originator: "codex_exec" } }),
        JSON.stringify({ timestamp: "2026-07-15T00:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }),
        JSON.stringify({ timestamp: "2026-07-15T00:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }),
        "",
      ].join("\n"));
    };

    writeCodexSession(
      "33333333-3333-4333-8333-333333333333",
      "阅读以下 git diff，用中文写一条简洁的 commit message。要求：祈使句，不超过 50 字，描述「做了什么」。只输出 message 本身。\n\ndiff",
    );
    writeCodexSession(
      "44444444-4444-4444-8444-444444444444",
      "根据以下 commit message 和 git diff 推荐一个语义化版本 tag。请严格输出**单行 JSON 对象**。",
    );
    writeCodexSession(
      "55555555-5555-4555-8555-555555555555",
      "你正在作为 Wand 的快捷提交兜底执行器运行。",
    );
    writeCodexSession(
      "66666666-6666-4666-8666-666666666666",
      "阅读以下 git diff，并解释这次改动",
    );

    const scanner = new ProviderHistoryScanner({
      claudeHome: path.join(root, ".claude"),
      codexSessionsDir: path.join(root, ".codex", "sessions"),
    });

    assert.deepEqual(
      scanner.listCodexHistorySessions().map((session) => session.firstUserMessage),
      ["阅读以下 git diff，并解释这次改动"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider history scanner exposes resumable OpenCode and Qoder sessions created outside Wand", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-external-provider-history-"));
  try {
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });

    const openCodeDatabasePath = path.join(root, "opencode.db");
    const database = new DatabaseSync(openCodeDatabasePath);
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const openCodeId = "ses_external_123";
    database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run(
      openCodeId,
      cwd,
      "External OpenCode work",
      Date.parse("2026-07-20T00:00:00.000Z"),
      Date.parse("2026-07-20T00:02:00.000Z"),
    );
    database.prepare("INSERT INTO message VALUES (?, ?, ?)").run("message-user", openCodeId, JSON.stringify({ role: "user" }));
    database.prepare("INSERT INTO message VALUES (?, ?, ?)").run("message-assistant", openCodeId, JSON.stringify({ role: "assistant" }));
    database.close();

    const qoderProjectsDir = path.join(root, ".qoder-cn", "projects");
    const qoderProjectDir = path.join(qoderProjectsDir, "project");
    mkdirSync(qoderProjectDir, { recursive: true });
    const qoderId = "qs_external_123";
    writeFileSync(path.join(qoderProjectDir, `${qoderId}.jsonl`), [
      JSON.stringify({ type: "workspace-directories", sessionId: qoderId, directories: [cwd] }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-21T00:00:00.000Z",
        cwd,
        message: { role: "user", content: "Continue the external Qoder task" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-21T00:00:01.000Z",
        cwd,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
      JSON.stringify({ type: "ai-title", sessionId: qoderId, aiTitle: "External Qoder work" }),
      "",
    ].join("\n"));

    const scanner = new ProviderHistoryScanner({
      claudeHome: path.join(root, ".claude"),
      codexSessionsDir: path.join(root, ".codex", "sessions"),
      openCodeDatabasePath,
      qoderProjectsDirs: [qoderProjectsDir],
    });

    assert.deepEqual(scanner.listOpenCodeHistorySessions(), [{
      claudeSessionId: openCodeId,
      cwd,
      firstUserMessage: "External OpenCode work",
      timestamp: "2026-07-20T00:00:00.000Z",
      mtimeMs: Date.parse("2026-07-20T00:02:00.000Z"),
      hasConversation: true,
      managedByWand: false,
      provider: "opencode",
    }]);
    assert.deepEqual(scanner.listQoderHistorySessions().map((session) => ({
      id: session.claudeSessionId,
      cwd: session.cwd,
      title: session.firstUserMessage,
      resumable: session.hasConversation,
      provider: session.provider,
    })), [{
      id: qoderId,
      cwd,
      title: "External Qoder work",
      resumable: true,
      provider: "qoder",
    }]);

    assert.equal(scanner.deleteOpenCodeHistorySessions([openCodeId]), 1);
    assert.equal(scanner.listOpenCodeHistorySessions().length, 0);
    assert.equal(scanner.deleteQoderHistoryFiles([qoderId]), 1);
    assert.deepEqual(scanner.listQoderHistorySessions(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
