import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiTmuxHost } from "../src/pi-tmux-host.js";

const DAY = 24 * 60 * 60 * 1000;

interface SlotSpec {
  /** 数据库里是否还有这个会话。 */
  live: boolean;
  /** current.json 指向的 turn。 */
  currentTurn: string;
  turns: { name: string; ack: boolean; status: "running" | "exited"; pid?: number }[];
  /** 整个 slot 里最新文件的时间偏移（天，越大越旧）。 */
  ageDays: number;
}

function runIdFor(sessionId: string): string {
  return `structured:${sessionId}`;
}

/**
 * 按 PiTmuxHost 的真实布局造一个 pi-native 目录：
 * `<configDir>/pi-native/<sha256(runId)[:24]>/current.json + turn-<随机>/`
 * slot 名是哈希，无法反推，所以这里用真实构造函数让 host 自己算。
 */
function buildFixture(specs: Record<string, SlotSpec>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-native-"));
  const host = new PiTmuxHost(root, { persistent: true, spawnStructured: async () => { throw new Error("unused"); },
    attachRun: async () => null, adoptRun: async () => null, listRuns: async () => [], forgetRun: () => {} } as never);
  // PiTmuxHost 构造时已把 root 指到 <configDir>/pi-native。
  const nativeRoot = path.join(root, "pi-native");
  assert.equal((host as unknown as { root: string }).root, nativeRoot);
  const now = Date.now();
  const slotPaths = new Map<string, string>();
  for (const [sessionId, spec] of Object.entries(specs)) {
    const slot = (host as unknown as { slot(runId: string): string }).slot(runIdFor(sessionId));
    mkdirSync(slot, { recursive: true });
    slotPaths.set(sessionId, slot);
    for (const turn of spec.turns) {
      const directory = path.join(slot, turn.name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "events.jsonl"), "x".repeat(1024));
      writeFileSync(path.join(directory, "state.json"), JSON.stringify({
        status: turn.status, pid: turn.pid ?? 999999, exitCode: turn.status === "exited" ? 0 : null, signal: null,
      }));
      if (turn.ack) writeFileSync(path.join(directory, "ack"), "consumed\n");
      // 必须等所有文件写完再改时间，否则后写入的 state.json/ack 会把 mtime 拉回现在。
      touchTree(directory, now - spec.ageDays * DAY);
    }
    const currentDir = path.join(slot, spec.currentTurn);
    writeFileSync(path.join(slot, "current.json"), JSON.stringify({
      runId: runIdFor(sessionId), requestId: "req", incarnationId: "inc", tmux: "wand-pi-test",
      events: path.join(currentDir, "events.jsonl"),
      stderr: path.join(currentDir, "stderr.log"),
      state: path.join(currentDir, "state.json"),
      ready: path.join(currentDir, "ready.json"),
      ack: path.join(currentDir, "ack"),
    }));
    const stamp = new Date(now - spec.ageDays * DAY);
    utimesSync(path.join(slot, "current.json"), stamp, stamp);
    utimesSync(slot, stamp, stamp);
  }
  return { root, host, slotPaths, now };
}

