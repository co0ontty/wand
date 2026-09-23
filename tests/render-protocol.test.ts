import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_FRAME_BYTES,
  RENDER_PROTOCOL_VERSION,
  decodeRenderFrames,
  encodeRenderFrame,
  isRenderEvent,
  renderPaths,
} from "../src/render-protocol.js";
import { terminalDaemonPaths } from "../src/terminal-daemon-protocol.js";
import { RenderDaemonClient, normalizeRenderSessionState } from "../src/render-daemon-client.js";
import type { TerminalDataEvent, TerminalSessionState } from "../src/terminal-host.js";

const CONFIG_PATH = "/tmp/wand-render-test/config.json";

test("render frame roundtrip preserves the payload", () => {
  const request = {
    id: 7,
    token: "t",
    protocolVersion: RENDER_PROTOCOL_VERSION,
    method: "createOrAttach",
    params: { sessionId: "s1", cols: 120, args: ["-l"], env: { LANG: "zh_CN.UTF-8" } },
  };
  const encoded = encodeRenderFrame(request);
  assert.equal(encoded.readUInt32BE(0), encoded.length - 4);
  const { frames, rest } = decodeRenderFrames<typeof request>(encoded);
  assert.deepEqual(frames, [request]);
  assert.equal(rest.length, 0);
});

test("decodeRenderFrames keeps a half frame as rest and decodes it once completed", () => {
  const first = encodeRenderFrame({ event: "data", sessionId: "s1", incarnationId: "u1", data: "hi", seq: 1 });
  const second = encodeRenderFrame({ event: "exit", sessionId: "s1", incarnationId: "u1", exitCode: 0, signal: null });
  const stream = Buffer.concat([first, second]);

  const partial = decodeRenderFrames<unknown>(stream.subarray(0, stream.length - 6));
  assert.equal(partial.frames.length, 1);
  assert.ok(partial.rest.length > 0);

  const completed = decodeRenderFrames<unknown>(Buffer.concat([partial.rest, stream.subarray(stream.length - 6)]));
  assert.equal(completed.frames.length, 1);
  assert.equal(completed.rest.length, 0);
  assert.deepEqual((completed.frames[0] as { event: string }).event, "exit");
});

test("decodeRenderFrames decodes multiple frames from one buffer in order", () => {
  const stream = Buffer.concat([
    encodeRenderFrame({ id: 1, ok: true, result: {} }),
    encodeRenderFrame({ id: 2, ok: false, error: { code: "notFound", message: "gone" } }),
  ]);
  const { frames, rest } = decodeRenderFrames<{ id: number }>(stream);
  assert.deepEqual(frames.map((frame) => frame.id), [1, 2]);
  assert.equal(rest.length, 0);
});

test("over-long frames are rejected instead of being buffered", () => {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => decodeRenderFrames(Buffer.concat([header, Buffer.from("{}")])), /exceeds/);

  // 单帧超过上限的编码侧也必须拒绝，否则大输出会静默撑爆对端。
  assert.throws(() => encodeRenderFrame({ data: "x".repeat(MAX_FRAME_BYTES) }), /exceeds/);
});

test("isRenderEvent separates events from responses", () => {
  assert.equal(isRenderEvent({ event: "reconcile", sessionIds: [] }), true);
  assert.equal(isRenderEvent({ id: 1, ok: true, result: {} }), false);
  assert.equal(isRenderEvent(null), false);
});

