import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";
import { defaultPiCliSessionSettings, patchPiSessionSettings, piSkillMode, piSkillModePatch, cliPiSettingsRejection } from "../src/pi-session-settings.js";
import { discoverPiResources, resolvePiResourceSelection } from "../src/pi-resource-catalog.js";
import { cliPiResourceReader } from "../src/pi-user-resources.js";
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
  const removedNames = ["removed-one", "removed-two", "removed-unlocked"];
  for (const name of removedNames) {
    const directory = path.join(agentDir, "skills", name); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# Skill\n`);
  }
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: "https://example.invalid/mcp" } } }));
  const config = { ...defaultConfig(), defaultCwd: root, harness: { engine: "cli" as const, agentDir } };
  const inventory = await discoverPiResources(config, root);
  const installed = inventory.catalog.skills.find((item) => item.name === "subagent")!.id;
  const removed = removedNames.map((name) => inventory.catalog.skills.find((item) => item.name === name)!.id);
  const mcpServers = [inventory.catalog.mcpServers[0]!.id];
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

  assert.equal((await patch({ resources: { skills: [installed, ...removed], mcpServers },
    lockedSkills: [installed, ...removed.slice(0, 2)] })).status, 200);
  for (const name of removedNames) renameSync(path.join(agentDir, "skills", name), path.join(root, name));
  const unavailable = await discoverPiResources(config, root);
  const before = (await read()).settings;
  assert.throws(() => resolvePiResourceSelection(unavailable, before.resources), /已不存在/);
  assert.equal((await patch({ codemodeOverride: "on" })).status, 200);
  assert.deepEqual((await read()).settings.resources, before.resources, "unrelated edits never silently remove missing skills");

  // A valid unlock keeps the selected skill. Other unavailable selections and locks remain untouched.
  const validUnlock = await patch({ lockedSkills: removed.slice(0, 2) });
  assert.equal(validUnlock.status, 200);
  const validSettings = (await validUnlock.json() as any).settings;
  assert.deepEqual(validSettings, { ...before, codemodeOverride: "on", lockedSkills: removed.slice(0, 2) });

  // Only the explicitly unlocked unavailable ID is released, including a lock-only PATCH.
  const firstUnlock = await patch({ lockedSkills: [removed[1]] });
  assert.equal(firstUnlock.status, 200);
  const firstSettings = (await firstUnlock.json() as any).settings;
  assert.deepEqual(firstSettings, { ...validSettings, lockedSkills: [removed[1]],
    resources: { skills: [installed, removed[1], removed[2]], mcpServers } });
  assert.deepEqual(storage.getSession(session.id)?.piSettings, firstSettings);
  assert.deepEqual(storage.getPiSessionDefaults(), firstSettings, "canonical resource cleanup must also reach new-session defaults");
  assert.throws(() => resolvePiResourceSelection(unavailable, firstSettings.resources), /已不存在/,
    "remaining missing selections still fail closed at execution");
  assert.equal((await patch({ resources: { ...firstSettings.resources, skills: [...firstSettings.resources.skills, skill("f")] } })).status, 400);
  assert.equal((await patch({ lockedSkills: [removed[1], skill("f")] })).status, 400);
  assert.deepEqual((await read()).settings, firstSettings);

  // A full UI patch has the same result; an already-unlocked missing selection is not swept away.
  const secondUnlock = await patch({ resources: firstSettings.resources, lockedSkills: [] });
  assert.equal(secondUnlock.status, 200);
  const secondSettings = (await secondUnlock.json() as any).settings;
  assert.deepEqual(secondSettings.resources, { skills: [installed, removed[2]], mcpServers });
  assert.deepEqual(secondSettings.lockedSkills, []);
  assert.equal((await patch({ lockedSkills: [] })).status, 200);
  assert.deepEqual((await read()).settings.resources, secondSettings.resources, "repeating an empty lock list is not blanket cleanup");
  assert.equal((await patch({ resources: { skills: [installed], mcpServers } })).status, 200);
  const repaired = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  assert.deepEqual(repaired.piSettings?.resources, { skills: [installed], mcpServers });
  assert.deepEqual(repaired.piSettings?.lockedSkills, []);
  structured.setSessionArchived(session.id, true);
  assert.equal((await read()).skillLocksAvailable, false);
  assert.equal((await patch({ lockedSkills: [] })).status, 400);
});

