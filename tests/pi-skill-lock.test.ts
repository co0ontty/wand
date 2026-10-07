import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";
import { defaultPiCliSessionSettings, patchPiSessionSettings, piSkillMode, piSkillModePatch, cliPiSettingsRejection } from "../src/pi-session-settings.js";
import { discoverPiResources } from "../src/pi-resource-catalog.js";
import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { ProcessManager } from "../src/process-manager.js";
import { SessionRegistry } from "../src/session-registry.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";

const skill = (n: string): string => `skill-${n.repeat(24)}`;

test("skill detents atomically enable, lock, unlock and disable without changing other resources", () => {
  let settings = { ...defaultPiCliSessionSettings(), lockedSkills: [skill("b")],
    resources: { skills: [skill("b")], mcpServers: [`mcp-${"c".repeat(24)}`] } };
  for (const mode of ["on", "locked", "on", "off"] as const) {
    const before = structuredClone(settings);
    const patch = piSkillModePatch(settings, skill("a"), mode);
    assert.deepEqual(settings, before);
    settings = patchPiSessionSettings(settings, patch) as typeof settings;
    assert.equal(piSkillMode(settings, skill("a")), mode);
    assert.equal(settings.resources.skills.includes(skill("a")), mode !== "off");
    assert.equal(settings.lockedSkills.includes(skill("a")), mode === "locked");
    assert.ok(settings.resources.skills.includes(skill("b")));
    assert.ok(settings.lockedSkills.includes(skill("b")));
    assert.deepEqual(settings.resources.mcpServers, before.resources.mcpServers);
    assert.equal(cliPiSettingsRejection(patch, settings), null);
  }
  const legacy = defaultPiCliSessionSettings(); delete legacy.resources;
  const pinned = patchPiSessionSettings(legacy, piSkillModePatch(legacy, skill("a"), "locked"));
  assert.deepEqual(pinned.resources, { skills: [skill("a")], mcpServers: [] });
  assert.deepEqual(pinned.lockedSkills, [skill("a")]);
});

test("lock updates strictly reject wrong types, duplicate IDs, paths, MCP IDs and unbounded lists", () => {
  const settings = defaultPiCliSessionSettings();
  for (const lockedSkills of [null, true, "all", [skill("a"), skill("a")], ["/tmp/SKILL.md"],
    [`mcp-${"b".repeat(24)}`], [42], Array.from({ length: 65 }, (_, i) => `skill-${i.toString(16).padStart(24, "0")}`)]) {
    assert.throws(() => patchPiSessionSettings(settings, { lockedSkills }));
  }
  const locks = [skill("a")];
  const updated = patchPiSessionSettings(settings, { lockedSkills: locks });
  locks.length = 0;
  assert.deepEqual(updated.lockedSkills, [skill("a")]);
  assert.equal(settings.lockedSkills, undefined);
  assert.deepEqual(patchPiSessionSettings(updated, { lockedSkills: [] }).lockedSkills, []);
});

test("HTTP skill detents persist selection and locks, reject nonexistent IDs and keep locks through other edits", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-skill-lock-"));
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
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, registry);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    structured.dispose(); processes.dispose(); await whenIterationPromptsSettled(); storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const session = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions/${session.id}/pi-settings`;
  const read = async () => (await fetch(url)).json() as Promise<any>;
  const patch = (body: unknown) => fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await read()).skillLocksAvailable, true, "locks do not require the decision model to be online");
  for (const mode of ["on", "locked", "on", "locked", "off"] as const) {
    const current = (await read()).settings;
    const response = await patch(piSkillModePatch(current, installed, mode));
    assert.equal(response.status, 200);
    const { settings } = await response.json() as any;
    assert.equal(piSkillMode(settings, installed), mode);
    assert.deepEqual(storage.getSession(session.id)?.piSettings?.lockedSkills, settings.lockedSkills);
    assert.deepEqual(storage.getPiSessionDefaults()?.lockedSkills, settings.lockedSkills);
  }
  assert.equal((await patch({ lockedSkills: [skill("0")] })).status, 400);
  assert.equal((await patch({ lockedSkills: [installed, installed] })).status, 400);
  assert.equal((await patch(piSkillModePatch((await read()).settings, installed, "locked"))).status, 200);
  assert.equal((await patch({ codemodeOverride: "off" })).status, 200);
  assert.deepEqual((await read()).settings.lockedSkills, [installed]);
  const next = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  assert.equal(piSkillMode(next.piSettings!, installed), "locked");
  structured.setSessionArchived(session.id, true);
  assert.equal((await read()).skillLocksAvailable, false);
  assert.equal((await patch({ lockedSkills: [] })).status, 400);
});
