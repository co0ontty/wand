import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
        parent_id TEXT,
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
    database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
      openCodeId,
      null,
      cwd,
      "External OpenCode work",
      Date.parse("2026-07-20T00:00:00.000Z"),
      Date.parse("2026-07-20T00:02:00.000Z"),
    );
    const openCodeSubagentId = "ses_external_subagent";
    database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
      openCodeSubagentId,
      openCodeId,
      cwd,
      "OpenCode subagent",
      Date.parse("2026-07-20T00:01:00.000Z"),
      Date.parse("2026-07-20T00:03:00.000Z"),
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

test("provider history scanner deletes Pi, Grok, and Gemini native session resources", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-grok-gemini-history-"));
  try {
    const piSessionsDir = path.join(root, ".pi", "agent", "sessions");
    const piProjectDir = path.join(piSessionsDir, "--Users-test-project--");
    mkdirSync(piProjectDir, { recursive: true });
    const piSessionId = "01a0f57c-9f2f-77f9-8b96-de95f720057f";
    const piFile = path.join(piProjectDir, `2026-10-01T00-00-00-000Z_${piSessionId}.jsonl`);
    writeFileSync(piFile, '{"type":"session"}\n');

    const grokSessionsDir = path.join(root, ".grok", "sessions");
    const grokProjectDir = path.join(grokSessionsDir, "%2FUsers%2Ftest%2Fproject");
    const grokSessionId = "01a02707-9ac0-7212-aceb-503e9693a341";
    const grokSessionDir = path.join(grokProjectDir, grokSessionId);
    mkdirSync(grokSessionDir, { recursive: true });
    writeFileSync(path.join(grokSessionDir, "meta.json"), "{}");

    const geminiHome = path.join(root, ".gemini");
    const geminiSessionId = "8e3cb689-bdf7-42ec-96a0-c762ce08d547";
    const geminiConvDir = path.join(geminiHome, "antigravity-cli", "conversations");
    mkdirSync(geminiConvDir, { recursive: true });
    const geminiDb = path.join(geminiConvDir, `${geminiSessionId}.db`);
    writeFileSync(geminiDb, "sqlite");

    const scanner = new ProviderHistoryScanner({
      piSessionsDir,
      grokSessionsDir,
      geminiHome,
    });

    assert.equal(scanner.deletePiHistoryFiles([piSessionId]), 1);
    assert.equal(scanner.deletePiHistoryFiles([piSessionId]), 0);

    assert.equal(scanner.deleteGrokHistoryFiles([grokSessionId]), 1);
    assert.equal(scanner.deleteGrokHistoryFiles([grokSessionId]), 0);

    assert.equal(scanner.deleteGeminiHistoryFiles([geminiSessionId]), 1);
    assert.equal(scanner.deleteGeminiHistoryFiles([geminiSessionId]), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting an OpenCode session reclaims its event rows and waits out a concurrent writer", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-opencode-event-reclaim-"));
  try {
    const openCodeDatabasePath = path.join(root, "opencode.db");
    const database = new DatabaseSync(openCodeDatabasePath);
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
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
      CREATE TABLE event_sequence (
        aggregate_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        owner_id TEXT
      );
      CREATE TABLE event (
        id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        CONSTRAINT fk_event_aggregate_id FOREIGN KEY (aggregate_id)
          REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
      );
    `);
    const keptId = "ses_kept";
    const deletedId = "ses_deleted";
    for (const id of [keptId, deletedId]) {
      database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(
        id, null, root, `title ${id}`, 1, 2,
      );
      database.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, 0)").run(id);
      for (let seq = 1; seq <= 3; seq++) {
        database.prepare("INSERT INTO event VALUES (?, ?, ?, ?, ?)")
          .run(`${id}-event-${seq}`, id, seq, "message.updated.1", "x".repeat(1024));
      }
    }
    database.close();

    // A concurrent writer in another process holds the write lock. With the default
    // busy_timeout of 0 this delete returned a silent 0; it must now wait the writer out.
    const blocker = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE session SET title = title WHERE 0").run();
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 1500);
    `, openCodeDatabasePath], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => {
      blocker.stdout.once("data", () => resolve());
      blocker.once("error", reject);
    });

    const scanner = new ProviderHistoryScanner({ openCodeDatabasePath });
    assert.equal(scanner.deleteOpenCodeHistorySessions([deletedId]), 1);

    await new Promise<void>((resolve) => blocker.once("exit", () => resolve()));

    const verify = new DatabaseSync(openCodeDatabasePath, { readOnly: true });
    const events = verify.prepare("SELECT aggregate_id, COUNT(*) AS c FROM event GROUP BY aggregate_id").all();
    const sequences = verify.prepare("SELECT aggregate_id FROM event_sequence").all();
    verify.close();

    assert.deepEqual(events.map((row) => row.aggregate_id), [keptId]);
    assert.deepEqual(sequences.map((row) => row.aggregate_id), [keptId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
