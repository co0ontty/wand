import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";

test("GitHub issue bindings persist and deduplicate session links", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-issue-binding-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root });
  try {
    const session = manager.createSession({ cwd: root, provider: "codex", mode: "full-access" });
    storage.bindGithubIssueSession("co0ontty", "wand", 12, session.id);
    storage.bindGithubIssueSession("co0ontty", "wand", 12, session.id);
    assert.deepEqual(storage.listGithubIssueBindings("co0ontty", "wand", 12).map((item) => item.sessionId), [session.id]);
    storage.unbindGithubIssueSession("co0ontty", "wand", 12, session.id);
    assert.deepEqual(storage.listGithubIssueBindings("co0ontty", "wand", 12), []);
  } finally {
    manager.dispose();
    storage.close();
  }
});

test("Wand-task bindings accept every Wand structured provider", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-provider-binding-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root });
  const task = storage.createWandTask({ title: "多 provider 议题" });
  try {
    const providers = ["claude", "codex", "opencode", "grok", "qoder", "pi"] as const;
    const ids = providers.map((provider) => manager.createSession({ cwd: root, provider, mode: provider === "codex" ? "full-access" : "default" }).id);
    ids.forEach((id) => storage.bindWandTaskSession(task.id, id));
    assert.deepEqual(new Set(storage.listWandTaskSessionIds(task.id)), new Set(ids));
    assert.equal(storage.listWandTaskSessionIds(task.id).length, ids.length);
  } finally {
    manager.dispose();
    storage.close();
  }
});
