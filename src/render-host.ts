import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import process from "node:process";

import { getErrorMessage } from "./error-utils.js";
import { isExecutableFile, readRenderBinaryVersion, resolveRenderBinaryPath } from "./render-binary.js";
import { connectExistingRenderClient, type RenderDaemonClient } from "./render-daemon-client.js";
import { renderPaths } from "./render-protocol.js";
import { connectExistingTerminalHost, createTerminalHost, TerminalDaemonClient } from "./terminal-daemon-client.js";
import {
  InProcessTerminalHost,
  type TerminalAttachResult,
  type TerminalHost,
  type TerminalSpawnRequest,
} from "./terminal-host.js";
import type { RenderEngine } from "./types.js";

/** Render 的 socket/token 就绪等待窗口，与 legacy daemon 保持一致。 */
const RENDER_READY_TIMEOUT_MS = 5_000;

export interface RenderHostOptions {
  /** 配置里显式指定的引擎；环境变量 WAND_RENDER_ENGINE 优先。 */
  engine?: RenderEngine;
  /** 配置里显式指定的二进制路径。 */
  binaryPath?: string;
}

export interface UpgradeAwareTerminalHost {
  host: TerminalHost;
  renderHost: TerminalHost | null;
  legacyHost: TerminalDaemonClient | null;
}

export interface RoutedTerminalHosts {
  legacy: TerminalHost | null;
  render: TerminalHost;
}

/**
 * 升级期无损路由：旧会话留在 legacy terminald，新会话一律进 Render。
 *
 * 所有权判断只能靠 legacy 自己的 inventory —— Server 无法从 DB 倒推
 * 「这个 PTY 现在归谁」，因为升级前建的会话进程就在旧 daemon 里。
 */
export class CompositeTerminalHost implements TerminalHost {
  readonly persistent = true;
  private readonly legacy: TerminalHost | null;
  private readonly render: TerminalHost;

  constructor(hosts: RoutedTerminalHosts) {
    this.legacy = hosts.legacy;
    this.render = hosts.render;
  }

  attach(sessionId: string, afterSeq = 0): TerminalAttachResult | null {
    // legacy 命中就直接用；返回 null 说明这条会话不属于它（新会话在 Render）。
    const fromLegacy = this.attachFromLegacy(sessionId, afterSeq);
    if (fromLegacy) return fromLegacy;
    return this.render.attach(sessionId, afterSeq);
  }

  async createOrAttach(request: TerminalSpawnRequest, afterSeq = 0): Promise<TerminalAttachResult> {
    if (this.legacyOwns(request.sessionId)) {
      return this.legacy!.createOrAttach(request, afterSeq);
    }
    return this.render.createOrAttach(request, afterSeq);
  }

  forget(sessionId: string): void {
    this.legacy?.forget(sessionId);
    this.render.forget(sessionId);
  }

  /**
   * 两侧都只是解绑：legacy daemon 可能还持有升级前的旧 PTY，Render 更是必须
   * 跨 Server 重启继续活着。**这里绝不能 kill 任何东西。**
   */
  disconnect(): void {
    this.legacy?.disconnect();
    this.render.disconnect();
  }

  /**
   * legacy 查询失败（socket 抖动）时按「不属于它」处理：宁可让 Render 侧查一遍，
   * 也不能在会话恢复路径上抛异常 —— 那会让服务器重启后旧会话全部恢复失败。
   */
  private attachFromLegacy(sessionId: string, afterSeq: number): TerminalAttachResult | null {
    if (!this.legacy) return null;
    try {
      return this.legacy.attach(sessionId, afterSeq) ?? null;
    } catch {
      return null;
    }
  }

  private legacyOwns(sessionId: string): boolean {
    if (!this.legacy) return false;
    try {
      return this.legacy.attach(sessionId) !== null;
    } catch {
      // 查询失败按「不属于 legacy」处理：宁可让 Render 建新会话，也不要把请求丢进坏掉的 daemon。
      return false;
    }
  }
}

/** 环境变量优先于 config；非法值忽略并告警。 */
export function resolveRenderEngine(envValue: string | undefined, configEngine: RenderEngine | undefined): RenderEngine {
  const raw = (envValue ?? "").trim().toLowerCase();
  if (raw) {
    if (raw === "rust" || raw === "legacy" || raw === "auto") return raw;
    process.stderr.write(`[wand] WAND_RENDER_ENGINE=${envValue} is invalid (expected rust|legacy|auto); ignoring it.\n`);
  }
  return configEngine === "rust" || configEngine === "legacy" ? configEngine : "auto";
}

