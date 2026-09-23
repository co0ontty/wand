import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  readRenderBinaryVersion,
  renderBinaryCandidates,
  resolveRenderBinaryPath,
  resolveRenderTriple,
} from "../src/render-binary.js";
import { RenderAuthError, RenderDaemonClient } from "../src/render-daemon-client.js";
import { RENDER_PROTOCOL_VERSION, decodeRenderFrames, encodeRenderFrame } from "../src/render-protocol.js";

import { CompositeTerminalHost, resolveRenderEngine } from "../src/render-host.js";
import type {
  TerminalAttachResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalHost,
  TerminalProcess,
  TerminalSessionState,
  TerminalSpawnRequest,
} from "../src/terminal-host.js";

class FakeTerminalProcess implements TerminalProcess {
  readonly incarnationId: string;
  readonly pid = 4242;
  killCalls = 0;

  constructor(readonly sessionId: string, incarnationId: string) {
    this.incarnationId = incarnationId;
  }

  write(): void {}
  resize(): void {}
  kill(): void { this.killCalls += 1; }
  onData(_listener: (event: TerminalDataEvent) => void): { dispose(): void } { return { dispose: () => {} }; }
  onExit(_listener: (event: TerminalExitEvent) => void): { dispose(): void } { return { dispose: () => {} }; }
}

/** 最小可用 TerminalHost 假件：只记录被路由过来的请求。 */
class FakeHost implements TerminalHost {
  readonly persistent = true;
  readonly spawns: string[] = [];
  readonly forgotten: string[] = [];
  readonly attachCalls: string[] = [];
  disconnects = 0;
  readonly processes = new Map<string, FakeTerminalProcess>();

  constructor(private readonly owned: Set<string>) {}

  attach(sessionId: string): TerminalAttachResult | null {
    this.attachCalls.push(sessionId);
    if (!this.owned.has(sessionId)) return null;
    return this.result(sessionId, false);
  }

  async createOrAttach(request: TerminalSpawnRequest): Promise<TerminalAttachResult> {
    this.spawns.push(request.sessionId);
    this.owned.add(request.sessionId);
    return this.result(request.sessionId, true);
  }

  forget(sessionId: string): void {
    this.forgotten.push(sessionId);
    this.owned.delete(sessionId);
  }

  disconnect(): void {
    // 只解绑：假件里没有任何 kill 调用，这正是断言「分离时没有杀 PTY」的依据。
    this.disconnects += 1;
  }

  totalKillCalls(): number {
    return Array.from(this.processes.values()).reduce((sum, process) => sum + process.killCalls, 0);
  }

  private result(sessionId: string, isNew: boolean): TerminalAttachResult {
    const process = this.processes.get(sessionId) ?? new FakeTerminalProcess(sessionId, `${sessionId}-inc`);
    this.processes.set(sessionId, process);
    const state: TerminalSessionState = {
      sessionId,
      incarnationId: process.incarnationId,
      pid: process.pid,
      status: "running",
      exitCode: null,
      cols: 80,
      rows: 24,
      seq: 0,
      output: "",
      chunks: [],
      terminalSnapshot: null,
      launchMarkerToken: null,
    };
    return { process, state, replay: [], isNew };
  }
}

function spawnRequest(sessionId: string): TerminalSpawnRequest {
  return {
    sessionId,
    file: "/bin/zsh",
    args: [],
    cwd: "/tmp",
    env: {},
    name: "xterm-256color",
    cols: 80,
    rows: 24,
  };
}

test("attach prefers the legacy daemon for pre-upgrade sessions", () => {
  const legacy = new FakeHost(new Set(["old-session"]));
  const render = new FakeHost(new Set());
  const host = new CompositeTerminalHost({ legacy, render });

  const attached = host.attach("old-session");
  assert.ok(attached);
  assert.equal(attached.process?.sessionId, "old-session");
  // 命中 legacy 后不能再去 Render 查一遍（否则会多挂一个句柄）。
  assert.deepEqual(render.attachCalls, []);
});

