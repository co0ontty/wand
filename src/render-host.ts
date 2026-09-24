import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import process from "node:process";

import { getErrorMessage } from "./error-utils.js";
import { isExecutableFile, readRenderBinaryVersion, resolveRenderBinaryPath } from "./render-binary.js";
import { connectExistingRenderClient, type RenderDaemonClient, type RenderDaemonReviver } from "./render-daemon-client.js";
import { renderPaths } from "./render-protocol.js";
import { compareSemver } from "./version-utils.js";
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
/** 自愈 revive 的最小间隔：重连退避可能很密集，窗口内只 spawn 一次。 */
const RENDER_REVIVE_BACKOFF_MS = 5_000;
/** 空闲 daemon 升级时等它退出的上限（超过就当升级失败，交给上层决定）。 */
const RENDER_SHUTDOWN_TIMEOUT_MS = 5_000;
/** 陈留 socket 的二次确认间隔（避开「刚 bind、还没 accept」的启动窗口）。 */
const RENDER_STALE_PROBE_DELAY_MS = 250;

export interface RenderHostOptions {
  /** 配置里显式指定的引擎；环境变量 WAND_RENDER_ENGINE 优先。 */
  engine?: RenderEngine;
  /** 配置里显式指定的二进制路径。 */
  binaryPath?: string;
  /** DB 中仍在运行的 PTY，用于旧版 Render 的超大 list 失败时逐个 attach。 */
  knownSessionIds?: readonly string[];
}

/**
 * 运行时自愈：没有活着的 owner、且端点不可用时，起一个 detached Render。
 * 返回 true 表示起了新进程（调用方应立刻重连）。
 *
 * 覆盖两种「重试永远不会好」的形状（都是同一个后果：终端一直断、只能重启整个服务）：
 * - daemon 没了，socket 文件也被清掉（临时目录清理器，线上真发生过）；
 * - daemon 被 kill -9 / 崩溃，socket 文件作为陈留文件留了下来（没有监听者）。
 *
 * 保守之处：pid 文件里还有活进程就不插手（那个 daemon 会自己重建端点，
 * docs/render-protocol.md §6 single instance）；能连上监听者也不插手；同一个窗口只 spawn 一次。
 */