test("renderPaths never collide with legacy terminalDaemonPaths", () => {
  const render = renderPaths(CONFIG_PATH);
  const legacy = terminalDaemonPaths(CONFIG_PATH);

  // 交叉领养会导致升级期两边同时操作同一批 PTY，文件名必须完全不相交。
  assert.notEqual(render.socketPath, legacy.socketPath);
  assert.notEqual(render.tokenPath, legacy.tokenPath);
  assert.notEqual(render.pidPath, legacy.pidPath);
  assert.equal(render.socketPath.includes("wand-render-"), true);
  assert.equal(render.socketPath.includes("terminald"), false);
  assert.equal(render.tokenPath.includes(".render-"), true);
  assert.equal(render.tokenPath.includes("terminald"), false);
  assert.equal(legacy.tokenPath.includes("terminald"), true);
  assert.equal(legacy.tokenPath.includes(".render-"), false);
  // meta 是 Render 独有（legacy 只派生三者），但也不能和 legacy 的任一文件重名。
  assert.equal([legacy.socketPath, legacy.tokenPath, legacy.pidPath].includes(render.metaPath), false);
});

test("renderPaths isolate per config path and differ from the legacy suffix namespace", () => {
  const a = renderPaths("/tmp/wand-render-test/config.json");
  const b = renderPaths("/tmp/wand-render-test/other.json");
  assert.notEqual(a.socketPath, b.socketPath);
  // 同 config 的重复调用必须稳定，否则 Server 重启会认不到同一个 Render。
  assert.deepEqual(a, renderPaths("/tmp/wand-render-test/./config.json"));
});