export async function createUpgradeAwareTerminalHost(
  configPath: string,
  options: RenderHostOptions = {},
): Promise<UpgradeAwareTerminalHost> {
  if (process.env.WAND_TEST_MODE === "1" || process.env.NODE_TEST_CONTEXT) {
    // 与 legacy 缝隙一致：测试进程不拉起任何常驻 daemon。
    return { host: new InProcessTerminalHost(), renderHost: null, legacyHost: null };
  }

  const engine = resolveRenderEngine(process.env.WAND_RENDER_ENGINE, options.engine);

  // engine=legacy 等价于当前行为：adopt 已有 terminald，不存在才 spawn。
  if (engine === "legacy") {
    const legacy = await createTerminalHost(configPath);
    return { host: legacy, renderHost: null, legacyHost: asTerminalDaemonClient(legacy) };
  }

  // 只 adopt，绝不 spawn/杀：它可能正持有升级前的会话 PTY。
  const legacy = await connectExistingTerminalHost(configPath);
  const configuredBinary = options.binaryPath?.trim();
  const binaryPath = configuredBinary || resolveRenderBinaryPath(configPath);

  if (!binaryPath) {
    if (engine === "rust") {
      throw new Error(
        "render.engine=rust but no wand-render binary was found (checked WAND_RENDER_BIN, render/target/{release,debug}, " +
        "<configDir>/bin, dist/native/<platform>-<arch>, PATH). " +
        "Build it with `npm run build:render-native` (cargo build --release in render/), " +
        "or set render.engine=auto/legacy to fall back.",
      );
    }
    process.stderr.write(
      "[wand] WARNING: render.engine=auto but no wand-render binary was found; PTYs stay on the legacy terminald. " +
      "Build it with `npm run build:render-native`, stage a published build with `npm run build:render-bin`, or set WAND_RENDER_BIN.\n",
    );
    const fallback = legacy ?? await createTerminalHost(configPath);
    return { host: fallback, renderHost: null, legacyHost: asTerminalDaemonClient(fallback) };
  }
  if (configuredBinary && !isExecutableFile(configuredBinary)) {
    // 显式配置指向不可执行文件属于配置错误，静默回退 legacy 会让人以为 Rust 引擎在跑。
    throw new Error(`render.binaryPath points at ${configuredBinary}, which is not an executable file.`);
  }

  try {
    const render = await createRenderTerminalHost(configPath, { binaryPath });
    const version = await readRenderBinaryVersion(binaryPath);
    process.stderr.write(
      `[wand] Render engine active (${version ? `wand-render ${version}` : "version unknown"}, ${binaryPath})` +
      `${legacy ? "; legacy terminald still serving pre-upgrade sessions" : ""}.\n`,
    );
    const host: TerminalHost = legacy ? new CompositeTerminalHost({ legacy, render }) : render;
    return { host, renderHost: render, legacyHost: legacy };
  } catch (error) {
    if (engine === "rust") throw error;
    // auto 模式下把失败讲清楚再回退：这种情况用户最需要知道 Rust 引擎没生效。
    process.stderr.write(
      `[wand] WARNING: render.engine=auto could not bring up Render (${getErrorMessage(error)}); falling back to the legacy terminald.\n`,
    );
    const fallback = legacy ?? await createTerminalHost(configPath);
    return { host: fallback, renderHost: null, legacyHost: asTerminalDaemonClient(fallback) };
  }
}

/**
 * adopt 已存在的 Render，不存在则 spawn 后等待就绪。
 *
 * 协议（docs/render-protocol.md §6）：pid 活着但 socket 不可用 → 等待就绪，
 * 不另起第二个 daemon；协议版本不符 → 明确抛错，**不做降级运行**。
 */
