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
