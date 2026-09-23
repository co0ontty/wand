#!/usr/bin/env node
/**
 * 把平台专用的 Rust `wand-render` 二进制就位到 `<configDir>/bin/wand-render`。
 *
 * 为什么是一个独立脚本，而不是在 Server 里顺手 copy：
 *   - npm 全局包升级后，新包里的 `dist/native/<triple>/wand-render` 取代 configDir 里的旧二进制
 *     是**升级链路**的一环（老 Server 重启时必须换成新二进制才会说同一版协议），把它做成
 *     可单独执行、可 `--dry-run` 的工具，install.sh / CI / 手工排障 / Server 启动自检
 *     就都能复用同一套规则，而不是各自实现一遍。
 *   - 幂等是硬要求：版本一致时连 mtime 都不动（Server 每次启动都会 check 一次，
 *     不能每次都重写磁盘、更不能打断正在跑的 Render）。
 *   - 不读 config.json 内容（只取其所在目录）：既避免把配置里的密钥带进日志，
 *     也允许「配置还没生成」时就能把二进制放好。
 *
 * 用法见 `--help`；设计与回滚见 `docs/render-upgrade-path.md`。
 *
 * 依赖的外部约定（与 Node 侧集成方共享，改这里要同步改文档）：
 *   `wand-render --version` 必须打印含语义化版本号的一行（形如 `wand-render 0.1.0`）并以 0 退出，
 *   **不得**因此启动守护进程。读不出可解析版本时视为「需要替换」。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** 本脚本所在仓库 / npm 包的根目录（脚本随包一起分发）。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RENDER_BINARY_NAME = "wand-render";
/** 安装后的二进制旁边记录版本的 sidecar（纯版本字符串 + 换行）。 */
export const RENDER_VERSION_FILE_NAME = "wand-render.version";
/** 安装子目录：`<configDir>/bin/`。 */
export const RENDER_BIN_SUBDIR = "bin";

/**
 * 支持的平台三元组。Node 的 `platform` + `arch`
 * （`darwin`/`linux` × `arm64`/`x64`）拼接后正好等于后缀，无需额外映射表。
 * win32 明确不实现：协议第一阶段不做命名管道（render/docs/render-protocol.md §2）。
 */
export const SUPPORTED_TRIPLES = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

/** 退出码：可被 Server 启动自检与 CI 直接判定，不要随意改动语义。 */
export const EXIT_OK = 0;
export const EXIT_UNSUPPORTED = 1;
export const EXIT_NO_SOURCE = 2;
export const EXIT_INSTALL_FAILED = 3;
export const EXIT_NEEDS_ACTION = 4;

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;

/**
 * 解析平台三元组。
 * @param {string} platform `process.platform`
 * @param {string} arch `process.arch`
 * @returns {string | null} 支持时返回三元组，否则 null（调用方给出明确报错，不静默降级）
 */
export function resolvePlatformTriple(platform, arch) {
  const triple = `${platform}-${arch}`;
  return SUPPORTED_TRIPLES.includes(triple) ? triple : null;
}

/**
 * 默认 config 路径，与 `src/config.ts` 的 `resolveConfigPath()` 保持一致。
 * @returns {string}
 */
export function defaultConfigPath() {
  return path.resolve(process.env.HOME || os.homedir(), ".wand", "config.json");
}

/**
 * 源二进制的候选路径，按优先级排列（先命中先用）。
 *
 * 新分发布局下只有一个正式位置：`<pkg>/dist/native/<triple>/wand-render`
 * ——它由 `scripts/stage-render-binaries.js` 从 `render-bin` 子模块 stage 进来，
 * 而 `dist/` 在 package.json 的 `files` 里，所以全局安装后确实存在。
 * 开发态仍然优先 `render/target/<profile>/`（刚 `cargo build` 的产物要立刻生效）。
 * @param {{ packageRoot?: string, triple: string, from?: string | null, envBinary?: string }} options
 * @returns {{ path: string, source: "from" | "env" | "cargo" | "cargo-debug" | "dist" }[]}
 */
export function renderBinarySourceCandidates(options) {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const candidates = [];
  if (options.from) {
    candidates.push({ path: path.resolve(options.from), source: "from" });
  }
  const fromEnv = (options.envBinary ?? process.env.WAND_RENDER_BIN ?? "").trim();
  if (fromEnv) {
    candidates.push({ path: path.resolve(fromEnv), source: "env" });
  }
  candidates.push({
    path: path.join(packageRoot, "render", "target", "release", RENDER_BINARY_NAME),
    source: "cargo",
  });
  candidates.push({
    path: path.join(packageRoot, "render", "target", "debug", RENDER_BINARY_NAME),
    source: "cargo-debug",
  });
  candidates.push({
    path: path.join(packageRoot, "dist", "native", options.triple, RENDER_BINARY_NAME),
    source: "dist",
  });
  return candidates;
}

