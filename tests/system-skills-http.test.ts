import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import express from "express";
import { installSystemSkill } from "../src/system-skill.js";
import { WandCliApi } from "../src/cli-api.js";
import type { WandConfig } from "../src/types.js";

test("installed helper calls its bound source CLI outside the repo, with auth and PATCH but no credential output", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wand-system-http-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ method: string; url: string; body: unknown; cookie?: string }> = [];
  const app = express(); app.use(express.json());
  app.post("/api/login", (req, res) => {
    assert.equal(req.body.password, "fixture-password-not-real");
    res.setHeader("Set-Cookie", "wand-fixture=local-cookie; HttpOnly"); res.json({ ok: true });
  });
  app.use((req, _res, next) => {
    requests.push({ method: req.method, url: req.url, body: req.body, cookie: req.headers.cookie });
    next();
  });
  app.get("/api/silicon-employees", (_req, res) => res.json({ employees: [{ id: "e_fixture", name: "诊断员" }] }));
  app.patch("/api/scheduled-tasks/:id", (req, res) => res.json({ task: { id: req.params.id, ...req.body } }));
  app.get("/api/sessions/broken-json", (_req, res) => res.send("<html>not JSON</html>"));
  app.post("/api/structured-sessions", (_req, res) => res.status(201).send("invalid JSON"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const configPath = path.join(root, "config/config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ port: address.port, https: false, password: "fixture-password-not-real" }));
  await installSystemSkill(configPath, ["pi"], path.join(root, "home"));
  const helper = path.join(root, "home/.agents/skills/wand-system/scripts/wand.mjs");
  const run = (args: string[], body = "") => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk);
    child.on("error", reject); child.on("exit", code => resolve({ code, out, err })); child.stdin.end(body);
  });
  for (const args of [["--providers"], ["--provider", "pi"]]) {
    const invalid = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts"), "system:skills",
        ...args, "--config", path.join(root, "missing/config.json")], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.resume();
      child.on("error", reject); child.on("exit", code => resolve({ code, out }));
    });
    assert.notEqual(invalid.code, 0);
    assert.equal(invalid.out, "");
  }
  const employees = await run(["employee:list"]);
  assert.equal(employees.code, 0, employees.err);
  assert.equal(JSON.parse(employees.out).employees[0].id, "e_fixture");
  const patch = await run(["schedule:update", "schedule-1", "--stdin"], JSON.stringify({ revision: 1, enabled: false }));
  assert.equal(patch.code, 0, patch.err);
  assert.deepEqual(JSON.parse(patch.out), { task: { id: "schedule-1", revision: 1, enabled: false } });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.method, "PATCH");
  assert.ok(requests.every(request => request.cookie === "wand-fixture=local-cookie"));
  for (const output of [employees, patch]) assert.doesNotMatch(output.out + output.err, /fixture-password-not-real|local-cookie/);

  const api = new WandCliApi({ port: address.port, https: false, password: "fixture-password-not-real" } as WandConfig);
  await assert.rejects(api.get("/api/sessions/broken-json"), /HTTP 200.*无法确认结果/);
  await assert.rejects(api.post("/api/structured-sessions", {}), /HTTP 201.*可能已接受/);
  assert.equal(requests.filter(request => request.url === "/api/structured-sessions").length, 1);
});

test("installer refuses canonical or nested file symlinks without changing their targets", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wand-system-symlink-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, "config/config.json");
  const home = path.join(root, "home");
  const canonical = path.join(root, "config/skills/wand-system");
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await mkdir(path.dirname(canonical), { recursive: true });
  await symlink(outside, canonical);
  await assert.rejects(installSystemSkill(config, ["pi"], home), /目录不是普通目录/);
  await rm(canonical);
  await mkdir(canonical);
  await symlink(outside, path.join(canonical, "scripts"));
  await writeFile(path.join(outside, "wand.mjs"), "user code");
  await assert.rejects(installSystemSkill(config, ["pi"], home), /目录不是普通目录/);
  assert.equal(await readFile(path.join(outside, "wand.mjs"), "utf8"), "user code");
});