test("renderPaths canonicalizes symlinked config paths", () => {
  // 同一份 config 经符号链接访问（~/.wand 挂到别的卷、/tmp -> /private/tmp、容器挂载点）时
  // 必须派生出**同一套**路径：否则会出现「一个 config 两个 Render」，两个进程各持一批 PTY。
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-paths-"));
  const realDir = path.join(root, "real");
  const linkDir = path.join(root, "link");
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, "config.json"), "{}\n");
  symlinkSync(realDir, linkDir, "dir");
  try {
    const viaLink = renderPaths(path.join(linkDir, "config.json"));
    const direct = renderPaths(path.join(realDir, "config.json"));
    assert.deepEqual(viaLink, direct);
    // 经链接传进带 `.` 的等价路径也必须收敛到同一套。
    assert.deepEqual(renderPaths(path.join(linkDir, ".", "config.json")), direct);
    // meta/token/pid 都落在真实目录旁边，而不是符号链接路径旁边。
    // （macOS 上 /var 本身就是一个符号链接，所以先取 realpath 再比。）
    assert.equal(path.dirname(direct.tokenPath), realpathSync(realDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderPaths falls back to a lexical resolve when the config does not exist yet", () => {
  // config.json 还没建时 realpathSync 会失败；回退到 path.resolve 而不是抛错（首次启动路径）。
  // 代价是：文件存在**之前**用符号链接路径启动，与之后用真实路径启动会算出不同 suffix。
  // 这是两侧约定好的回退语义（Rust 侧同样 `canonicalize().unwrap_or(lexical)`），
  // 且 Render 自己在第一次启动时就把 token 文件建到 config 旁边，不会来回抖。
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-paths-missing-"));
  const realDir = path.join(root, "real");
  const linkDir = path.join(root, "link");
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, linkDir, "dir");
  try {
    const viaLink = renderPaths(path.join(linkDir, "config.json"));
    assert.doesNotThrow(() => renderPaths(path.join(linkDir, "config.json")));
    assert.equal(path.dirname(viaLink.tokenPath), linkDir);
    assert.notDeepEqual(viaLink, renderPaths(path.join(realDir, "config.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionState parses with camelCase fields and keeps the protocol shape", () => {
  const parsed = normalizeRenderSessionState({
    sessionId: "s1",
    incarnationId: "u1",
    pid: 42,
    status: "running",
    exitCode: null,
    cols: 100,
    rows: 30,
    seq: 3,
    output: "abc",
    chunks: [{ data: "abc", seq: 3 }],
    terminalSnapshot: {
      version: 1,
      data: "abc",
      cols: 100,
      rows: 30,
      pending: [{ type: "data", data: "ab" }, { type: "resize", cols: 90, rows: 20 }],
    },
    launchMarkerToken: "marker",
  });
  assert.ok(parsed);
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsed.incarnationId, "u1");
  assert.equal(parsed.status, "running");
  assert.equal(parsed.exitCode, null);
  assert.equal(parsed.launchMarkerToken, "marker");
  assert.deepEqual(parsed.chunks, [{ data: "abc", seq: 3 }]);
  assert.deepEqual(parsed.terminalSnapshot, {
    version: 1,
    data: "abc",
    cols: 100,
    rows: 30,
    pending: [{ type: "data", data: "ab" }, { type: "resize", cols: 90, rows: 20 }],
  });
});

test("malformed SessionState is repaired loudly instead of crashing the client", () => {
  // 缺 sessionId 的整条丢弃（无法挂到 inventory 上）。
  assert.equal(normalizeRenderSessionState({ incarnationId: "u1" }), null);
  assert.equal(normalizeRenderSessionState("nope"), null);
  assert.equal(normalizeRenderSessionState(null), null);

  // 字段类型不符时补默认值继续用，但快照版本不认识就必须丢掉，否则客户端画出错误屏幕。
  const repaired = normalizeRenderSessionState({
    sessionId: "s2",
    incarnationId: "u2",
    pid: "42",
    cols: null,
    rows: undefined,
    seq: "9",
    status: "weird",
    output: 5,
    chunks: [{ data: "ok", seq: 1 }, { data: 2, seq: 2 }, null],
    terminalSnapshot: { version: 2, data: "x", cols: 1, rows: 1, pending: [] },
  });
  assert.ok(repaired);
  assert.equal(repaired.pid, 0);
  assert.equal(repaired.cols, 80);
  assert.equal(repaired.rows, 24);
  assert.equal(repaired.seq, 0);
  assert.equal(repaired.status, "exited");
  assert.equal(repaired.output, "");
  assert.deepEqual(repaired.chunks, [{ data: "ok", seq: 1 }]);
  assert.equal(repaired.terminalSnapshot, null);
});

// ── socket 级联调：用一个假 Render 验证客户端语义（不依赖 Rust 二进制）──

interface FakeRenderRequest {
  id: number;
  method: string;
  token: string;
  protocolVersion: number;
  params?: Record<string, unknown>;
}

class FakeRender {
  readonly requests: FakeRenderRequest[] = [];
  readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server;
  private helloProtocolVersion = RENDER_PROTOCOL_VERSION;
  private sessions: unknown[] = [];
  private listFrameLimit = false;
  private floodDuringList = false;
  private rejectWrites = false;
  /** createOrAttach 之前先推一条 data 事件，模拟「响应还没到、输出已经来了」。 */
  private emitDataBeforeCreateResponse = false;

  constructor(readonly socketPath: string) {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        const decoded = decodeRenderFrames<FakeRenderRequest>(Buffer.concat([buffer, chunk]));
        buffer = decoded.rest;
        for (const request of decoded.frames) this.handle(socket, request);
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => this.sockets.delete(socket));
    });
  }

  setHelloProtocolVersion(version: number): this {
    this.helloProtocolVersion = version;
    return this;
  }

  setSessions(sessions: unknown[]): this {
    this.sessions = sessions;
    return this;
  }

  rejectOversizedList(): this {
    this.listFrameLimit = true;
    return this;
  }

  floodListResponse(): this {
    this.floodDuringList = true;
    return this;
  }

  rejectConfirmedWrites(): this {
    this.rejectWrites = true;
    return this;
  }

  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  pushData(sessionId: string, seq: number, data: string): void {
    for (const socket of this.sockets) {
      socket.write(encodeRenderFrame({
        event: "data", sessionId, incarnationId: `${sessionId}-inc`, seq, data,
      }));
    }
  }

  pushDataBeforeCreateResponse(): this {
    this.emitDataBeforeCreateResponse = true;
    return this;
  }

  /** 主动推一帧 reconcile，模拟 Render 清掉了那些会话（例如自身重启后丢弃）。 */
  async pushReconcile(sessionIds: string[]): Promise<void> {
    for (const socket of this.sockets) {
      socket.write(encodeRenderFrame({ event: "reconcile", sessionIds }));
    }
  }

  methods(): string[] {
    return this.requests.map((request) => request.method);
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(this.socketPath, resolve));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: net.Socket, request: FakeRenderRequest): void {
    this.requests.push(request);
    const respond = (result: unknown) => socket.write(encodeRenderFrame({ id: request.id, ok: true, result }));
    switch (request.method) {
      case "hello":
        respond({
          version: "0.1.0",
          protocolVersion: this.helloProtocolVersion,
          pid: 999,
          startedAt: "2026-01-01T00:00:00.000Z",
          sessions: this.sessions.length,
        });
        return;
      case "list":
        if (this.floodDuringList) {
          const sessionId = (this.sessions[0] as { sessionId?: string } | undefined)?.sessionId;
          if (sessionId) {
            for (let seq = 1; seq <= 600; seq += 1) {
              socket.write(encodeRenderFrame({
                event: "data", sessionId, incarnationId: `${sessionId}-inc`, seq, data: "x",
              }));
            }
          }
        }
        if (this.listFrameLimit) {
          socket.write(encodeRenderFrame({
            id: request.id, ok: false,
            error: { code: "internal", message: "list response exceeds MAX_FRAME_BYTES frame limit" },
          }));
        } else {
          // v1 list is only a preview; attach has the full terminal snapshot.
          respond({ sessions: this.sessions.map((entry) => ({ ...(entry as object), terminalSnapshot: null })) });
        }
        return;
      case "attach": {
        const state = this.sessions.find((entry) => (entry as { sessionId?: string }).sessionId === request.params?.sessionId);
        if (!state) {
          socket.write(encodeRenderFrame({
            id: request.id, ok: false, error: { code: "notFound", message: "session missing" },
          }));
        } else {
          respond({ state });
        }
        return;
      }
      case "createOrAttach": {
        const sessionId = String(request.params?.sessionId ?? "");
        const state = sessionState(sessionId, Number(request.params?.cols ?? 80), Number(request.params?.rows ?? 24));
        if (this.emitDataBeforeCreateResponse) {
          socket.write(encodeRenderFrame({ event: "data", sessionId, incarnationId: state.incarnationId, data: "early", seq: 1 }));
        }
        respond({ state, isNew: true });
        return;
      }
      case "forget":
        respond({});
        return;
      case "write":
        if (this.rejectWrites) {
          socket.write(encodeRenderFrame({
            id: request.id, ok: false, error: { code: "internal", message: "write rejected" },
          }));
        } else {
          respond({});
        }
        return;
      default:
        respond({});
    }
  }
}

