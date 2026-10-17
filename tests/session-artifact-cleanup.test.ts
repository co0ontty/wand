import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProviderHistoryScanner } from "../src/provider-history-scanner.js";
import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { WandStorage } from "../src/storage.js";
import { removeSessionArtifact, waitForSessionProcessExit } from "../src/session-artifact-cleanup.js";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relative: string, contents = "fixture") => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
    return file;
  };
  return { root, put };
}

test("Claude deletion removes session attachments but preserves other sessions and shared caches", (t) => {
  const { root, put } = fixture(t);
  const home = path.join(root, "claude");
  const cwd = path.join(root, "project");
  const project = `claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const removed = [
    `${project}/${id}.jsonl`, `${project}/${id}/subagents/agent-a.jsonl`,
    `claude/file-history/${id}/version`, `claude/session-env/${id}/env`,
    `claude/tasks/${id}/1.json`, `claude/todos/${id}.json`, `claude/debug/${id}.txt`,
  ].map((file) => put(file));
  const kept = [`${project}/${other}.jsonl`, `claude/file-history/${other}/version`,
    "claude/cache/shared", "claude/auth.json", "claude/plans/arbitrary.md"].map((file) => put(file));
  const scanner = new ProviderHistoryScanner({ claudeHome: home });
  assert.equal(scanner.deleteClaudeHistoryFiles([{ claudeSessionId: id, cwd }]), 1);
  for (const file of removed) assert.equal(existsSync(file), false, file);
  for (const file of kept) assert.equal(existsSync(file), true, file);
  assert.equal(scanner.deleteClaudeHistoryFiles([{ claudeSessionId: id, cwd }]), 0);
});

test("Codex deletion includes archived rollouts and exactly ID-delimited shell snapshots", (t) => {
  const { root, put } = fixture(t);
  const rollout = (nativeId: string) => JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: root } });
  const removed = [
    put(`codex/sessions/2026/01/01/rollout-a.jsonl`, rollout(id)),
    put(`codex/archived_sessions/rollout-b.jsonl`, rollout(id)),
    put(`codex/shell_snapshots/${id}.sh`), put(`codex/shell_snapshots/${id}.12345.sh`),
  ];
  const kept = [put(`codex/sessions/rollout-other.jsonl`, rollout(other)),
    put(`codex/shell_snapshots/${id}-other.sh`), put(`codex/shell_snapshots/${other}.12345.sh`),
    put("codex/history.jsonl"), put("codex/auth.json")];
  const scanner = new ProviderHistoryScanner({ codexHome: path.join(root, "codex") });
  assert.equal(scanner.deleteCodexHistoryFiles([id]), 2);
  for (const file of removed) assert.equal(existsSync(file), false, file);
  for (const file of kept) assert.equal(existsSync(file), true, file);
});

test("Qoder deletion cleans both roots even if the primary transcript is already missing", (t) => {
  const { root, put } = fixture(t);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const home of ["qoder", "qoder-cn"]) {
    removed.push(put(`${home}/projects/project/${id}/subagents/a.jsonl`));
    for (const sub of ["tasks", "session-env", "file-history"]) {
      removed.push(put(`${home}/${sub}/${id}/data`));
      kept.push(put(`${home}/${sub}/${other}/data`));
    }
    kept.push(put(`${home}/shell-snapshots/snapshot-zsh-unowned.sh`), put(`${home}/cache/shared`));
  }
  removed.push(put(`qoder-cn/projects/project/${id}.jsonl`));
  const scanner = new ProviderHistoryScanner({ qoderProjectsDirs: [path.join(root, "qoder/projects"), path.join(root, "qoder-cn/projects")] });
  assert.equal(scanner.deleteQoderHistoryFiles([id]), 1);
  for (const file of removed) assert.equal(existsSync(file), false, file);
  for (const file of kept) assert.equal(existsSync(file), true, file);
});

test("artifact cleanup refuses traversal and symlinked ancestors, including project roots", (t) => {
  const { root, put } = fixture(t);
  const outside = put(`outside/${id}.jsonl`);
  mkdirSync(path.join(root, "pi/sessions"), { recursive: true });
  symlinkSync(path.join(root, "outside"), path.join(root, "pi/sessions/project"));
  assert.equal(removeSessionArtifact(path.join(root, "pi"), `sessions/project/${id}.jsonl`), false);
  assert.equal(removeSessionArtifact(path.join(root, "pi"), `../outside/${id}.jsonl`), false);
  assert.equal(new ProviderHistoryScanner({ piSessionsDir: path.join(root, "pi/sessions") }).deletePiHistoryFiles([id, "../outside"]), 0);
  assert.equal(existsSync(outside), true);
  mkdirSync(path.join(root, "codex"), { recursive: true });
  const archived = put("outside/rollout-a.jsonl", JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }));
  symlinkSync(path.join(root, "outside"), path.join(root, "codex/archived_sessions"));
  assert.equal(new ProviderHistoryScanner({ codexHome: path.join(root, "codex") }).deleteCodexHistoryFiles([id]), 0);
  assert.equal(existsSync(archived), true);
});

test("Pi cleanup uses the configured harness root and the PTY environment root", (t) => {
  const { root, put } = fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "default-pi");
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = defaultConfig();
  config.harness = { ...config.harness, agentDir: path.join(root, "custom-pi") };
  const manager = new ProcessManager(config, storage, root);
  try {
    const removed = [put(`default-pi/sessions/project/timestamp_${id}.jsonl`),
      put(`custom-pi/sessions/project/timestamp_${id}.jsonl`)];
    const kept = put(`custom-pi/sessions/project/timestamp_${other}.jsonl`);
    assert.equal(manager.deletePiHistoryFiles([id]), 2);
    for (const file of removed) assert.equal(existsSync(file), false);
    assert.equal(existsSync(kept), true);
  } finally {
    manager.dispose(); storage.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("unacknowledged exits time out without authorizing cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disposed = false;
  const barrier = waitForSessionProcessExit(() => () => { disposed = true; });
  const rejection = assert.rejects(barrier, /not acknowledged/);
  t.mock.timers.tick(30_000);
  await rejection;
  assert.equal(disposed, true);
});

test("exit barrier resolves only on acknowledged exit and disposes its listener", async () => {
  let finish = () => {};
  let disposed = false;
  let settled = false;
  const barrier = waitForSessionProcessExit((done) => { finish = done; return () => { disposed = true; }; });
  void barrier.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish();
  await barrier;
  assert.equal(disposed, true);
});