export function createRenderDaemonReviver(
  configPath: string,
  binaryPath: string | null,
): RenderDaemonReviver {
  let inFlight: Promise<boolean> | null = null;
  let lastSpawnAt = 0;
  return (): Promise<boolean> => {
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<boolean> => {
      if (process.platform === "win32") return false;
      const paths = renderPaths(configPath);
      // 有活着的 owner 就不插手：端点要么还在，要么它自己会重建
      // （旧版 daemon 没有看门狗，但也不能开第二个 daemon —— 协议 §6 single instance）。
      if (readLiveRenderPid(paths.pidPath) !== null) return false;
      if (await isSocketListening(paths.socketPath)) return false;
      // 端点文件还在但没人监听 = 崩溃留下的陈留 socket。它可能是「刚 bind、 还没 accept」
      // 的启动窗口，隔一下再确认一次；确认真死了就把陈留文件交给新 daemon 自己的
      // prepare_socket_path 去判定（它只删本用户的 0600 socket，不碰别人的路径）。
      if (existsSync(paths.socketPath)) {
        await new Promise<void>((resolve) => setTimeout(resolve, RENDER_STALE_PROBE_DELAY_MS));
        if (await isSocketListening(paths.socketPath)) return false;
      }
      if (Date.now() - lastSpawnAt < RENDER_REVIVE_BACKOFF_MS) return false;
      const resolved = binaryPath && isExecutableFile(binaryPath) ? binaryPath : resolveRenderBinaryPath(configPath);
      if (!resolved) return false;
      lastSpawnAt = Date.now();
      const pid = spawnDetachedRenderProcess(configPath, resolved);
      const deadline = Date.now() + RENDER_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        // 新 daemon 先 bind 再写 pid：pid 文件里出现活 pid 才算它真正接管了这个端点。
        if (readLiveRenderPid(paths.pidPath) !== null && await isSocketListening(paths.socketPath)) {
          process.stderr.write(`[wand] Restarted Render daemon (pid ${pid ?? "?"}); reconnecting.\n`);
          return true;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      // 起了却没就绪（二进制不对/卡在启动/端点被别人占着）：回收自己生的进程，
      // 不留占着 socket 名字的孤儿 daemon。
      reapUnreadyRender(pid ?? undefined);
      return false;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
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
 * MIGRATION-COMPAT: 旧 PTY/Render v1 路由须保留到用户另行要求删除；
 * 不能因为新 Render 负责新会话就杀掉或丢弃旧 owner。
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

  // 先 adopt 升级前的 terminald，以它的 inventory 判定旧 PTY 的 owner。
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

  let render: RenderDaemonClient;
  try {
    render = await createRenderTerminalHost(configPath, {
      binaryPath,
      knownSessionIds: options.knownSessionIds,
    });
  } catch (error) {
    if (engine === "rust") throw error;
    // auto 模式下把失败讲清楚再回退：这种情况用户最需要知道 Rust 引擎没生效。
    process.stderr.write(
      `[wand] WARNING: render.engine=auto could not bring up Render (${getErrorMessage(error)}); falling back to the legacy terminald.\n`,
    );
    const fallback = legacy ?? await createTerminalHost(configPath);
    return { host: fallback, renderHost: null, legacyHost: asTerminalDaemonClient(fallback) };
  }

  // MIGRATION-COMPAT: Render v1 only owns PTYs. Keep terminald as the owner
  // of existing structured runs during the v2 migration, even if new runs
  // eventually use Rust. Remove this path only on a later explicit request.
  // Structured CLI runs still need a daemon-backed host to survive a web restart,
  // including on a fresh installation where no
  // pre-upgrade terminald exists. The composite routes new PTYs to Render.
  let structuredHost: TerminalDaemonClient;
  try {
    const daemon = legacy ?? await createTerminalHost(configPath);
    const client = asTerminalDaemonClient(daemon);
    if (!client) throw new Error("A persistent terminal daemon is required for structured CLI runs.");
    structuredHost = client;
  } catch (error) {
    render.disconnect();
    throw error;
  }
  const version = await readRenderBinaryVersion(binaryPath);
  process.stderr.write(
    `[wand] Render engine active (${version ? `wand-render ${version}` : "version unknown"}, ${binaryPath}); ` +
    "terminald available for structured CLI runs and pre-upgrade PTYs.\n",
  );
  return {
    host: new CompositeTerminalHost({ legacy: structuredHost, render }),
    renderHost: render,
    legacyHost: structuredHost,
  };
}

/**
 * adopt 已存在的 Render，不存在则 spawn 后等待就绪。
 *
 * 协议（docs/render-protocol.md §6）：pid 活着但 socket 不可用 → 等待就绪，
 * 不另起第二个 daemon；协议版本不符 → 明确抛错，**不做降级运行**。
 */
export async function createRenderTerminalHost(
  configPath: string,
  options: { binaryPath?: string; knownSessionIds?: readonly string[] } = {},
): Promise<RenderDaemonClient> {
  const binaryPath = options.binaryPath ?? resolveRenderBinaryPath(configPath);
  // adopt 到的是已经在跑的 daemon：它可能是 npm 升级前启动的旧二进制。
  const adopt = (client: RenderDaemonClient): Promise<RenderDaemonClient> =>
    upgradeRenderDaemonIfIdle(configPath, binaryPath, options.knownSessionIds, client);
  const paths = renderPaths(configPath);
  const endpointExists = process.platform !== "win32" && existsSync(paths.socketPath);
  // 已经 adopt 过的客户端需要能自己把 daemon 拉回来：adopt 完 binaryPath 就丢了，
  // 所以这里把解析结果一次性算好交给它。
  const reviveDaemon = createRenderDaemonReviver(configPath, binaryPath);

  if (endpointExists) {
    const adopted = await connectExistingRenderClient(configPath, options.knownSessionIds, reviveDaemon);
    if (adopted) return adopt(adopted);
    if (await isSocketListening(paths.socketPath)) {
      // 有人监听却拒绝 adopt（协议版本不符 / token 不符）：这是错误配置，必须报出来而不是绕开。
      const starting = await waitForRender(configPath, RENDER_READY_TIMEOUT_MS, options.knownSessionIds, reviveDaemon);
      if (starting) return adopt(starting);
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
    const starting = await waitForRender(configPath, RENDER_READY_TIMEOUT_MS, options.knownSessionIds, reviveDaemon);
    if (starting) return adopt(starting);
    throw new Error(
      `Render process ${livePid} is alive but its socket ${paths.socketPath} is unavailable; refusing to spawn a second daemon.`,
    );
  }

  if (!binaryPath) throw new Error("wand-render binary is required to start Render");
  return spawnDetachedRender(configPath, binaryPath, options.knownSessionIds, reviveDaemon);
}

/**
 * 该不该把正在跑的 daemon 换成装好的二进制：只有「装好的更新」且「daemon 空闲」才换。
 * 纯决策，便于单测；daemon 持有 PTY 时绝不能动它（会杀掉用户的 shell）。
 */
export function shouldUpgradeRenderDaemon(
  daemonVersion: string | null,
  binaryVersion: string | null,
  sessionCount: number,
): boolean {
  if (!daemonVersion || !binaryVersion) return false;
  if (compareSemver(daemonVersion, binaryVersion) >= 0) return false;
  return sessionCount === 0;
}

/**
 * 装好的二进制比正在跑的 daemon 新时怎么办。
 *
 * npm 升级 / `./start.sh` 都不会重启正在跑的 daemon（不能杀别人的 PTY），所以升级后
 * 一直在跑旧代码 —— 2026-09-24 的线上事故就是这么来的：端点自愈是 9/23 21:26 补上的，
 * 但 terminald 是 9/19 启的老进程、Render 是 9/23 10:49 的老二进制，socket 被临时目录
 * 清理器删掉后永远回不来。
 *
 * 所以：daemon 空闲（没有 PTY）就直接把它换到新二进制上 —— 升级完就好；
 * 还有会话就只大声告警，让人在会话结束后跑 `./start.sh --restart-daemons`。
 */
async function upgradeRenderDaemonIfIdle(
  configPath: string,
  binaryPath: string | null,
  knownSessionIds: readonly string[] | undefined,
  client: RenderDaemonClient,
): Promise<RenderDaemonClient> {
  if (!binaryPath) return client;
  const daemonVersion = client.version;
  if (!daemonVersion) return client;
  const binaryVersion = await readRenderBinaryVersion(binaryPath);
  if (!binaryVersion || compareSemver(daemonVersion, binaryVersion) >= 0) return client;
  const sessions = client.sessionCount;
  if (!shouldUpgradeRenderDaemon(daemonVersion, binaryVersion, sessions)) {
    process.stderr.write(
      `[wand] WARNING: Render daemon ${daemonVersion} is older than the installed binary ${binaryVersion} but still owns ` +
      `${sessions} PTY session(s); it keeps running the old code. Restart it when those sessions are done: ./start.sh --restart-daemons\n`,
    );
    return client;
  }
  try {
    await client.requestShutdownNow();
    client.disconnect();
    await waitForRenderProcessExit(renderPaths(configPath).pidPath, RENDER_SHUTDOWN_TIMEOUT_MS);
    const upgraded = await spawnDetachedRender(configPath, binaryPath, knownSessionIds);
    process.stderr.write(`[wand] Render daemon upgraded ${daemonVersion} -> ${binaryVersion} (it was idle).\n`);
    return upgraded;
  } catch (error) {
    // 已经让它收摊了：回不去旧 client，报清楚并让上层（auto 模式）回退 legacy。
    throw new Error(
      `Render daemon ${daemonVersion} was stopped for an upgrade to ${binaryVersion} but the replacement did not come up: ` +
      getErrorMessage(error),
    );
  }
}

/** 等旧 daemon 真的退出（新 daemon 会因为 pid 活着而拒绝启动）。 */
async function waitForRenderProcessExit(pidPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readLiveRenderPid(pidPath) === null) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * detached spawn（stdio 忽略、unref），返回子进程 pid。
 *
 * `-c <configPath>` 是按 config 隔离的既定约定（docs/render-protocol.md §6）：
 * socket / token / pid / meta 全部由它派生。
 */
export function spawnDetachedRenderProcess(configPath: string, binaryPath: string): number | null {
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
  return typeof child.pid === "number" ? child.pid : null;
}

/** spawn 并等 socket + token 就绪（启动路径用）。 */
export async function spawnDetachedRender(
  configPath: string,
  binaryPath: string,
  knownSessionIds?: readonly string[],
  reviveDaemon: RenderDaemonReviver | null = null,
): Promise<RenderDaemonClient> {
  const paths = renderPaths(configPath);
  const pid = spawnDetachedRenderProcess(configPath, binaryPath);
  const client = await waitForRender(configPath, RENDER_READY_TIMEOUT_MS, knownSessionIds, reviveDaemon);
  if (!client) {
    // 自己生的进程自己收：就位超时（选错了二进制、二进制是 stub、或者它卡在启动）
    // 时如果不回收，就会留下一个永久孤儿 daemon —— 它占着 socket 名字、下次启动会被
    // 当成「活着但不接受领养」而直接阻塞启动。收尾是 best-effort，失败不影响报错。
    reapUnreadyRender(pid ?? undefined);
    throw new Error(
      `Spawned ${binaryPath} but its socket/token (${paths.socketPath}) did not become ready within ${RENDER_READY_TIMEOUT_MS}ms.`,
    );
  }
  return client;
}

async function waitForRender(
  configPath: string,
  timeoutMs: number,
  knownSessionIds?: readonly string[],
  reviveDaemon: RenderDaemonReviver | null = null,
): Promise<RenderDaemonClient | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = await connectExistingRenderClient(configPath, knownSessionIds, reviveDaemon);
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
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