function sessionState(sessionId: string, cols = 80, rows = 24, seq = 0, chunks: { data: string; seq: number }[] = []) {
  return {
    sessionId,
    incarnationId: `${sessionId}-inc`,
    pid: 1234,
    status: "running" as const,
    exitCode: null,
    cols,
    rows,
    seq,
    output: chunks.map((chunk) => chunk.data).join(""),
    chunks,
    terminalSnapshot: null,
    launchMarkerToken: null,
  };
}

async function waitFor(probe: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function withFakeRender(
  configure: (fake: FakeRender) => void,
  body: (fake: FakeRender, client: RenderDaemonClient) => Promise<void>,
  knownSessionIds: readonly string[] = [],
): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-render-client-"));
  const socketPath = path.join(dir, "render.sock");
  const fake = new FakeRender(socketPath);
  configure(fake);
  await fake.listen();
  const client = new RenderDaemonClient(socketPath, "test-token", null, knownSessionIds);
  try {
    await body(fake, client);
  } finally {
    client.disconnect();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("connect refuses a daemon with a mismatched protocol version instead of degrading", async () => {
  await withFakeRender(
    (fake) => { fake.setHelloProtocolVersion(RENDER_PROTOCOL_VERSION + 1); },
    async (fake, client) => {
      await assert.rejects(() => client.connect(), /protocol version mismatch/i);
      assert.match(String(await client.connect().catch((error: unknown) => String(error))), /1/);
      // 版本不符时不允许继续 list/createOrAttach —— 否则会带着错误契约操作 PTY。
      assert.deepEqual(fake.methods(), ["hello", "hello"]);
    },
  );
});

test("connect adopts the inventory and attach replays only chunks after afterSeq", async () => {
  await withFakeRender(
    (fake) => {
      fake.setSessions([sessionState("s1", 100, 30, 3, [
        { data: "a", seq: 1 },
        { data: "b", seq: 2 },
        { data: "c", seq: 3 },
      ])]);
    },
    async (fake, client) => {
      await client.connect();
      assert.equal(client.persistent, true);
      assert.equal(client.version, "0.1.0");
      assert.deepEqual(fake.methods(), ["hello", "list", "attach"]);

      const attached = client.attach("s1", 2);
      assert.ok(attached);
      assert.equal(attached.isNew, false);
      assert.deepEqual(attached.replay, [{ data: "c", seq: 3 }]);
      assert.equal(attached.state.cols, 100);
      assert.equal(attached.state.pid, 1234);

      assert.equal(client.attach("unknown"), null);
    },
  );
});

test("startup recovery uses the full attach snapshot instead of the clipped list preview", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([{
      ...sessionState("wide"),
      terminalSnapshot: { version: 1, data: "full wide screen", cols: 100, rows: 30, pending: [] },
    }]),
    async (fake, client) => {
      await client.connect();
      assert.deepEqual(fake.methods(), ["hello", "list", "attach"]);
      assert.equal(client.attach("wide")?.state.terminalSnapshot?.data, "full wide screen");
    },
  );
});

