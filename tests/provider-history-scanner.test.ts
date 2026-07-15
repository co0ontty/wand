import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