test("默认设置只合并本次改动：旧会话改一个 Skill 不会把自动配置/CodeMode 拉回旧值", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-pi-defaults-merge-"));
  const agentDir = path.join(root, "agent");
  const dir = path.join(agentDir, "skills", "subagent"); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: subagent\ndescription: Delegate subtasks\n---\n# Subagent\n");
  const config = { ...defaultConfig(), defaultCwd: root, harness: { engine: "cli" as const, agentDir } };
  const installed = (await discoverPiResources(config, root)).catalog.skills.find((item) => item.name === "subagent")!.id;
  const storage = new WandStorage(path.join(root, "wand.db"));
  const structured = new StructuredSessionManager(storage, config, null, { pi: { start() { throw new Error("must not launch a model"); } } });
  t.after(() => {
    structured.dispose(); storage.close(); rmSync(root, { recursive: true, force: true });
  });
  // 一个从旧默认起步的会话（autoResources 默认关），之后用户在新会话里开启了自动配置 + CodeMode。
  const stale = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  const fresh = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  structured.setPiSettings(fresh.id, { autoResources: true, codemodeOverride: "on" });
  assert.equal(storage.getPiSessionDefaults()?.autoResources, true);
  // 用户回到旧会话，只点了一个 Skill 开关。
  const before = structured.getPiSettings(stale.id).settings;
  structured.setPiSettings(stale.id, piSkillModePatch(before, installed, "on"));
  const defaults = storage.getPiSessionDefaults()!;
  assert.equal(defaults.autoResources, true, "旧会话的 stale autoResources 不能覆盖默认");
  assert.equal(defaults.codemodeOverride, "on", "未提到的 CodeMode 保持默认原值");
  assert.ok(defaults.resources?.skills.includes(installed));
  // 显式关闭仍要生效，且 null 是「清除」而不是「保持」。
  structured.setPiSettings(fresh.id, { autoResources: false });
  assert.equal(storage.getPiSessionDefaults()?.autoResources, false);
  structured.setPiSettings(fresh.id, { codemodeOverride: null });
  assert.equal(storage.getPiSessionDefaults()?.codemodeOverride, undefined);
});

test("HTTP unlock resolves against concurrent selections after discovery; explicit resource arrays still replace", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-skill-unlock-race-"));
  const agentDir = path.join(root, "agent");
  for (const name of ["removed", "concurrent"]) {
    const directory = path.join(agentDir, "skills", name); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n# Skill\n`);
  }
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: "https://example.invalid/mcp" } } }));
  const config = { ...defaultConfig(), defaultCwd: root, harness: { engine: "cli" as const, agentDir } };
  const inventory = await discoverPiResources(config, root);
  const removed = inventory.catalog.skills.find((item) => item.name === "removed")!.id;
  const concurrent = inventory.catalog.skills.find((item) => item.name === "concurrent")!.id;
  const mcpServers = [inventory.catalog.mcpServers[0]!.id];
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
  const session = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const patch = (endpoint: string, body: unknown) => fetch(origin + endpoint, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const reader = await cliPiResourceReader(root);
  const originalResolve = reader.DefaultPackageManager.prototype.resolve;
  for (const endpoint of [`/api/sessions/${session.id}/pi-settings`, "/api/pi-settings/defaults"]) {
    for (const explicitResources of [false, true]) {
      const initial = { skills: [removed], mcpServers: [] };
      assert.equal((await patch(endpoint, { resources: initial, lockedSkills: [removed] })).status, 200);
      renameSync(path.join(agentDir, "skills", "removed"), path.join(root, "removed"));
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let blockNext = true;
      const mock = t.mock.method(reader.DefaultPackageManager.prototype, "resolve", async function (
        this: InstanceType<typeof reader.DefaultPackageManager>, ...args: Parameters<typeof originalResolve>
      ) {
        if (blockNext) { blockNext = false; entered(); await gate; }
        return originalResolve.apply(this, args);
      });
      try {
        const pending = patch(endpoint, { lockedSkills: [], ...(explicitResources ? { resources: initial } : {}) });
        await Promise.race([waiting, pending.then(() => { throw new Error("unlock did not enter resource discovery"); })]);
        assert.equal((await patch(endpoint, { resources: { skills: [removed, concurrent], mcpServers } })).status, 200);
        release();
        const response = await pending;
        assert.equal(response.status, 200);
        const { settings } = await response.json() as any;
        assert.deepEqual(settings.resources, explicitResources ? { skills: [], mcpServers: [] } : { skills: [concurrent], mcpServers });
        assert.deepEqual(settings.lockedSkills, []);
        assert.deepEqual(storage.getPiSessionDefaults()?.resources, settings.resources);
        if (endpoint.includes("/sessions/")) assert.deepEqual(storage.getSession(session.id)?.piSettings?.resources, settings.resources);
      } finally {
        release(); mock.mock.restore();
        renameSync(path.join(root, "removed"), path.join(agentDir, "skills", "removed"));
      }
    }
  }
});