test("oversized v1 list recovers persisted PTYs with individual attaches", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([sessionState("saved")]).rejectOversizedList(),
    async (fake, client) => {
      await client.connect();
      assert.equal(client.attach("saved")?.state.sessionId, "saved");
      assert.deepEqual(fake.methods(), ["hello", "list", "attach", "attach"]);
      assert.equal(fake.requests.filter((request) => request.method === "attach")[1]?.params?.sessionId, "stale");
    },
    ["saved", "stale"],
  );
});

test("oversized v1 list with no persisted PTYs still permits a new Server owner", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([sessionState("daemon-only")]).rejectOversizedList(),
    async (fake, client) => {
      await client.connect();
      assert.equal(client.attach("daemon-only"), null);
      assert.deepEqual(fake.methods(), ["hello", "list"]);
    },
  );
});

test("reconnect rebuilds from attach when bounded replay has a sequence gap", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([sessionState("gap", 80, 24, 1, [{ data: "a", seq: 1 }])]),
    async (fake, client) => {
      await client.connect();
      const process = client.attach("gap")?.process;
      assert.ok(process);
      const replayed: TerminalDataEvent[] = [];
      const resynced: string[] = [];
      process.onData((event) => replayed.push(event));
      process.onResync?.((state) => resynced.push(state.output));
      fake.setSessions([sessionState("gap", 80, 24, 4, [
        { data: "c", seq: 3 }, { data: "d", seq: 4 },
      ])]);
      fake.dropConnections();
      await waitFor(() => resynced.length === 1, "missing full resync after replay gap", 4_000);
      assert.deepEqual(resynced, ["cd"]);
      assert.deepEqual(replayed, []);
      assert.equal(client.attach("gap")?.state.seq, 4);
    },
  );
});

