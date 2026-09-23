/**
 * Render/Server 分离的端到端（协议层）回归测试。
 *
 * 这些用例直接对着**真实 release 二进制**跑 Render 协议，覆盖三类最容易回归、
 * 又恰好是单元测试覆盖不到的行为：
 *
 * 1. Render 守护进程被杀 + 同 config 重启（token 轮换）后，旧客户端必须能自愈；
 * 2. `shutdown {mode:"drain"}` 必须保留运行中的 PTY 与进程（协议 §6）；
 * 3. `attach` 拿到的是**当前**状态（resize 之后 cols/rows 必须刷新）；
 * 4. 连接前拒绝不属于本用户的 socket（/tmp 抢注竞态）。
 *
 * 没有二进制时整组 skip（不 fail），这样没有 Rust 工具链的机器也能跑 `npm test`。
 * 需要更完整的「Server 重启 PTY 不丢 + Web/Android 客户端 profile」验证时跑
 * `scripts/verify-render-e2e.sh`。
 *
 * 隔离：只在 `os.tmpdir()` 下建临时 config 目录，绝不读/写 `~/.wand`。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RenderDaemonClient, connectExistingRenderClient } from "../src/render-daemon-client.js";
import { currentRenderTriple, isExecutableFile } from "../src/render-binary.js";
import { decodeRenderFrames, encodeRenderFrame, renderPaths } from "../src/render-protocol.js";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 真实二进制从新分发布局里找：本地 cargo 产物优先，其次 render-bin 里 pin 住的发布产物
 * （npm 包内嵌的就是它）。旧路径 `wand-rs/target/**` 已不存在。
 */
function resolveRenderBinary(): string | null {
  const candidates = [
    process.env.WAND_RENDER_BIN?.trim(),
    path.join(REPO_ROOT, "render", "target", "release", "wand-render"),
    path.join(REPO_ROOT, "render", "target", "debug", "wand-render"),
    path.join(REPO_ROOT, "dist", "native", currentRenderTriple(), "wand-render"),
    pinnedRenderBinBinary(),
  ];
  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** render-bin 子模块里 pin 住的产物（按 manifest 的 latest + 当前平台）。 */
function pinnedRenderBinBinary(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "render-bin", "manifest.json"), "utf8"));
    const artifact = manifest?.versions?.[manifest.latest]?.triples?.[currentRenderTriple()];
    if (!artifact || typeof artifact.path !== "string") return null;
    return path.join(REPO_ROOT, "render-bin", artifact.path);
  } catch {
    return null;
  }
}

/**
 * 已 stage 进 `dist/native/<triple>` 的发布产物 —— npm 包里内嵌的**正是这一份**
 * （`scripts/stage-render-binaries.js` 从 render-bin 子模块拷贝过来）。
 * 开发机上的 `render/target/release` 只出现在源码仓库里，不会随包分发。
 */
const STAGED_DIST_BINARY = path.join(REPO_ROOT, "dist", "native", currentRenderTriple(), "wand-render");

const RENDER_BINARY = resolveRenderBinary();
const SKIP_REASON =
  "wand-render binary not found (run `npm run build:render-native`, or init the render-bin submodule)";

/**
 * fixture 目录要取 canonical 路径（`realpathSync`）：macOS 的 `os.tmpdir()` 在 `/var`
 * 下而 `/var` 是指向 `/private/var` 的符号链接，而**两侧的路径派生都按 canonical 路径**
 * 算 suffix。传非 canonical 路径会让 daemon 与客户端算出两个 socket（这本身就是升级
 * 时要用寻址归一化防住的故障，不是这里想测的东西）。
 */
function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, message: string | (() => string), timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  // message 允许传 thunk：诊断信息（例如「实际写了哪些文件」）必须在失败时刻才求值。
  throw new Error(typeof message === "function" ? message() : message);
}