test("collectGarbage removes slots whose session no longer exists and keeps live ones", () => {
  const fixture = buildFixture({
    "session-gone": {
      live: false, currentTurn: "turn-gone", ageDays: 10,
      turns: [{ name: "turn-gone", ack: true, status: "exited" }],
    },
    "session-live": {
      live: true, currentTurn: "turn-live", ageDays: 10,
      turns: [{ name: "turn-live", ack: true, status: "exited" }],
    },
  });
  try {
    const report = fixture.host.collectGarbage({
      liveSessionIds: new Set(["session-live"]),
      retentionMs: 7 * DAY,
      now: fixture.now,
    });
    assert.equal(report.removedSlots, 1);
    assert.equal(report.removedTurns, 0);
    assert.ok(report.freedBytes > 0);
    assert.equal(exists(fixture.slotPaths.get("session-gone")!), false);
    assert.equal(exists(fixture.slotPaths.get("session-live")!), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("collectGarbage keeps an orphaned slot that was never acknowledged", () => {
  const fixture = buildFixture({
    "session-gone": {
      live: false, currentTurn: "turn-gone", ageDays: 10,
      // 未 ack：回合可能还在收尾，即使会话已删也不能动。
      turns: [{ name: "turn-gone", ack: false, status: "running" }],
    },
  });
  try {
    const report = fixture.host.collectGarbage({
      liveSessionIds: new Set(),
      retentionMs: 7 * DAY,
      now: fixture.now,
    });
    assert.deepEqual(report, { removedSlots: 0, removedTurns: 0, freedBytes: 0 });
    assert.equal(exists(fixture.slotPaths.get("session-gone")!), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("collectGarbage keeps a live slot's current turn but reclaims its older acknowledged turns", () => {
  const fixture = buildFixture({
    "session-live": {
      live: true, currentTurn: "turn-current", ageDays: 10,
      turns: [
        { name: "turn-current", ack: true, status: "exited" },
        { name: "turn-old", ack: true, status: "exited" },
      ],
    },
  });
  try {
    const report = fixture.host.collectGarbage({
      liveSessionIds: new Set(["session-live"]),
      retentionMs: 7 * DAY,
      now: fixture.now,
    });
    assert.equal(report.removedSlots, 0);
    assert.equal(report.removedTurns, 1);
    const slot = fixture.slotPaths.get("session-live")!;
    assert.equal(exists(path.join(slot, "turn-current")), true);
    assert.equal(exists(path.join(slot, "turn-old")), false);
    // current.json 必须还在：listRuns/adoptRun 靠它恢复。
    assert.equal(exists(path.join(slot, "current.json")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("collectGarbage respects the retention window and never touches running turns", () => {
  const fixture = buildFixture({
    "session-live": {
      live: true, currentTurn: "turn-current", ageDays: 1,
      turns: [
        { name: "turn-current", ack: true, status: "exited" },
        { name: "turn-fresh", ack: true, status: "exited" },
        // PID 指向当前进程：真实存活，即使 ack 且很旧也不能删。
        { name: "turn-running", ack: true, status: "running", pid: process.pid },
      ],
    },
  });
  try {
    // 把 turn-running 做旧
    const running = path.join(fixture.slotPaths.get("session-live")!, "turn-running");
    const stamp = new Date(fixture.now - 30 * DAY);
    utimesSync(running, stamp, stamp);

    const report = fixture.host.collectGarbage({
      liveSessionIds: new Set(["session-live"]),
      retentionMs: 7 * DAY,
      now: fixture.now,
    });
    assert.equal(report.removedTurns, 0);
    assert.equal(exists(running), true);
    assert.equal(exists(path.join(fixture.slotPaths.get("session-live")!, "turn-fresh")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("collectGarbage treats a stale running record whose PID is gone as exited", () => {
  const fixture = buildFixture({
    "session-live": {
      live: true, currentTurn: "turn-current", ageDays: 10,
      turns: [
        { name: "turn-current", ack: true, status: "exited" },
        // 进程被强杀后 state 仍写 running：这类回合必须能回收，否则永久堆积。
        { name: "turn-dead", ack: true, status: "running", pid: 999999 },
      ],
    },
  });
  try {
    const report = fixture.host.collectGarbage({
      liveSessionIds: new Set(["session-live"]),
      retentionMs: 7 * DAY,
      now: fixture.now,
    });
    assert.equal(report.removedTurns, 1);
    assert.equal(exists(path.join(fixture.slotPaths.get("session-live")!, "turn-dead")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function exists(target: string): boolean {
  return existsSync(target);
}

/** 递归把目录内所有文件和目录的 mtime 设为指定时刻。 */
function touchTree(directory: string, epochMs: number): void {
  const stamp = new Date(epochMs);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) touchTree(child, epochMs);
    else utimesSync(child, stamp, stamp);
  }
  utimesSync(directory, stamp, stamp);
}