test("attach falls back to Render for sessions the legacy daemon does not own", () => {
  const legacy = new FakeHost(new Set(["old-session"]));
  const render = new FakeHost(new Set(["new-session"]));
  const host = new CompositeTerminalHost({ legacy, render });

  const attached = host.attach("new-session");
  assert.ok(attached);
  assert.equal(attached.process?.sessionId, "new-session");
  assert.deepEqual(legacy.attachCalls, ["new-session"]);
});

test("attach returns null when neither side owns the session", () => {
  const host = new CompositeTerminalHost({ legacy: new FakeHost(new Set()), render: new FakeHost(new Set()) });
  assert.equal(host.attach("missing"), null);
});

test("new sessions always land in Render, legacy-owned sessions stay where their PTY lives", async () => {
  const legacy = new FakeHost(new Set(["old-session"]));
  const render = new FakeHost(new Set());
  const host = new CompositeTerminalHost({ legacy, render });

  const fresh = await host.createOrAttach(spawnRequest("brand-new"));
  assert.equal(fresh.isNew, true);
  assert.deepEqual(render.spawns, ["brand-new"]);
  assert.deepEqual(legacy.spawns, []);

  // legacy inventory 里已有这个 session → 交给 legacy，避免同一会话出现两个 PTY。
  await host.createOrAttach(spawnRequest("old-session"));
  assert.deepEqual(legacy.spawns, ["old-session"]);
  assert.deepEqual(render.spawns, ["brand-new"]);
});

test("a legacy host that throws during ownership probing never swallows the request", async () => {
  const brokenLegacy: TerminalHost = {
    persistent: true,
    attach: () => { throw new Error("daemon socket died"); },
    createOrAttach: async () => { throw new Error("must not be called"); },
    forget: () => {},
    disconnect: () => {},
  };
  const render = new FakeHost(new Set());
  const host = new CompositeTerminalHost({ legacy: brokenLegacy, render });

  assert.equal(host.attach("x"), null);
  const created = await host.createOrAttach(spawnRequest("x"));
  assert.equal(created.isNew, true);
  assert.deepEqual(render.spawns, ["x"]);
});

test("forget and disconnect unbind both engines without killing anything", () => {
  const legacy = new FakeHost(new Set(["old-session"]));
  const render = new FakeHost(new Set(["new-session"]));
  const host = new CompositeTerminalHost({ legacy, render });
  host.attach("old-session");
  host.attach("new-session");

  host.forget("old-session");
  assert.deepEqual(legacy.forgotten, ["old-session"]);
  assert.deepEqual(render.forgotten, ["old-session"]);

  host.disconnect();
  assert.equal(legacy.disconnects, 1);
  assert.equal(render.disconnects, 1);
  // Server/Render 分离的核心：解绑不等于杀进程。旧会话的 PTY 必须继续跑。
  assert.equal(legacy.totalKillCalls(), 0);
  assert.equal(render.totalKillCalls(), 0);
});

test("render engine resolution prefers the environment and rejects unknown values", () => {
  assert.equal(resolveRenderEngine("rust", "legacy"), "rust");
  assert.equal(resolveRenderEngine("legacy", "rust"), "legacy");
  assert.equal(resolveRenderEngine(" AUTO ", undefined), "auto");
  // 非法环境变量退回 config，再退回 auto —— 不会因为写错一个词就改变进程所有权。
  assert.equal(resolveRenderEngine("nonsense", "legacy"), "legacy");
  assert.equal(resolveRenderEngine("nonsense", undefined), "auto");
  assert.equal(resolveRenderEngine(undefined, "rust"), "rust");
  assert.equal(resolveRenderEngine(undefined, undefined), "auto");
});

