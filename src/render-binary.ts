import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** 仓库根：src/ 与 dist/ 都在根下一层，所以两种运行方式解析结果一致。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VERSION_PROBE_TIMEOUT_MS = 2_000;
const ARCH_PROBE_TIMEOUT_MS = 1_000;

/**
 * 支持的分发三元组。
 *
 * 与 `render-bin/manifest.json` 的版本条目键、`render/release.json` 的
 * `supportedTriples` 必须一致；新增平台要同时改这三处与 CI 矩阵。
 */
export const SUPPORTED_RENDER_TRIPLES = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

/** `uname -m` 的架构别名 → Node 的 `process.arch` 命名（两个生态叫法不同）。 */
const MACHINE_ARCH_ALIASES: Record<string, string> = {
  arm64: "arm64",
  aarch64: "arm64",
  x86_64: "x64",
  amd64: "x64",
  x64: "x64",
};

/** `uname -m` 的输出归一成 Node 的 arch 名；认不出返回 null（调用方回退 process.arch）。 */
export function normalizeMachineArch(machine: string | null | undefined): string | null {
  if (typeof machine !== "string") return null;
  return MACHINE_ARCH_ALIASES[machine.trim().toLowerCase()] ?? null;
}

/**
 * 平台三元组（`darwin-arm64` 等）。
 *
 * 为什么不直接用 `process.arch`：macOS 上 Node 跑在 Rosetta 里时它报 `x64`，
 * 而机器其实是 arm64 —— 于是会去找一个不存在（或架构不符）的产物，最后表现成
 * 「自动模式下 Rust 引擎莫名其妙不生效」。`uname -m` 才反映真实硬件；只有
 * `uname` 不可用（PATH 被清空、Windows）时才回退 `process.arch`。
 *
 * `rosettaTranslated` 是反向兜底：翻译态下 `uname -m` 同样报 `x86_64`，
 * 只有 `sysctl.proc_translated` 能说明「这个 x64 进程跑在 arm64 机器上」。
 * 少了它，上面那条规则在它最该生效的场景里形同虚设。
 */
export function resolveRenderTriple(
  platform: string,
  nodeArch: string,
  unameMachine: string | null,
  rosettaTranslated = false,
): string {
  let arch = normalizeMachineArch(unameMachine) ?? nodeArch;
  if (platform === "darwin" && arch === "x64" && rosettaTranslated) arch = "arm64";
  return `${platform}-${arch}`;
}

interface PlatformArchProbe {
  unameMachine: string | null;
  rosettaTranslated: boolean;
}

let cachedPlatformArchProbe: PlatformArchProbe | null = null;

/**
 * 真实架构探测（进程级缓存）：`resolveRenderBinaryPath` 在一次启动里会被调用多次，
 * 不该每次都 spawn 两个进程。
 */
export function probePlatformArch(): PlatformArchProbe {
  if (!cachedPlatformArchProbe) {
    cachedPlatformArchProbe = {
      unameMachine: runUnameMachine(),
      rosettaTranslated: isRosettaTranslated(),
    };
  }
  return cachedPlatformArchProbe;
}

/** 当前进程应使用的三元组。 */
export function currentRenderTriple(): string {
  const probe = probePlatformArch();
  return resolveRenderTriple(process.platform, process.arch, probe.unameMachine, probe.rosettaTranslated);
}

function runUnameMachine(): string | null {
  if (process.platform === "win32") return null;
  try {
    const result = spawnSync("uname", ["-m"], {
      encoding: "utf8",
      timeout: ARCH_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return null;
    return (result.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

/** `sysctl.proc_translated` == 1 表示当前进程被 Rosetta 翻译（只在 darwin 上有意义）。 */
function isRosettaTranslated(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const result = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], {
      encoding: "utf8",
      timeout: ARCH_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return false;
    return (result.stdout ?? "").trim() === "1";
  } catch {
    return false;
  }
}

/**
 * 约定候选路径（不含 `WAND_RENDER_BIN` 与 `PATH`，调用方单独处理）。
 *
 * 顺序刻意把「刚 cargo build 出来的」排在分发位置之前：开发机上调 Rust 引擎时
 * 期望立刻生效，而不是被上一次安装的旧二进制盖住。
 *
 * 旧布局（`wand-rs/`、仓库根 `native/`）已不存在，候选里不留兼容分支：
 * 留着只会让「引擎没生效」这类问题多一个静默的假来源。
 */
export function renderBinaryCandidates(configDir: string, triple: string): string[] {
  const binaryName = process.platform === "win32" ? "wand-render.exe" : "wand-render";
  return [
    path.join(REPO_ROOT, "render", "target", "release", binaryName),
    path.join(REPO_ROOT, "render", "target", "debug", binaryName),
    path.join(configDir, "bin", binaryName),
    // npm 包内嵌的正式位置：scripts/stage-render-binaries.js 把 render-bin 的产物写在这里，
    // dist/ 在 package.json 的 files 里，所以全局安装后也有二进制。
    path.join(REPO_ROOT, "dist", "native", triple, binaryName),
  ];
}

/**
 * 解析 wand-render 可执行文件。
 *
 * 顺序：`WAND_RENDER_BIN` → `<repo>/render/target/{release,debug}` → `<configDir>/bin`
 * → `<repo>/dist/native/<triple>` → `PATH`。返回 null 表示「这台机器没有」，由调用方
 * 按 engine 决定告警还是报错。
 */
export function resolveRenderBinaryPath(configPath: string): string | null {
  const binaryName = process.platform === "win32" ? "wand-render.exe" : "wand-render";
  const fromEnv = process.env.WAND_RENDER_BIN?.trim();
  if (fromEnv) {
    if (isExecutableFile(fromEnv)) return fromEnv;
    // 显式配置但不存在属于配置错误，必须可见，不能静默滑到仓库构建产物。
    process.stderr.write(
      `[wand] WAND_RENDER_BIN points at ${fromEnv}, which is not an executable file; falling back to discovery.\n`,
    );
  }
  const configDir = path.dirname(path.resolve(configPath));
  const triple = currentRenderTriple();
  for (const candidate of renderBinaryCandidates(configDir, triple)) {
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 读取 wand-render 的版本。
 *
 * 先读二进制旁边的 `wand-render.version` sidecar（就位脚本会写），读不到才去跑
 * `wand-render --version` —— 启动路径上不该无谓地执行一个进程。
 * 两种方式都失败时返回 null：调用方只要一个展示用版本号，拿不到不能影响启动。
 */
export function readRenderBinaryVersion(binaryPath: string): Promise<string | null> {
  const sidecar = readVersionSidecar(binaryPath);
  if (sidecar) return Promise.resolve(sidecar);
  return new Promise<string | null>((resolve) => {
    execFile(binaryPath, ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const firstLine = stdout.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
      const version = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/.exec(firstLine);
      resolve(version ? version[1] : null);
    });
  });
}

function readVersionSidecar(binaryPath: string): string | null {
  try {
    const raw = readFileSync(path.join(path.dirname(binaryPath), "wand-render.version"), "utf8").trim();
    const version = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)$/.exec(raw);
    return version ? version[1] : null;
  } catch {
    return null;
  }
}

export function isExecutableFile(candidate: string): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
