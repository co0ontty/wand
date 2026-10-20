import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WandStorage } from "../src/storage.js";
import { systemAiSessions } from "../src/system-ai-session-recorder.js";
import { generateCommitMessageOnly } from "../src/git-quick-commit.js";
import { toSessionListItemDTO } from "../src/session-transport.js";
import { conversationsRepository } from "../src/web-ui/react/conversations/repository.js";
import { indexPersonSessions, filterPersonSessions } from "../src/web-ui/react/conversations/sidebar-sessions.js";
import { isConversationActive } from "../src/web-ui/react/conversations/activity-filter.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

const call = (id: string, extra: Partial<WorkspaceSessionSummary> = {}): WorkspaceSessionSummary => ({
  id, automationId: `system-ai:git-commit:${id}`, title: "系统调用 · 提交说明生成", command: "system-ai",
  employeeId: "e_wand_ops", cwd: "/repo", status: "failed", startedAt: "2026-10-19T00:00:00Z", ...extra,
});
const person = { kind: "dm" as const, peerEmployeeId: "e_wand_ops", title: "勤劳的初二", name: "勤劳的初二", tasks: [] };

test("employee list reads canonical system metadata independently of workspace exclusions", async () => {
  const previous = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (url: string) => {
    requested = url;
    return Response.json([call("git"), call("decision", { automationId: "system-ai:decision:decision", employeeId: "other" }),
      call("ordinary", { automationId: undefined }), call("anonymous", { employeeId: undefined })]);
  }) as typeof fetch;
  try {
    assert.deepEqual((await conversationsRepository.systemSessions()).map(s => s.id), ["git", "decision"]);
    assert.equal(requested, "/api/sessions");
  } finally { globalThis.fetch = previous; }
});

test("Git audit records appear under their exact employee without entering workspace groups", () => {
  const groups: TaskDirectoryGroup[] = [{ workspaceId: "repo", workspaceName: "项目", workspaceCwd: "/repo", tasks: [], standaloneSessions: [] }];
  const before = JSON.stringify(groups);
  const logs = [call("git"), call("old", { archived: true }), call("other", { employeeId: "other" }),
    call("not-a-system-call", { automationId: "scheduled:fixture" }), call("git")];
  const index = indexPersonSessions(groups, logs);
  assert.deepEqual(filterPersonSessions(person, index, "active", "提交说明").map(e => e.session.id), ["git"]);
  assert.deepEqual(filterPersonSessions(person, index, "archived", "").map(e => e.session.id), ["old"]);
  assert.deepEqual(filterPersonSessions(person, index, "all", "系统调用").map(e => e.session.id), ["git", "old"]);
  assert.equal(index.get("other")?.length, 1);
  assert.equal(JSON.stringify(groups), before, "employee projection must not mutate the shared workspace store");
  assert.equal(index.get("e_wand_ops")?.[0]?.group.synthetic, true);
  assert.equal(indexPersonSessions(groups, []).size, 0, "retained/deleted records follow the latest canonical response");
});

test("fresh Git generation persists the exact employee call that the sidebar opens, without staging or paid models", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-git-employee-list-"));
  const repo = path.join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  writeFileSync(path.join(repo, "feature.txt"), "new feature\n");
  const storage = new WandStorage(path.join(root, "wand.db"));
  const employee = storage.ensureSystemSiliconEmployee({ provider: "pi" });
  const previous = { PATH: process.env.PATH, WAND_SHELL_ENV_DISABLE: process.env.WAND_SHELL_ENV_DISABLE };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    storage.close(); rmSync(root, { recursive: true, force: true });
  });
  const output = JSON.stringify({ message: "完善功能", tag: "v0.1.0" });
  const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }] } });
  writeFileSync(path.join(root, "pi"), `#!/bin/sh\nprintf '%s\\n' '${event}'\n`);
  chmodSync(path.join(root, "pi"), 0o755);
  process.env.PATH = root + path.delimiter + previous.PATH;
  process.env.WAND_SHELL_ENV_DISABLE = "1";
  const ids: string[] = [];
  const result = await generateCommitMessageOnly(repo, "中文", {
    provider: "pi", cliCandidates: [{ provider: "pi", model: "fixture-model" }],
    traceFactory: systemAiSessions(storage).forEmployee(employee, "source-session"), onCallSessionCreated: id => ids.push(id),
  });
  assert.deepEqual(result, { message: "完善功能", suggestedTag: "v0.1.0" });
  assert.equal(ids.length, 1);
  const record = storage.getSession(ids[0]!)!;
  assert.equal(record.employeeId, person.peerEmployeeId);
  assert.equal(record.status, "exited");
  assert.match(record.automationId!, /^system-ai:git-tag:/);
  assert.equal(storage.employeeConversationForSession(record.id), "dm_e_wand_ops");
  const entries = filterPersonSessions(person, indexPersonSessions([], [toSessionListItemDTO(record) as WorkspaceSessionSummary]), "all", "");
  assert.equal(entries[0]?.session.id, record.id, "navigation retains the newly recorded call, not the source chat");
  assert.ok(JSON.stringify(storage.getSession(entries[0]!.session.id)?.messages).includes("完善功能"));
  assert.equal(execFileSync("git", ["-C", repo, "ls-files", "--cached"], { encoding: "utf8" }), "", "generation must not stage files");
});

test("running system calls participate in the employee activity filter", () => {
  const running = call("running", { status: "running", inFlight: true });
  assert.equal(isConversationActive(person as never, [running], null, null), true);
  assert.deepEqual(filterPersonSessions(person, indexPersonSessions([], [running]), "all", "", {}, true).map(e => e.session.id), ["running"]);
});
