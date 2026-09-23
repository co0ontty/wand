import assert from "node:assert/strict";
import test from "node:test";

import { CompositeStructuredExecHost } from "../src/render-structured-host.js";
import type {
  StructuredExecHost, StructuredExecProcess, StructuredRunState, StructuredSpawnRequest,
} from "../src/structured-exec-host.js";

class FakeHost implements StructuredExecHost {
  readonly persistent = true;
  readonly runs = new Map<string, StructuredRunState>();
  spawns = 0;
  forgotten: string[] = [];
  constructor(private readonly pid: number) {}
  async spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    this.spawns++;
    let state = this.runs.get(request.runId);
    if (!state) {
      state = { runId: request.runId, incarnationId: `fixture-${this.pid}`, pid: this.pid,
        status: "running", exitCode: null, signal: null, stdoutSeq: 0, stderrSeq: 0,
        stdoutLog: "", stderrLog: "", stdoutTruncated: false, stderrTruncated: false };
      this.runs.set(request.runId, state);
    }
    return this.adoptRun(request.runId) as Promise<StructuredExecProcess>;
  }
  async attachRun(runId: string): Promise<StructuredRunState | null> { return this.runs.get(runId) ?? null; }
  async adoptRun(runId: string): Promise<StructuredExecProcess | null> {
    const state = this.runs.get(runId);
    return state ? { runId, pid: state.pid, incarnationId: state.incarnationId,
      interrupt() {}, onStream: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) } : null;
  }
  async listRuns(): Promise<StructuredRunState[]> { return [...this.runs.values()]; }
  forgetRun(runId: string): void { this.forgotten.push(runId); this.runs.delete(runId); }
}

function request(runId: string): StructuredSpawnRequest {
  return { runId, file: "/bin/sh", args: [], cwd: "/tmp", env: {} };
}

test("v2 routing keeps legacy owner on rollback and sends only new runs to selected owner", async () => {
  const legacy = new FakeHost(111);
  const rust = new FakeHost(222);
  await legacy.spawnStructured(request("structured:old"));
  const host = new CompositeStructuredExecHost(legacy, rust, "rust");
  const old = await host.spawnStructured(request("structured:old"));
  assert.equal(old.pid, 111);
  const [first, second] = await Promise.all([
    host.spawnStructured(request("structured:new")), host.spawnStructured(request("structured:new")),
  ]);
  assert.equal(first.pid, 222);
  assert.equal(second.incarnationId, first.incarnationId);
  assert.equal(rust.spawns, 1);
  assert.equal((await host.attachRun("structured:old"))?.pid, 111);
  assert.equal((await host.adoptRun("structured:new"))?.pid, 222);
  const rolledBack = new CompositeStructuredExecHost(legacy, rust, "legacy");
  assert.equal((await rolledBack.attachRun("structured:new"))?.pid, 222);
  assert.equal((await rolledBack.spawnStructured(request("structured:next"))).pid, 111);
  rolledBack.forgetRun("structured:new");
  assert.deepEqual(rust.forgotten, ["structured:new"]);
  assert.deepEqual(legacy.forgotten, []);
});

test("v2 owner collision fails closed rather than adopting or respawning", async () => {
  const legacy = new FakeHost(111);
  const rust = new FakeHost(222);
  await Promise.all([
    legacy.spawnStructured(request("structured:collision")),
    rust.spawnStructured(request("structured:collision")),
  ]);
  const host = new CompositeStructuredExecHost(legacy, rust, "rust");
  await assert.rejects(host.listRuns(), /competing owners/);
  await assert.rejects(host.spawnStructured(request("structured:collision")), /competing owners/);
  assert.equal(legacy.spawns, 1);
  assert.equal(rust.spawns, 1);
});