test("reconnect replays contiguous chunks without replacing the terminal snapshot", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([sessionState("continuous", 80, 24, 1, [{ data: "a", seq: 1 }])]),
    async (fake, client) => {
      await client.connect();
      const process = client.attach("continuous")?.process;
      assert.ok(process);
      const replayed: TerminalDataEvent[] = [];
      const resynced: number[] = [];
      process.onData((event) => replayed.push(event));
      process.onResync?.((state) => resynced.push(state.seq));
      fake.setSessions([sessionState("continuous", 80, 24, 3, [
        { data: "a", seq: 1 }, { data: "b", seq: 2 }, { data: "c", seq: 3 },
      ])]);
      fake.dropConnections();
      await waitFor(() => replayed.length === 2, "missing contiguous replay", 4_000);
      assert.deepEqual(replayed, [{ data: "b", seq: 2 }, { data: "c", seq: 3 }]);
      assert.deepEqual(resynced, []);
    },
  );
});

test("reconnect delivers final output before an exit from the same incarnation", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([sessionState("exiting", 80, 24, 1, [{ data: "a", seq: 1 }])]),
    async (fake, client) => {
      await client.connect();
      const process = client.attach("exiting")?.process;
      assert.ok(process);
      const order: string[] = [];
      process.onData((event) => order.push(`data:${event.data}`));
      process.onExit((event) => order.push(`exit:${event.exitCode}`));
      fake.setSessions([{
        ...sessionState("exiting", 80, 24, 2, [
          { data: "a", seq: 1 }, { data: "final", seq: 2 },
        ]),
        status: "exited", exitCode: 0,
      }]);
      fake.dropConnections();
      await waitFor(() => order.length === 2, "missing final output or exit", 4_000);
      assert.deepEqual(order, ["data:final", "exit:0"]);
    },
  );
});

test("startup event-buffer overflow refreshes the full state after listener binding", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([sessionState("flood")]),
    async (fake, client) => {
      await client.connect();
      fake.setSessions([{
        ...sessionState("flood", 80, 24, 600, [{ data: "last", seq: 600 }]),
        terminalSnapshot: { version: 1, data: "complete screen", cols: 80, rows: 24, pending: [] },
      }]);
      for (let seq = 1; seq <= 600; seq += 1) fake.pushData("flood", seq, "x");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const process = client.attach("flood")?.process;
      assert.ok(process);
      const replayed: TerminalDataEvent[] = [];
      const refreshed: TerminalSessionState[] = [];
      process.onResync?.((state) => refreshed.push(state));
      process.onData((event) => replayed.push(event));
      await waitFor(() => refreshed.length === 1, "overflow did not trigger an attach resync");
      assert.equal(refreshed[0].seq, 600);
      assert.equal(refreshed[0].terminalSnapshot?.data, "complete screen");
      assert.deepEqual(replayed, []);
    },
  );
});

test("reconnect-inventory event burst remains bounded and refreshes after adoption", async () => {
  await withFakeRender(
    (fake) => fake.setSessions([{
      ...sessionState("burst", 80, 24, 600, [{ data: "last", seq: 600 }]),
      terminalSnapshot: { version: 1, data: "complete burst screen", cols: 80, rows: 24, pending: [] },
    }]).floodListResponse(),
    async (fake, client) => {
      await client.connect();
      const process = client.attach("burst")?.process;
      assert.ok(process);
      const refreshed: TerminalSessionState[] = [];
      process.onResync?.((state) => refreshed.push(state));
      await waitFor(() => refreshed.length === 1, "bounded sync burst did not refresh");
      assert.equal(refreshed[0].terminalSnapshot?.data, "complete burst screen");
      assert.equal(fake.methods().filter((method) => method === "attach").length, 2);
    },
  );
});