/** 反复重试一个可能因为「Render 还没重连上」而失败的异步操作。 */
async function retry<T>(operation: () => Promise<T>, message: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (Date.now() > deadline) break;
      await delay(200);
    }
  }
  throw new Error(`${message} (last error: ${String(lastError)})`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface RenderFixture {
  dir: string;
  configPath: string;
  daemonPid: number;
  client: RenderDaemonClient;
  dispose(): Promise<void>;
}

/** 在临时 config 目录里起一个真实 daemon，并返回已 adopt 的客户端。 */
async function startFixture(): Promise<RenderFixture> {
  assert.ok(RENDER_BINARY, SKIP_REASON);
  const dir = tempDir("wand-render-e2e-");
  const configPath = path.join(dir, "config.json");
  // daemon 只用这个路径派生 socket/token（sha256 前 12 位），内容无关紧要。
  writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", port: 0 }), { mode: 0o600 });
  const daemonPid = await spawnDaemon(configPath);
  const client = await connectExistingRenderClient(configPath);
  assert.ok(client, "expected to adopt the freshly spawned daemon");
  let disposed = false;
  return {
    dir,
    configPath,
    daemonPid,
    client,
    async dispose() {
      if (disposed) return;
      disposed = true;
      client.disconnect();
      killPid(daemonPid);
      await waitFor(() => !processAlive(daemonPid), "expected the daemon to exit", 5_000).catch(() => undefined);
      // SIGKILL 不会走 daemon 自己的 cleanup：socket/token/pid/meta 要由测试清掉，
      // 否则 /tmp 会留下陈旧 socket，下一次启动会被误判成“有人占用”。
      removeRenderArtifacts(configPath);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function removeRenderArtifacts(configPath: string): void {
  const paths = renderPaths(configPath);
  for (const file of [paths.socketPath, paths.tokenPath, paths.pidPath, paths.metaPath]) {
    try { rmSync(file, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

async function spawnDaemon(configPath: string): Promise<number> {
  assert.ok(RENDER_BINARY, SKIP_REASON);
  const child = spawn(RENDER_BINARY, ["-c", configPath], { detached: true, stdio: "ignore" });
  child.unref();
  const { pidPath } = renderPaths(configPath);
  await waitFor(() => {
    try {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 && processAlive(pid);
    } catch {
      return false;
    }
  }, "expected the render daemon to publish its pid");
  return Number(readFileSync(pidPath, "utf8").trim());
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * 收尾一个「在 dir(s) 里按 config 起过」的 daemon：无论它把自己的 pid 写在哪个
 * suffix 上（这正是被测行为），都要杀掉并清掉对应 socket 文件。
 */
function killDaemonInDir(...dirs: string[]): void {
  const suffixes = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const match = /^\.render-([0-9a-f]+)\.pid$/.exec(name);
      if (!match) continue;
      suffixes.add(match[1]);
      const pid = Number(readFileSync(path.join(dir, name), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) killPid(pid);
    }
  }
  for (const suffix of suffixes) {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    try { rmSync(`/tmp/wand-render-${uid}-${suffix}.sock`, { force: true }); } catch { /* best-effort */ }
  }
}

function spawnRequest(sessionId: string, dir: string, cols = 80, rows = 24) {
  return {
    sessionId,
    file: "/bin/sh",
    args: [] as string[],
    cwd: dir,
    env: { TERM: "xterm-256color", PATH: process.env.PATH ?? "/usr/bin:/bin" },
    name: "xterm-256color",
    cols,
    rows,
  };
}

/** 直接对 Render socket 发一次 RPC（协议层，绕过 Node 客户端的缓存）。 */
function rawRenderRpc(configPath: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const { socketPath, tokenPath } = renderPaths(configPath);
  const token = readFileSync(tokenPath, "utf8").trim();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    const id = 1;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`render ${method} timed out`)); }, 10_000);
    const finish = (fn: (value: never) => void, value: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      fn(value as never);
    };
    socket.on("connect", () => {
      socket.write(encodeRenderFrame({ id, token, protocolVersion: 1, method, params }));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frames: { id?: number; ok?: boolean; result?: unknown; error?: unknown }[];
      try {
        frames = decodeRenderFrames<{ id?: number; ok?: boolean; result?: unknown; error?: unknown }>(buffer).frames;
      } catch {
        return;
      }
      for (const frame of frames) {
        if (frame.id !== id) continue;
        if (frame.ok) finish(resolve, frame.result);
        else finish(reject, new Error(`render ${method} failed: ${JSON.stringify(frame.error)}`));
      }
    });
    socket.on("error", (error) => finish(reject, error));
  });
}

test("reconnect after a daemon crash re-reads the rotated token and reconciles the lost PTY", { skip: RENDER_BINARY ? false : SKIP_REASON }, async () => {
  const fixture = await startFixture();
  let replacementDaemonPid: number | null = null;
  try {
    const sessionId = "blocker-token-rotation";
    const attached = await fixture.client.createOrAttach(spawnRequest(sessionId, fixture.dir));
    assert.equal(attached.isNew, true);
    assert.ok(attached.state.pid > 0);
    assert.ok(attached.process, "expected a live process handle");
    let exitCode: number | null | undefined;
    attached.process!.onExit((event) => { exitCode = event.exitCode; });

    // daemon 崩溃（等同 OOM / kill -9 / 升级）：新 daemon 会轮换 token 文件。
    killPid(fixture.daemonPid);
    await waitFor(() => !processAlive(fixture.daemonPid), "expected the daemon to die", 5_000);
    const secondPid = await spawnDaemon(fixture.configPath);
    replacementDaemonPid = secondPid;
    assert.notEqual(secondPid, fixture.daemonPid);

    // 1) 重连后能建新会话 = 轮换后的 token 生效。修复前这里会一直 `Render is unavailable`。
    const freshId = "blocker-token-rotation-fresh";
    const freshAttached = await retry(
      () => fixture.client.createOrAttach(spawnRequest(freshId, fixture.dir)),
      "expected createOrAttach to succeed after the daemon restarted with a rotated token",
    );
    assert.equal(freshAttached.isNew, true);

    // 2) 随旧 daemon 消失的会话必须被合成为 exit，而不是永远停在 running。
    await waitFor(() => exitCode !== undefined, "expected the orphaned PTY to be reconciled into an exit", 15_000);
    assert.equal(exitCode, -1);

    fixture.client.forget(freshId);
  } finally {
    if (replacementDaemonPid !== null) killPid(replacementDaemonPid);
    await fixture.dispose();
  }
});

test("shutdown drain keeps the daemon and its PTYs alive until a second signal", { skip: RENDER_BINARY ? false : SKIP_REASON }, async () => {
  const fixture = await startFixture();
  try {
    const sessionId = "blocker-drain";
    const attached = await fixture.client.createOrAttach(spawnRequest(sessionId, fixture.dir));
    const ptyPid = attached.state.pid;
    assert.ok(ptyPid > 0);

    await rawRenderRpc(fixture.configPath, "shutdown", { mode: "drain" });
    await delay(1_500);

    // 协议 §6：drain 只停止接受新会话，运行中会话与进程都要保留。
    assert.equal(processAlive(fixture.daemonPid), true, "drain must not terminate the daemon");
    assert.equal(processAlive(ptyPid), true, "drain must not kill running PTYs");
    const state = await rawRenderRpc(fixture.configPath, "attach", { sessionId }) as { state?: { status?: string } };
    assert.equal(state.state?.status, "running", "attach must still see the running session after drain");
    // 而新会话必须被拒绝（"停止接受新会话" 的另一半）。
    await assert.rejects(
      () => rawRenderRpc(fixture.configPath, "createOrAttach", { ...spawnRequest("after-drain", fixture.dir) }),
      /conflict/i,
    );
    assert.equal(processAlive(ptyPid), true, "a rejected createOrAttach must not disturb running PTYs");

    // 已经 drain 过之后再收到一次请求（这里用一个 SIGTERM 代表）才升级为 now。
    process.kill(fixture.daemonPid, "SIGTERM");
    await waitFor(() => !processAlive(fixture.daemonPid), "expected a second shutdown request to stop the drained daemon", 10_000);
    await waitFor(() => !processAlive(ptyPid), "expected the PTY to be gone once the daemon stopped", 5_000);
  } finally {
    await fixture.dispose();
  }
});

test("attach reflects a resize instead of frozen inventory values", { skip: RENDER_BINARY ? false : SKIP_REASON }, async () => {
  const fixture = await startFixture();
  try {
    const sessionId = "attach-resize";
    const attached = await fixture.client.createOrAttach(spawnRequest(sessionId, fixture.dir, 80, 24));
    assert.deepEqual([attached.state.cols, attached.state.rows], [80, 24]);

    attached.process!.resize(44, 9);
    // 客户端 inventory 必须立刻反映新尺寸；否则 attach() 会一直返回创建时刻的 80x24。
    const afterResize = fixture.client.attach(sessionId);
    assert.ok(afterResize, "expected attach() to return the session");
    assert.deepEqual([afterResize!.state.cols, afterResize!.state.rows], [44, 9]);

    // 并且 daemon 侧确实应用了（用原始 RPC 交叉验证，避免只改了本地缓存）。
    await waitFor(() => true, "noop", 100);
    const raw = await rawRenderRpc(fixture.configPath, "attach", { sessionId }) as { state?: { cols?: number; rows?: number } };
    assert.deepEqual([raw.state?.cols, raw.state?.rows], [44, 9]);
    fixture.client.forget(sessionId);
  } finally {
    await fixture.dispose();
  }
});

test("connect refuses a socket that is writable by other users", { skip: RENDER_BINARY ? false : SKIP_REASON }, async () => {
  const fixture = await startFixture();
  try {
    const { socketPath, tokenPath } = renderPaths(fixture.configPath);
    const token = readFileSync(tokenPath, "utf8").trim();
    // 模拟抢注场景的可见特征：socket 权限被放宽到谁都能写。真正的威胁是别的
    // uid 抢注，这里用权限位（同一套校验里的第二条）验证客户端会拒绝送 token。
    chmodSync(socketPath, 0o777);
    try {
      const rogue = new RenderDaemonClient(socketPath, token, tokenPath);
      await assert.rejects(() => rogue.connect(), /group\/other|not a unix socket/i);
      rogue.disconnect();
    } finally {
      chmodSync(socketPath, 0o600);
    }
  } finally {
    await fixture.dispose();
  }
});

test("connect refuses a non-socket file at the render socket path", { skip: RENDER_BINARY ? false : SKIP_REASON }, async () => {
  const dir = tempDir("wand-render-e2e-");
  let socketPath = "";
  try {
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, "{}", { mode: 0o600 });
    socketPath = renderPaths(configPath).socketPath;
    // 抢注者能做的第一步就是在 socket 路径上放一个普通文件；客户端必须在送出
    // token 之前就拒绝。
    writeFileSync(socketPath, "not a socket", { mode: 0o600 });
    const rogue = new RenderDaemonClient(socketPath, "irrelevant-token");
    await assert.rejects(() => rogue.connect(), /not a unix socket/i);
    rogue.disconnect();
  } finally {
    // 这个普通文件占的是真实 socket 路径，不清掉就会在 /tmp 永久留一份垃圾
    // （且名字与真正的 Render socket 无法区分）。
    if (socketPath) { try { rmSync(socketPath, { force: true }); } catch { /* best-effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the staged dist/native artifact derives the same render paths as the Server", {
  skip: isExecutableFile(STAGED_DIST_BINARY)
    ? false
    : `${STAGED_DIST_BINARY} not found (run \`npm run build:render-bin\`)`,
}, async () => {
  const base = tempDir("wand-render-artifact-");
  const real = path.join(base, "real");
  // 用符号链接专门构造「同一个 config 经链接访问」这个场景（协议 §9.2）：
  // 两侧都必须把它归一成 realpath。旧产物只做词法归一（`path.resolve` 语义），
  // 于是 suffix 按链接路径算，而 Server 按 realpath 算 —— 同一个 config 派生出
  // 两套 socket/token，Server 永远等不到它要的那个 token。
  mkdirSync(real, { recursive: true });
  symlinkSync(real, path.join(base, "alias"));
  const viaAlias = path.join(base, "alias", "config.json");
  writeFileSync(path.join(real, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 0 }), { mode: 0o600 });
  // Server 侧（`src/render-protocol.ts`）推导的 token 位置。
  const { tokenPath, pidPath } = renderPaths(viaAlias);
  const child = spawn(STAGED_DIST_BINARY, ["-c", viaAlias], { detached: true, stdio: "ignore" });
  child.unref();
  try {
    await waitFor(
      () => existsSync(tokenPath),
      () => `the staged artifact did not publish its token at ${tokenPath} (it wrote ${JSON.stringify(readdirSync(real).filter((name) => name.startsWith(".render-")))}). ` +
        "A Render shipped from render-bin must normalize the config path exactly like the Server (lexical path, then realpath); " +
        "otherwise engine=rust can never come up in production. Rebuild and republish render-bin.",
      8_000,
    );
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    assert.ok(pid > 0, "expected the staged artifact to publish a live pid");
    assert.equal(processAlive(pid), true);
  } finally {
    killDaemonInDir(real, base);
    rmSync(base, { recursive: true, force: true });
  }
});

test("oversized list responses degrade instead of becoming unadoptable", {
  skip: RENDER_BINARY
    ? (process.env.WAND_E2E_OVERSIZE === "1" ? false : "set WAND_E2E_OVERSIZE=1 to run (~10s, daemon RSS ~1.6GB)")
    : SKIP_REASON,
}, async () => {
  const fixture = await startFixture();
  try {
    // 单会话 `list` 状态 ≈ 10.8MB（cols=1000 满回滚 + 每行 998 个 `"`，JSON 转义再翻一倍）。
    // 7 个合计约 75MB，超过 64MiB 单帧上限：修复前 daemon 会静默吞掉编码失败，
    // 客户端只能等到自己的 10s 超时；而 `connect()` 必调 `list`，所以那种 daemon
    // 会彻底无法 adopt（engine=rust 时 web 直接起不来）。修复后按预算逐级降级，
    // `list` 必须仍然成功返回。
    //
    // 灌数据时故意绕开 `process.write`（fire-and-forget，断线期间会静默丢弃）用
    // 原始 RPC：这是**串行**填充，避免并发巨量输出把客户端当成慢客户端断开而干扰判据。
    const sessions = 7;
    const wide = 'awk \'BEGIN{s="";for(j=0;j<998;j++)s=s"\\"";for(i=0;i<5000;i++)print s}\'';
    for (let index = 0; index < sessions; index += 1) {
      const sessionId = `oversize-${index}`;
      await retry(
        () => fixture.client.createOrAttach(spawnRequest(sessionId, fixture.dir, 1000, 40)),
        `expected to create round ${index}`,
      );
      await retry(
        () => rawRenderRpc(fixture.configPath, "write", { sessionId, data: `${wide}\r` }),
        `expected to feed round ${index}`,
      );
      let snapshotBytes = 0;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && snapshotBytes < 4_900_000) {
        await delay(300);
        const state = await rawRenderRpc(fixture.configPath, "attach", { sessionId }) as {
          state?: { terminalSnapshot?: { data?: string } | null };
        };
        snapshotBytes = state.state?.terminalSnapshot?.data?.length ?? 0;
      }
      assert.ok(snapshotBytes >= 4_900_000, `expected round ${index} to fill its scrollback (got ${snapshotBytes} bytes)`);
    }

    const startedAt = Date.now();
    const listed = await rawRenderRpc(fixture.configPath, "list") as {
      sessions?: { terminalSnapshot?: unknown; output?: string }[];
    };
    const elapsed = Date.now() - startedAt;
    // 关键：`list` 必须仍然**成功返回**（哪怕降级），而不是给客户端超时/死连接。
    assert.equal(listed.sessions?.length, sessions, "expected list to return every session");
    assert.ok(elapsed < 8_000, `expected a bounded list response, took ${elapsed}ms`);
    // 降级确实触发了：完整 list 会超过 64MiB 单帧上限，所以快照被省掉。
    assert.ok(
      listed.sessions!.some((session) => session.terminalSnapshot === null),
      "expected list to degrade (drop snapshots) under the 64MiB frame budget",
    );
    // 而单会话的完整状态仍由 attach 提供（“重启后重建屏幕”的正规入口）。
    const full = await rawRenderRpc(fixture.configPath, "attach", { sessionId: "oversize-0" }) as {
      state?: { terminalSnapshot?: { data?: string } | null; chunks?: unknown[] };
    };
    assert.ok(full.state?.terminalSnapshot?.data, "attach must still return the full snapshot");
    assert.ok((full.state?.chunks?.length ?? 0) > 0, "attach must still return the replay chunks");
  } finally {
    await fixture.dispose();
  }
});