test("binary resolution honours WAND_RENDER_BIN and prefers the version sidecar", async (t) => {
  if (process.platform === "win32") t.skip("the fixture binary is a POSIX shell script");

  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-render-bin-"));
  const binary = path.join(dir, "wand-render");
  writeFileSync(binary, "#!/bin/sh\necho 'wand-render 9.9.9'\n", { mode: 0o755 });
  const previousBin = process.env.WAND_RENDER_BIN;
  process.env.WAND_RENDER_BIN = binary;
  try {
    // 显式配置优先于所有约定位置（否则排查时改了路径不生效）。
    assert.equal(resolveRenderBinaryPath("/tmp/wand-render-test/config.json"), binary);

    // sidecar 由就位脚本写入：读它就不必在启动路径上执行一个进程。
    writeFileSync(path.join(dir, "wand-render.version"), "1.2.3\n");
    assert.equal(await readRenderBinaryVersion(binary), "1.2.3");

    // sidecar 损坏时回落到 `--version`，而不是把「版本未知」当成没装。
    writeFileSync(path.join(dir, "wand-render.version"), "not-a-version\n");
    assert.equal(await readRenderBinaryVersion(binary), "9.9.9");

    // 二进制不存在时返回 null，而不是把失败留到 spawn 路径上。
    assert.equal(await readRenderBinaryVersion(path.join(dir, "missing")), null);
  } finally {
    if (previousBin === undefined) delete process.env.WAND_RENDER_BIN;
    else process.env.WAND_RENDER_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 探测路径与三元组：新分发布局 + Rosetta ──

test("binary discovery only looks at the new layout", () => {
  const candidates = renderBinaryCandidates("/tmp/wand-render-test", "darwin-arm64");

  // 旧布局（wand-rs/、仓库根 native/）已不存在，候选里不能再有它们：
  // 留着只会让「引擎为什么没生效」多一个静默的假来源。
  assert.equal(candidates.some((candidate) => candidate.includes("wand-rs")), false);
  assert.equal(candidates.some((candidate) => /(^|\/)native\//.test(candidate) && !candidate.includes("/dist/")), false);

  assert.match(candidates[0], /render\/target\/release\/wand-render$/);
  assert.match(candidates[1], /render\/target\/debug\/wand-render$/);
  assert.equal(candidates[2], path.join("/tmp/wand-render-test", "bin", "wand-render"));
  assert.match(candidates[3], /dist\/native\/darwin-arm64\/wand-render$/);
});

test("the render triple follows uname -m so Rosetta does not pick the wrong artifact", () => {
  // Node 在 Rosetta 下报 x64，机器其实是 arm64：只有 uname 能纠回来。
  assert.equal(resolveRenderTriple("darwin", "x64", "arm64"), "darwin-arm64");
  assert.equal(resolveRenderTriple("darwin", "arm64", "arm64"), "darwin-arm64");
  assert.equal(resolveRenderTriple("darwin", "x64", "x86_64"), "darwin-x64");
  // 反向兜底：翻译态下 `uname -m` 也报 x86_64，只有 sysctl 能说明真实硬件。
  assert.equal(resolveRenderTriple("darwin", "x64", "x86_64", true), "darwin-arm64");
  // 只有 uname 拿不到时才回退 process.arch。
  assert.equal(resolveRenderTriple("darwin", "x64", null), "darwin-x64");
  assert.equal(resolveRenderTriple("linux", "x64", "aarch64"), "linux-arm64");
  assert.equal(resolveRenderTriple("linux", "arm64", "x86_64"), "linux-x64");
});

// ── 凭据轮换与重连：假 Render（只认 token + hello/list）──

class FakeRender {
  readonly sockets = new Set<net.Socket>();
  readonly helloTokens: string[] = [];
  attempts = 0;
  private expectedToken: string;
  private readonly server: net.Server;

  constructor(readonly socketPath: string, expectedToken: string) {
    this.expectedToken = expectedToken;
    this.server = net.createServer((socket) => {
      this.attempts += 1;
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        const decoded = decodeRenderFrames<{ id: number; method: string; token: string }>(Buffer.concat([buffer, chunk]));
        buffer = decoded.rest;
        for (const request of decoded.frames) {
          if (request.method === "hello") this.helloTokens.push(request.token);
          // 与 Rust 侧一致：token 不符就立刻关连接，一个字节都不回。
          if (request.token !== this.expectedToken) {
            socket.destroy();
            return;
          }
          const result = request.method === "hello"
            ? { version: "0.1.0", protocolVersion: RENDER_PROTOCOL_VERSION, pid: 1, startedAt: "", sessions: 0 }
            : { sessions: [] };
          socket.write(encodeRenderFrame({ id: request.id, ok: true, result }));
        }
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => this.sockets.delete(socket));
    });
  }

  /** 模拟 daemon 重启：每次启动都会 `generate_token()` 轮换。 */
  rotateToken(token: string): void {
    this.expectedToken = token;
  }

  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(this.socketPath, resolve));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function waitFor(probe: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/** 让真实 I/O 的若干轮事件循环跑完（配合 mock timers 时不能用 setTimeout）。 */
async function settleIo(turns = 50): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface TokenFixture {
  client: RenderDaemonClient;
  fake: FakeRender;
  tokenPath: string;
  writeToken(value: string): void;
}

async function withTokenFixture(
  options: { constructorToken: string; fileToken: string; daemonToken: string },
  body: (fixture: TokenFixture) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-render-token-"));
  const socketPath = path.join(dir, "render.sock");
  const tokenPath = path.join(dir, ".render.token");
  writeFileSync(tokenPath, `${options.fileToken}\n`, { mode: 0o600 });
  const fake = new FakeRender(socketPath, options.daemonToken);
  await fake.listen();
  const client = new RenderDaemonClient(socketPath, options.constructorToken, tokenPath);
  try {
    await body({
      client,
      fake,
      tokenPath,
      writeToken: (value: string) => writeFileSync(tokenPath, `${value}\n`),
    });
  } finally {
    client.disconnect();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("adoption uses the token file, not the credential captured at construction", async () => {
  // Render 每次启动都会轮换 token。上游用构造期那一把的客户端在 daemon 重启后会永远
  // 鉴权失败（createOrAttach 全挂、错误只显示 unavailable，旧会话被永久报成 running）。
  await withTokenFixture(
    { constructorToken: "old-credential", fileToken: "rotated-credential", daemonToken: "rotated-credential" },
    async ({ client, fake }) => {
      await client.connect();
      assert.equal(client.version, "0.1.0");
      assert.deepEqual(fake.helloTokens, ["rotated-credential"]);
    },
  );
});

test("an automatic reconnect re-reads the rotated token instead of retrying the stale one", async () => {
  await withTokenFixture(
    { constructorToken: "t1", fileToken: "t1", daemonToken: "t1" },
    async ({ client, fake, writeToken }) => {
      await client.connect();
      assert.deepEqual(fake.helloTokens, ["t1"]);

      // daemon 重启：轮换 token 并断开所有连接 —— 客户端必须自愈（重读文件）后 adopt 回来。
      writeToken("t2");
      fake.rotateToken("t2");
      fake.dropConnections();

      await waitFor(() => fake.helloTokens.includes("t2"), "client never reconnected with the rotated token");
    },
  );
});

test("a silently rejected credential backs off instead of retrying every 10s", async (t) => {
  await withTokenFixture(
    { constructorToken: "stale", fileToken: "stale", daemonToken: "live" },
    async ({ client, fake }) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const error = await client.connect().catch((value: unknown) => value);
        // 「连接被接受、hello 发出后被静默关闭」是凭据问题的特征，不是网络抖动。
        assert.ok(error instanceof RenderAuthError, `expected RenderAuthError, got ${String(error)}`);
        assert.match(error.message, /closed the connection without answering/);

        // 第一次失败仍按初始退避再试一次（daemon 可能正在重启）。
        t.mock.timers.tick(500);
        await settleIo();
        assert.equal(fake.attempts, 2);

        // 但同一把被拒的凭据不该 10s 一遍地刷：这个窗口里不能有第三次尝试。
        t.mock.timers.tick(10_000);
        await settleIo();
        assert.equal(fake.attempts, 2);

        // 一分钟后再试；每次都会重读 token 文件，daemon 重启或文件被修正后即自愈。
        t.mock.timers.tick(50_000);
        await settleIo();
        assert.equal(fake.attempts, 3);
      } finally {
        t.mock.timers.reset();
      }
    },
  );
});