/** 候选来源的中文说明，只用于日志。 */
const SOURCE_LABELS = {
  from: "--from",
  env: "WAND_RENDER_BIN",
  cargo: "cargo target/release",
  "cargo-debug": "cargo target/debug",
  dist: "dist/native/",
};

/** 已安装版本的来源，只用于日志。 */
const INSTALLED_ORIGIN_LABELS = {
  sidecar: "读自 version 文件",
  binary: "问自二进制",
  missing: "未知",
};

/**
 * 读版本 sidecar（`wand-render.version`）。容忍手工编辑出的空行 / 额外空格，
 * 但不做模糊匹配：读不出合法语义化版本就当没有。
 * @param {string} versionPath
 * @returns {string | null}
 */
export function readVersionSidecar(versionPath) {
  try {
    const raw = readFileSync(versionPath, "utf8");
    const match = raw.trim().split("\n")[0]?.match(SEMVER);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * 问二进制自己要版本。
 *
 * 超时 / 非 0 退出 / 输出里没有语义化版本号，一律返回 null（调用方视为需要替换）。
 * 不吞掉 stderr 也解析它，是因为部分 CLI 把版本打到 stderr。
 * @param {string} binaryPath
 * @returns {string | null}
 */
export function readRenderBinaryVersion(binaryPath) {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    // 不接 stdin：万一对方是「不认 --version 就直接当守护进程跑」的旧二进制，
    // 也不会因为等 TTY 输入而挂满超时窗口。
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(SEMVER);
  return match ? match[0] : null;
}

/**
 * 已安装二进制的版本：优先读 sidecar（快，不 spawn 进程），
 * sidecar 缺失/损坏时回落到问二进制本身。
 * @param {{ targetPath: string, versionPath: string }} options
 * @returns {{ version: string | null, origin: "sidecar" | "binary" | "missing" }}
 */
export function readInstalledRenderVersion(options) {
  const fromFile = readVersionSidecar(options.versionPath);
  if (fromFile) return { version: fromFile, origin: "sidecar" };
  const fromBinary = readRenderBinaryVersion(options.targetPath);
  if (fromBinary) return { version: fromBinary, origin: "binary" };
  return { version: null, origin: "missing" };
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 原子替换：临时文件（同目录，保证 rename 不跨设备）→ chmod → rename 覆盖。
 * 任何一步失败都清掉临时文件，绝不留半截的 `wand-render`。
 * @param {{ sourcePath: string, targetPath: string }} options
 * @returns {void}
 */
export function replaceFileAtomically(options) {
  const tempPath = `${options.targetPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    copyFileSync(options.sourcePath, tempPath);
    chmodSync(tempPath, 0o755);
    renameSync(tempPath, options.targetPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 清理失败不该掩盖真正的错误
    }
    throw error;
  }
}

/**
 * 原子写一个小文本文件（同样 tmp + rename），失败时不留半截内容。
 * @param {{ filePath: string, content: string }} options
 * @returns {void}
 */
function writeTextAtomically(options) {
  const tempPath = `${options.filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tempPath, options.content, { mode: 0o644 });
    renameSync(tempPath, options.filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 同上
    }
    throw error;
  }
}

const NO_OP_LOGGER = () => {};

/**
 * 就位动作的核心实现（无隐式 IO 之外的行为：不联网、不读 config 内容、不杀任何进程）。
 *
 * @param {{
 *   configPath?: string,
 *   from?: string | null,
 *   dryRun?: boolean,
 *   check?: boolean,
 *   force?: boolean,
 *   packageRoot?: string,
 *   platform?: string,
 *   arch?: string,
 *   logger?: (message: string) => void,
 * }} [options]
 * @returns {{
 *   exitCode: number,
 *   action: "skip" | "install" | "would-install" | "check-needs-action" | "unsupported" | "no-source" | "failed",
 *   triple: string | null,
 *   sourcePath: string | null,
 *   sourceVersion: string | null,
 *   targetPath: string | null,
 *   versionPath: string | null,
 *   installedVersion: string | null,
 *   warnings: string[],
 * }}
 */
export function installRenderBinary(options = {}) {
  const dryRun = options.dryRun === true;
  const check = options.check === true;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const configPath = path.resolve(options.configPath ?? defaultConfigPath());
  const configDir = path.dirname(configPath);
  const logger = options.logger ?? NO_OP_LOGGER;
  const base = {
    triple: null,
    sourcePath: null,
    sourceVersion: null,
    targetPath: null,
    versionPath: null,
    installedVersion: null,
    warnings: [],
  };

  const triple = resolvePlatformTriple(platform, arch);
  if (!triple) {
    logger(`wand-render 暂不支持 ${platform}-${arch}，支持 ${SUPPORTED_TRIPLES.join(" / ")}`);
    if (platform === "win32") {
      logger("Windows 需要命名管道，协议第一阶段不实现（见 docs/render-protocol.md §2）。");
    }
    logger("保持 legacy terminald 运行即可；升级链路不做任何改动。");
    return { ...base, exitCode: EXIT_UNSUPPORTED, action: "unsupported" };
  }

  const targetPath = path.join(configDir, RENDER_BIN_SUBDIR, RENDER_BINARY_NAME);
  const versionPath = path.join(configDir, RENDER_BIN_SUBDIR, RENDER_VERSION_FILE_NAME);
  const result = { ...base, triple, targetPath, versionPath };

  logger(`平台 ${triple}，配置目录 ${configDir}`);

  // 源：先命中先用。`--from` 是显式指定，指错了要报错而不是悄悄回落；
  // `WAND_RENDER_BIN` 与 Node 侧 `resolveRenderBinaryPath` 一致：指错了告警后继续按约定查找。
  const candidates = renderBinarySourceCandidates({
    packageRoot: options.packageRoot,
    triple,
    from: options.from ?? null,
  });
  const explicitFrom = options.from ? candidates[0] : null;
  if (explicitFrom && !isFile(explicitFrom.path)) {
    logger(`--from 指定的源二进制不存在或是目录：${explicitFrom.path}`);
    return { ...result, exitCode: EXIT_NO_SOURCE, action: "no-source" };
  }
  const envCandidate = candidates.find((candidate) => candidate.source === "env");
  if (envCandidate && !isFile(envCandidate.path)) {
    logger(`warning: WAND_RENDER_BIN=${envCandidate.path} 不是可执行文件，忽略它继续按约定查找`);
  }
  const source = candidates.find((candidate) => isFile(candidate.path)) ?? null;

  const targetExists = isFile(targetPath);
  const installed = targetExists
    ? readInstalledRenderVersion({ targetPath, versionPath })
    : { version: null, origin: /** @type {"missing"} */ ("missing") };
  result.installedVersion = installed.version;

  if (!source) {
    if (targetExists) {
      // 有可用的旧二进制、但包里没有该平台的源：保持现状，不动磁盘。
      logger(`已安装 ${targetPath}${installed.version ? ` (v${installed.version})` : ""}，但找不到源二进制（本平台可能未随包分发）。`);
      logger("不动磁盘，继续使用已安装版本。");
      return { ...result, exitCode: EXIT_OK, action: "skip" };
    }
    logger(`未找到 wand-render 源二进制（triple ${triple}）。`);
    logger(`期望路径：${candidates.map((candidate) => candidate.path).join(" 或 ")}`);
    logger("开发态可先跑 `npm run build:render-native`（cargo build --release）；升级态可先跑 `npm run build:render-bin` 把 render-bin 的产物 stage 到 dist/native/。");
    return { ...result, exitCode: EXIT_NO_SOURCE, action: "no-source" };
  }

  result.sourcePath = source.path;
  result.sourceVersion = readRenderBinaryVersion(source.path);
  if (!result.sourceVersion) {
    // 版本读不出来时不能拿它当「一致」，否则会把坏二进制装上去还得不到提示。
    result.warnings.push(`无法从 ${source.path} 读出 --version，视为需要替换`);
  }
  const sourceLabel = SOURCE_LABELS[source.source] ?? source.source;
  const sourceVersionLabel = result.sourceVersion ? ` v${result.sourceVersion}` : " 版本未知";
  logger(`源二进制：${source.path}（${sourceLabel}）${sourceVersionLabel}`);

  const installedLabel = targetExists
    ? `${targetPath} (v${installed.version ?? "未知"}，${INSTALLED_ORIGIN_LABELS[installed.origin]})`
    : "无";
  logger(`已安装：${installedLabel}`);

  const matches = !!installed.version && installed.version === result.sourceVersion;
  const needsAction = !targetExists || !matches || options.force === true;

  if (!needsAction) {
    logger(`版本一致（v${installed.version}），跳过：不写磁盘、不重启任何进程。`);
    return { ...result, exitCode: EXIT_OK, action: "skip" };
  }

  const reason = !targetExists
    ? "目标不存在"
    : matches
      ? "版本一致但指定了 --force"
      : `版本不一致（已装 ${installed.version ?? "未知"} → 源 ${result.sourceVersion ?? "未知"}）`;
  logger(`需要就位（${reason}）。`);

  if (check) {
    logger("--check 只报告不改动；去掉 --check 再跑一次即会就位。");
    return { ...result, exitCode: EXIT_NEEDS_ACTION, action: "check-needs-action" };
  }

  if (dryRun) {
    logger(`将写入 ${targetPath}，并写版本文件 ${versionPath}`);
    return { ...result, exitCode: EXIT_OK, action: "would-install" };
  }

  try {
    mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    replaceFileAtomically({ sourcePath: source.path, targetPath });
    // sidecar 与二进制一起原子替换；先写二进制再写版本号，读到旧版本号最多导致下次重装，
    // 反过来则会「版本说新的、二进制是旧的」——那才是难查的错。
    writeTextAtomically({
      filePath: versionPath,
      content: `${result.sourceVersion ?? "unknown"}\n`,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? ` (${error.code})` : "";
    logger(`就位失败${code}：${error instanceof Error ? error.message : String(error)}`);
    logger("常见原因：目标目录只读 / 无写权限 / 磁盘满。已安装的旧二进制未被破坏（原子替换）。");
    return { ...result, exitCode: EXIT_INSTALL_FAILED, action: "failed" };
  }

  logger(`已就位 ${targetPath}${result.sourceVersion ? ` v${result.sourceVersion}` : ""}`);
  logger(`版本文件 ${versionPath}`);

  // 装完再问一次：确认放下去的确实是能跑的二进制（架构不匹配 / 动态库缺失都会在这里露出来）。
  const installedNow = readRenderBinaryVersion(targetPath);
  if (!installedNow) {
    result.warnings.push(`安装后无法执行 ${targetPath} --version，请检查架构与权限`);
  } else if (result.sourceVersion && installedNow !== result.sourceVersion) {
    result.warnings.push(`安装后版本为 ${installedNow}，与源 ${result.sourceVersion} 不一致`);
  }
  for (const warning of result.warnings) logger(`warning: ${warning}`);

  return { ...result, exitCode: EXIT_OK, action: "install" };
}

/**
 * @param {string[]} argv
 * @returns {{ configPath?: string, from?: string | null, dryRun: boolean, check: boolean, force: boolean, help: boolean, error?: string }}
 */
export function parseArgs(argv) {
  const options = { dryRun: false, check: false, force: false, help: false, from: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, null];
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      return argv[index];
    };
    if (name === "--dry-run") options.dryRun = true;
    else if (name === "--check") options.check = true;
    else if (name === "--force") options.force = true;
    else if (name === "--help" || name === "-h") options.help = true;
    else if (name === "--from") {
      const value = takeValue();
      if (!value) return { ...options, error: "--from 需要一个路径" };
      options.from = value;
    } else if (name === "--config" || name === "-c") {
      const value = takeValue();
      if (!value) return { ...options, error: `${name} 需要一个路径` };
      options.configPath = value;
    } else {
      return { ...options, error: `未知参数 ${arg}` };
    }
  }
  return options;
}

const USAGE = `用法：node scripts/install-render-binary.js [选项]

把平台专用的 wand-render 二进制就位到 <configDir>/bin/wand-render（原子替换 + 版本幂等）。

选项：
  --config <path>, -c <path>  配置文件路径（默认 ~/.wand/config.json）；只用其所在目录
  --from <path>               显式指定源二进制（优先级最高；路径不存在直接报错）
  --dry-run                   只报告将要做什么，不写磁盘
  --check                     只报告现状与是否需要就位，不写磁盘
  --force                     版本一致也强制替换（本地同版本重新构建后刷盘用）
  -h, --help                  显示本帮助

源优先级（先命中先用）：
  1) --from <path>
  2) $WAND_RENDER_BIN
  3) <pkg>/render/target/release/wand-render（开发态 cargo build）
  4) <pkg>/render/target/debug/wand-render（开发态）
  5) <pkg>/dist/native/<triple>/wand-render（npm 包内嵌；由 npm run build:render-bin 写入）
安装目标：<configDir>/bin/wand-render（mode 0755）+ <configDir>/bin/wand-render.version

退出码：
  0  已就位 / 已是最新 / dry-run 判定无需或可以就位
  1  平台不支持（darwin/linux 之外）或参数错误
  2  找不到源二进制
  3  就位失败（只读盘 / 无写权限 / 磁盘满）
  4  --check 判定需要就位

设计说明与升级/回滚流程：docs/render-upgrade-path.md`;

/**
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (options.error) {
    console.error(`error: ${options.error}`);
    console.error(USAGE);
    return EXIT_UNSUPPORTED;
  }
  const result = installRenderBinary({
    configPath: options.configPath,
    from: options.from,
    dryRun: options.dryRun,
    check: options.check,
    force: options.force,
    logger: (message) => console.log(`[wand-render] ${message}`),
  });
  return result.exitCode;
}

// 只有被直接执行时才跑 main；被 import 时只暴露函数（Server 自检复用同一份实现）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
