import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { discoverPiResources } from "../src/pi-resource-catalog.js";
import { ProcessManager } from "../src/process-manager.js";
import { SessionRegistry } from "../src/session-registry.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";

const skill = (n: string): string => `skill-${n.repeat(24)}`;

test("用户级 Pi 默认设置可读可写，新建会话按它起步，失效资源与非法值被拒绝", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-pi-defaults-"));
  const agentDir = path.join(root, "agent");
  const dir = path.join(agentDir, "skills", "subagent"); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: subagent\ndescription: Delegate subtasks\n---\n# Subagent\n");
  const config = { ...defaultConfig(), defaultCwd: root, harness: { engine: "cli" as const, agentDir } };
  const installed = (await discoverPiResources(config, root)).catalog.skills.find((item) => item.name === "subagent")!.id;
  const storage = new WandStorage(path.join(root, "wand.db"));
  const structured = new StructuredSessionManager(storage, config, null, { pi: { start() { throw new Error("must not launch a model"); } } });
  const processes = new ProcessManager(config, storage, root);
  const registry = new SessionRegistry(processes, structured, storage);
  const app = express(); app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions: registry });
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    structured.dispose(); processes.dispose(); await whenIterationPromptsSettled(); storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/pi-settings/defaults`;
  const read = async () => (await fetch(base)).json() as Promise<any>;
  const patch = (body: unknown) => fetch(base, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const initial = await read();
  assert.equal(initial.skillLocksAvailable, true);
  assert.deepEqual(initial.settings.resources, { skills: [], mcpServers: [] }, "出厂默认不选资源");
  assert.equal(initial.autoResourcesAvailable, false, "没有本地决策时如实报告不可用");

  assert.equal((await patch({ resources: { skills: [installed], mcpServers: [] } })).status, 200);
  assert.equal((await patch({ lockedSkills: [installed] })).status, 200);
  assert.equal((await patch({ codemodeOverride: "on" })).status, 200);
  const saved = await read();
  assert.deepEqual(saved.settings.resources.skills, [installed]);
  assert.deepEqual(saved.settings.lockedSkills, [installed]);
  assert.equal(saved.settings.codemodeOverride, "on");

  // 只改一个字段不会丢掉其它默认。
  assert.equal((await patch({ localDecision: false })).status, 200);
  const partial = await read();
  assert.equal(partial.settings.localDecision, false);
  assert.deepEqual(partial.settings.lockedSkills, [installed]);
  assert.equal(partial.settings.codemodeOverride, "on");

  // 新建会话以用户级默认为起点。
  const next = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  assert.deepEqual(next.piSettings?.resources?.skills, [installed]);
  assert.deepEqual(next.piSettings?.lockedSkills, [installed]);
  assert.equal(next.piSettings?.codemodeOverride, "on");

  // 非法/失效值直接拒绝，不落库。
  assert.equal((await patch({ resources: { skills: [skill("f")], mcpServers: [] } })).status, 400);
  assert.equal((await patch({ lockedSkills: [skill("f")] })).status, 400);
  assert.equal((await patch({ codemodeOverride: "banana" })).status, 400);
  assert.equal((await patch({ unknownSetting: true })).status, 400);
  assert.equal((await patch({ resources: { skills: [installed, installed], mcpServers: [] } })).status, 400);
  const intact = await read();
  assert.deepEqual(intact.settings.resources.skills, [installed]);
  assert.equal(intact.settings.codemodeOverride, "on");
});