export async function createRenderTerminalHost(
  configPath: string,
  options: { binaryPath?: string } = {},
): Promise<RenderDaemonClient> {
  const paths = renderPaths(configPath);
  const endpointExists = process.platform !== "win32" && existsSync(paths.socketPath);

  if (endpointExists) {
    const adopted = await connectExistingRenderClient(configPath);
    if (adopted) return adopted;
    if (await isSocketListening(paths.socketPath)) {
      // 有人监听却拒绝 adopt（协议版本不符 / token 不符）：这是错误配置，必须报出来而不是绕开。
      const starting = await waitForRender(configPath, RENDER_READY_TIMEOUT_MS);
      if (starting) return starting;
      throw new Error(
        `A Render daemon is listening on ${paths.socketPath} but rejected adoption. Refusing to spawn a competing Render; ` +
        "check the protocol version/token of the running binary, or stop it first.",
      );
    }
    // 没人在监听，且没有活着的 pid = 上一次 renderd 崩溃留下的孤儿 socket 文件。
    // 清掉它再 spawn，否则会永久卡在「等一个永远不会就绪的 socket」。
    if (readLiveRenderPid(paths.pidPath) === null) {
      try { unlinkSync(paths.socketPath); } catch { /* 已被别处清掉即可 */ }
    }
  }

  // 进程活着但 socket 还没就绪（启动竞态 / 正在 drain）：等它就绪，
  // 绝不另起第二个 daemon（协议 §6 single instance）。
  const livePid = readLiveRenderPid(paths.pidPath);
  if (livePid !== null) {
    const starting = await waitForRender(configPath, RENDER_READY_TIMEOUT_MS);
    if (starting) return starting;
    throw new Error(
      `Render process ${livePid} is alive but its socket ${paths.socketPath} is unavailable; refusing to spawn a second daemon.`,
    );
  }

  const binaryPath = options.binaryPath ?? resolveRenderBinaryPath(configPath);
  if (!binaryPath) throw new Error("wand-render binary is required to start Render");
  return spawnDetachedRender(configPath, binaryPath);
}

/** detached spawn（stdio 忽略、unref），并等 socket + token 就绪。 */
export async function spawnDetachedRender(configPath: string, binaryPath: string): Promise<RenderDaemonClient> {
  const paths = renderPaths(configPath);
  // `-c <configPath>` 是按 config 隔离的既定约定（docs/render-protocol.md §6）：
  // socket / token / pid / meta 全部由它派生。
  const child = spawn(binaryPath, ["-c", configPath], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env,
  });
  child.on("error", (error) => {
    process.stderr.write(`[wand] Failed to spawn wand-render: ${getErrorMessage(error)}\n`);
  });
  child.unref();
  const client = await waitForRender(configPath, RENDER_READY_TIMEOUT_MS);
  if (!client) {
    // 自己生的进程自己收：就位超时（选错了二进制、二进制是 stub、或者它卡在启动）
    // 时如果不回收，就会留下一个永久孤儿 daemon —— 它占着 socket 名字、下次启动会被
    // 当成「活着但不接受领养」而直接阻塞启动。收尾是 best-effort，失败不影响报错。
    reapUnreadyRender(child.pid);
    throw new Error(
      `Spawned ${binaryPath} but its socket/token (${paths.socketPath}) did not become ready within ${RENDER_READY_TIMEOUT_MS}ms.`,
    );
  }
  return client;
}

async function waitForRender(configPath: string, timeoutMs: number): Promise<RenderDaemonClient | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = await connectExistingRenderClient(configPath);
    if (client) return client;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * 回收一个「已 spawn 但始终没就绪」的 Render 进程。
 *
 * 不回收会留下孤儿 daemon：它占着按 config 派生的 socket 名字，下次启动会被判成
 * 「进程活着但 socket 不可达」，于是启动直接失败而不是重建 —— 一个失败的启动不该
 * 破坏后续所有启动。先 SIGTERM 给它清理 socket/token 的机会，短暂等待后 SIGKILL。
 */
function reapUnreadyRender(pid: number | undefined): void {
  if (typeof pid !== "number" || pid <= 0) return;
  const signal = (name: NodeJS.Signals): void => {
    try { process.kill(pid, name); } catch { /* 已经退出 */ }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 500);
  timer.unref?.();
}

/** 对端是否真的在监听：区分「活着但拒绝 adopt」与「上一轮崩溃留下的孤儿 socket 文件」。 */function isSocketListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (alive: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    const timer = setTimeout(() => finish(false), 300);
    timer.unref?.();
  });
}

function readLiveRenderPid(pidPath: string): number | null {
  let pid: number;
  try { pid = Number(readFileSync(pidPath, "utf8").trim()); }
  catch { return null; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** structuredExecHost 只认 daemon 客户端；测试注入的 in-process host 不算。 */
function asTerminalDaemonClient(host: TerminalHost): TerminalDaemonClient | null {
  return host instanceof TerminalDaemonClient ? host : null;
}