test("createOrAttach sends the frozen camelCase params and buffers early output", async () => {
  await withFakeRender(
    (fake) => { fake.pushDataBeforeCreateResponse(); },
    async (fake, client) => {
      await client.connect();
      const result = await client.createOrAttach({
        sessionId: "s2",
        file: "/bin/zsh",
        args: ["-l"],
        cwd: "/tmp",
        env: { LANG: "zh_CN.UTF-8", EMPTY: undefined } as NodeJS.ProcessEnv,
        name: "xterm-256color",
        cols: 132,
        rows: 40,
        launchMarkerToken: "marker-1",
      }, 0);
      assert.equal(result.isNew, true);
      assert.ok(result.process);

      const params = fake.requests.find((request) => request.method === "createOrAttach")?.params;
      assert.ok(params);
      assert.deepEqual(params, {
        sessionId: "s2",
        file: "/bin/zsh",
        args: ["-l"],
        cwd: "/tmp",
        // env 里 undefined 的值不能进协议（Rust 侧只接受字符串 map）。
        env: { LANG: "zh_CN.UTF-8" },
        name: "xterm-256color",
        cols: 132,
        rows: 40,
        launchMarkerToken: "marker-1",
        afterSeq: 0,
      });

      // 事件可能早于响应到达；listener 挂上后必须补发，否则首屏会丢输出。
      const received: TerminalDataEvent[] = [];
      result.process.onData((event) => received.push(event));
      await waitFor(() => received.length > 0, "buffered data event was never delivered");
      assert.deepEqual(received, [{ data: "early", seq: 1 }]);

      // 第二次 createOrAttach 命中本地 inventory，不再打 daemon。
      await client.createOrAttach({
        sessionId: "s2", file: "/bin/zsh", args: [], cwd: "/tmp", env: {},
        name: "xterm-256color", cols: 80, rows: 24,
      });
      assert.equal(fake.methods().filter((method) => method === "createOrAttach").length, 1);
    },
  );
});

test("reconcile events finalize handles the daemon no longer owns", async () => {
  await withFakeRender(
    () => {},
    async (fake, client) => {
      await client.connect();
      const result = await client.createOrAttach({
        sessionId: "s3", file: "/bin/zsh", args: [], cwd: "/tmp", env: {},
        name: "xterm-256color", cols: 80, rows: 24,
      });
      const exits: unknown[] = [];
      result.process!.onExit((event) => exits.push(event));
      await fake.pushReconcile([]);
      await waitFor(() => exits.length > 0, "reconcile did not finalize the orphaned handle");
      // Render 说这条会话已经不属于它 → 句柄必须收到退出，否则会永远停在 running。
      assert.deepEqual(exits, [{ exitCode: -1 }]);
    },
  );
});

test("confirmed PTY writes expose a Render rejection to the caller", async () => {
  await withFakeRender(
    (fake) => { fake.rejectConfirmedWrites(); },
    async (fake, client) => {
      await client.connect();
      const attached = await client.createOrAttach({
        sessionId: "write-failure", file: "/bin/zsh", args: [], cwd: "/tmp", env: {},
        name: "xterm-256color", cols: 80, rows: 24,
      });
      assert.ok(attached.process?.writeConfirmed);
      await assert.rejects(attached.process.writeConfirmed("echo test\r"), /write rejected/);
      assert.equal(fake.methods().filter((method) => method === "write").length, 1);
    },
  );
});

test("disconnect only unbinds: no kill/shutdown is sent to Render", async () => {
  await withFakeRender(
    () => {},
    async (fake, client) => {
      await client.connect();
      await client.createOrAttach({
        sessionId: "s4", file: "/bin/zsh", args: [], cwd: "/tmp", env: {},
        name: "xterm-256color", cols: 80, rows: 24,
      });
      const process = client.attach("s4")?.process;
      assert.ok(process);
      client.disconnect();
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Server 重启路径不得触碰 PTY：既没有 kill，也没有 shutdown。
      assert.equal(fake.methods().includes("kill"), false);
      assert.equal(fake.methods().includes("shutdown"), false);
      await waitFor(() => fake.sockets.size === 0, "Render socket stayed open after disconnect");
      // disconnect 之后的操作只能是 best-effort 失败，不能抛给调用方。
      assert.doesNotThrow(() => process.write("x"));
      assert.doesNotThrow(() => process.kill("SIGTERM"));
    },
  );
});
