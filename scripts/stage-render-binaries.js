#!/usr/bin/env node
/**
 * 把 `render-bin` 子模块里 pin 住的 wand-render 产物 stage 到 `dist/native/<triple>/`，
 * 供 npm 包内嵌（`dist/` 在 package.json 的 `files` 里）。
 *
 * 为什么必须有这一步，而不是运行时去读 `render-bin/`：
 *   - npm 全局安装的结果里只有 `dist/` + `browser-extension` + 少量 `scripts/`；
 *     `render-bin` 子模块**不会**出现在安装结果里。包要在发布前就把二进制塞进 dist。
 *   - 二进制经 npm / git 传输会丢可执行位（legacy 的 node-pty spawn-helper 就栽在这），
 *     所以 stage 完必须显式 chmod 0755，并留下 `.sha256` sidecar 让下游可校验。
 *   - 三重校验（sha256 / 可执行且版本一致 / 不是 stub）是硬门槛：曾经有一个只打印
 *     `(stub)` 的 302KB 假二进制进过分发目录。校验失败一律**报错退出**，绝不「放行让下游发现」。
 *   - `render-bin` 子模块没初始化时要**警告并跳过**（退出码 0）：没拉子模块的开发机上
 *     `npm run build` 不该因此失败；`--strict` 才是「必须内嵌」的场景（CI 发布链路）。
 *
 * 用法见 `--help`；布局与升级路径见 `docs/render-upgrade-path.md`。
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
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

/** 已发布产物的子模块目录与索引文件名。 */
export const RENDER_BIN_DIR_NAME = "render-bin";
export const MANIFEST_FILE_NAME = "manifest.json";

export const BINARY_NAME = "wand-render";
export const VERSION_FILE_NAME = "wand-render.version";
export const SHA256_FILE_NAME = "wand-render.sha256";

/**
 * 支持的平台三元组，必须与 `render-bin/manifest.json` 的键和
 * `src/render-binary.ts` 的 `SUPPORTED_RENDER_TRIPLES` 一致。
 * `src` 侧与 `scripts` 侧的解析逻辑各自独立（TS 不能直接被构建脚本 import），
 * 一致性由 `tests/render-staging.test.ts` 的对照用例守住。
 */
export const SUPPORTED_TRIPLES = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const ARCH_PROBE_TIMEOUT_MS = 1_000;
const SEMVER = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?/;

/** `uname -m` 的架构别名 → Node 的 process.arch 命名。 */
const MACHINE_ARCH_ALIASES = {
  arm64: "arm64",
  aarch64: "arm64",
  x86_64: "x64",
  amd64: "x64",
  x64: "x64",
};

/** `uname -m` 输出归一化；认不出返回 null。 */
export function normalizeMachineArch(machine) {
  if (typeof machine !== "string") return null;
  return MACHINE_ARCH_ALIASES[machine.trim().toLowerCase()] ?? null;
}

/**
 * 平台三元组；不在支持列表里返回 null（调用方给出明确结论，不静默降级）。
 *
 * 用 `uname -m` 而不是 `process.arch`：macOS 上 Node 跑在 Rosetta 里时它报 `x64`，
 * 机器其实是 arm64；`rosettaTranslated` 是反向兜底（翻译态下 `uname -m` 也报 x86_64）。
 */
export function resolvePlatformTriple(platform, arch, unameMachine, rosettaTranslated = false) {
  let normalizedArch = normalizeMachineArch(unameMachine) ?? arch;
  if (platform === "darwin" && normalizedArch === "x64" && rosettaTranslated) normalizedArch = "arm64";
  const triple = `${platform}-${normalizedArch}`;
  return SUPPORTED_TRIPLES.includes(triple) ? triple : null;
}

function runUnameMachine() {
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

function isRosettaTranslated() {
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

/** 文件 sha256（hex，小写）。产物不到 1 MB，整块读即可。 */
export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 执行二进制拿版本。
 *
 * `isStub` 单独判一次是为了给出可读的报错（stub 通常连语义化版本号都没有，
 * 只按版本比对会报「版本不一致」，看不出真正原因）。
 */
export function probeRenderBinary(binaryPath) {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    // 不接 stdin：万一对方是「不认 --version 就直接当守护进程跑」的旧二进制，
    // 也不会因为等 TTY 输入而挂满超时窗口。
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const ran = !result.error && result.status === 0;
  return {
    ran,
    output,
    version: ran ? SEMVER.exec(output)?.[0] ?? null : null,
    isStub: /stub/i.test(output),
  };
}

/**
 * 读 manifest。区分「子模块没初始化」（缺文件 → 可跳过）与「文件坏了」（硬错误）。
 */
export function readManifest(manifestPath) {
  if (!isFile(manifestPath)) return { ok: false, missing: true, error: `${manifestPath} 不存在` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, missing: false, error: `${manifestPath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  const latest = parsed && typeof parsed.latest === "string" ? parsed.latest : null;
  const entry = latest && parsed.versions && typeof parsed.versions === "object" ? parsed.versions[latest] : null;
  if (!latest || !entry || typeof entry !== "object") {
    return { ok: false, missing: false, error: `${manifestPath} 缺少 latest/versions 结构` };
  }
  const triples = entry.triples && typeof entry.triples === "object" ? entry.triples : null;
  if (!triples) {
    return { ok: false, missing: false, error: `${manifestPath} 的 versions["${latest}"] 缺少 triples` };
  }
  return { ok: true, missing: false, data: { latest, entry, triples } };
}

/** 在临时目录里造一份 0755 的可执行副本再探测（不碰 dist/，也不假设源文件带可执行位）。 */
function withExecutableCopy(sourcePath, body) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "wand-render-probe-"));
  try {
    const tempPath = path.join(tempDir, BINARY_NAME);
    copyFileSync(sourcePath, tempPath);
    chmodSync(tempPath, 0o755);
    return body(tempPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 校验单个产物：尺寸、sha256、能否执行、版本是否与 manifest 一致、是否 stub。
 * @returns {string | null} 通过返回 null，否则返回可直接打印的原因
 */
function verifyArtifact({ triple, artifact, sourcePath, expectedVersion }) {
  if (!isFile(sourcePath)) return `${triple}: 产物缺失 ${sourcePath}（manifest 指向的路径不对？）`;

  const actualSize = statSync(sourcePath).size;
  if (typeof artifact.size === "number" && actualSize !== artifact.size) {
    return `${triple}: 尺寸与 manifest 不一致（实际 ${actualSize}，manifest ${artifact.size}）`;
  }
  const actualSha = sha256File(sourcePath);
  const expectedSha = typeof artifact.sha256 === "string" ? artifact.sha256.trim().toLowerCase() : "";
  if (!expectedSha) return `${triple}: manifest 里没有 sha256，拒绝安装未固定哈希的产物`;
  if (actualSha !== expectedSha) {
    return `${triple}: sha256 与 manifest 不一致（实际 ${actualSha}，manifest ${expectedSha}）——产物被改过或仓库损坏`;
  }

  const probe = withExecutableCopy(sourcePath, probeRenderBinary);
  if (!probe.ran) {
    return `${triple}: 无法执行 ${sourcePath} --version（架构不符 / 动态库缺失 / 文件损坏）：${probe.output || "无输出"}`;
  }
  if (probe.isStub) return `${triple}: 产物是 stub（--version 输出 ${JSON.stringify(probe.output)}），拒绝进入分发目录`;
  if (!probe.version) return `${triple}: --version 输出里读不出语义化版本号：${JSON.stringify(probe.output)}`;
  if (probe.version !== expectedVersion) {
    return `${triple}: 产物版本 ${probe.version} 与 manifest latest ${expectedVersion} 不一致`;
  }
  return null;
}

function writeTextAtomically(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tempPath, content, { mode: 0o644 });
    renameSync(tempPath, filePath);
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
 * 把单个 triple 的产物 stage 到 dist。写路径用「临时文件 → chmod → rename」：
 * 绝不留下半截的 `wand-render`，也绝不就地改写一个可能正在被执行的二进制。
 * @returns {{ error: string | null, targetPath: string, sha256: string, version: string }}
 */
function stageTriple({ triple, artifact, sourcePath, expectedVersion, distDir, write }) {
  const targetPath = path.join(distDir, "native", triple, BINARY_NAME);
  const sha256 = sha256File(sourcePath);
  if (!write) return { error: null, targetPath, sha256, version: expectedVersion };

  mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    copyFileSync(sourcePath, tempPath);
    // 可执行位必须在 rename 之前设好：先就位再 chmod 会留下一个短暂的不可执行文件。
    chmodSync(tempPath, 0o755);
    const probe = probeRenderBinary(tempPath);
    if (!probe.ran || probe.isStub || probe.version !== expectedVersion) {
      throw new Error(
        `就位后的副本自检失败（ran=${probe.ran} stub=${probe.isStub} version=${probe.version}，期望 ${expectedVersion}）：${probe.output || "无输出"}`,
      );
    }
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 同上
    }
    return { error: `${triple}: ${error instanceof Error ? error.message : String(error)}`, targetPath, sha256, version: expectedVersion };
  }
  writeTextAtomically(path.join(path.dirname(targetPath), VERSION_FILE_NAME), `${expectedVersion}\n`);
  writeTextAtomically(path.join(path.dirname(targetPath), SHA256_FILE_NAME), `${sha256}  ${BINARY_NAME}\n`);
  return { error: null, targetPath, sha256, version: expectedVersion };
}

/**
 * 核心实现（除了 dist/native 之外不写任何磁盘；不联网、不读 config、不杀进程）。
 *
 * @param {{
 *   check?: boolean, dryRun?: boolean, all?: boolean, strict?: boolean,
 *   triples?: string[], packageRoot?: string, renderBinDir?: string, distDir?: string,
 *   platform?: string, arch?: string, unameMachine?: string | null, rosettaTranslated?: boolean,
 *   logger?: (message: string) => void,
 * }} [options]
 * @returns {{
 *   exitCode: number,
 *   action: "staged" | "would-stage" | "checked" | "skipped" | "failed",
 *   version: string | null,
 *   triples: string[],
 *   staged: { triple: string, sourcePath: string, targetPath: string, sha256: string, version: string }[],
 *   warnings: string[],
 *   messages: string[],
 * }}
 */
export function stageRenderBinaries(options = {}) {
  const messages = [];
  const log = (message) => {
    messages.push(message);
    (options.logger ?? (() => {}))(message);
  };
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    log(`warning: ${message}`);
  };

  const check = options.check === true;
  const dryRun = options.dryRun === true;
  const strict = options.strict === true;
  const all = options.all === true;
  const requested = (options.triples ?? []).filter((triple) => typeof triple === "string" && triple);
  const packageRoot = path.resolve(options.packageRoot ?? PACKAGE_ROOT);
  const renderBinDir = path.resolve(options.renderBinDir ?? path.join(packageRoot, RENDER_BIN_DIR_NAME));
  const distDir = path.resolve(options.distDir ?? path.join(packageRoot, "dist"));
  const manifestPath = path.join(renderBinDir, MANIFEST_FILE_NAME);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const unameMachine = options.unameMachine !== undefined ? options.unameMachine : runUnameMachine();
  const rosettaTranslated = options.rosettaTranslated ?? isRosettaTranslated();
  const base = { version: null, triples: [], staged: [], warnings, messages };

  if (all && requested.length > 0) {
    log("error: --all 与 --triple 不能同时使用");
    return { ...base, exitCode: EXIT_FAILED, action: "failed" };
  }

  const manifest = readManifest(manifestPath);
  if (!manifest.ok) {
    if (manifest.missing && !strict) {
      // 没拉子模块的开发机不该因为缺少发布产物而构建失败。
      warn(`${manifest.error}；跳过内嵌平台二进制（本机构建仍可用，只是包里没有 wand-render）`);
      log(`需要内嵌产物时：git submodule update --init ${RENDER_BIN_DIR_NAME}`);
      return { ...base, exitCode: EXIT_OK, action: "skipped" };
    }
    log(`error: ${manifest.error}${manifest.missing ? "（--strict 下视为失败）" : ""}`);
    return { ...base, exitCode: EXIT_FAILED, action: "failed" };
  }

  const { latest, triples: versionTriples } = manifest.data;
  const available = Object.keys(versionTriples);
  log(`${RENDER_BIN_DIR_NAME} v${latest}（协议 ${JSON.stringify(manifest.data.entry.protocolVersion ?? "?")}），可用平台：${available.join(", ") || "无"}`);
  log(`目标目录：${path.join(distDir, "native")}`);

  let selected;
  if (all) {
    selected = available.slice().sort();
  } else if (requested.length > 0) {
    const unknown = requested.filter((triple) => !available.includes(triple));
    if (unknown.length > 0) {
      log(`error: manifest v${latest} 里没有这些平台：${unknown.join(", ")}`);
      return { ...base, version: latest, exitCode: EXIT_FAILED, action: "failed" };
    }
    selected = requested;
  } else {
    const triple = resolvePlatformTriple(platform, arch, unameMachine, rosettaTranslated);
    if (!triple) {
      warn(`不支持的平台：${platform}-${normalizeMachineArch(unameMachine) ?? arch}（支持 ${SUPPORTED_TRIPLES.join(" / ")}）`);
      return { ...base, version: latest, exitCode: strict ? EXIT_FAILED : EXIT_OK, action: strict ? "failed" : "skipped" };
    }
    if (!available.includes(triple)) {
      warn(`manifest v${latest} 里没有 ${triple} 的产物（本平台可能未分发）`);
      return { ...base, version: latest, exitCode: strict ? EXIT_FAILED : EXIT_OK, action: strict ? "failed" : "skipped" };
    }
    selected = [triple];
  }

  const staged = [];
  const failures = [];
  for (const triple of selected) {
    const artifact = versionTriples[triple] ?? {};
    const sourcePath = path.join(renderBinDir, typeof artifact.path === "string" && artifact.path ? artifact.path : path.join(`v${latest}`, triple, BINARY_NAME));
    const problem = verifyArtifact({ triple, artifact, sourcePath, expectedVersion: latest });
    if (problem) {
      failures.push(problem);
      log(`error: ${problem}`);
      continue;
    }
    const sizeLabel = typeof artifact.size === "number" ? `${artifact.size} bytes` : "size 未知";
    log(`${triple}: 校验通过（sha256 ${sha256File(sourcePath).slice(0, 12)}…，${sizeLabel}，v${latest}）`);

    const result = stageTriple({ triple, artifact, sourcePath, expectedVersion: latest, distDir, write: !check && !dryRun });
    if (result.error) {
      failures.push(result.error);
      log(`error: ${result.error}`);
      continue;
    }
    staged.push({ triple, sourcePath, targetPath: result.targetPath, sha256: result.sha256, version: result.version });

    if (check) {
      if (!isFile(result.targetPath)) {
        warn(`${result.targetPath} 尚未 stage（构建时由本脚本写入）`);
        if (strict) {
          const message = `${triple}: --check --strict 要求 dist 里已经有产物，但 ${result.targetPath} 不存在`;
          failures.push(message);
          log(`error: ${message}`);
        }
      } else {
        const stagedSha = sha256File(result.targetPath);
        if (stagedSha !== result.sha256) {
          failures.push(`${triple}: 已 stage 的 ${result.targetPath} sha256 与产物不一致（实际 ${stagedSha}）`);
          log(`error: ${failures[failures.length - 1]}`);
        } else {
          log(`${triple}: 已 stage 的副本一致（${result.targetPath}）`);
        }
      }
      continue;
    }
    if (dryRun) {
      log(`${triple}: 将写入 ${result.targetPath}（mode 0755）与 ${VERSION_FILE_NAME} / ${SHA256_FILE_NAME} sidecar`);
      continue;
    }
    log(`${triple}: 已 stage ${result.targetPath}（mode 0755，v${latest}）`);
  }

  if (failures.length > 0) {
    log(`error: ${failures.length} 个平台校验/就位失败，未写入的产物不会被内嵌`);
    return { ...base, version: latest, triples: selected, staged, exitCode: EXIT_FAILED, action: "failed" };
  }
  const action = check ? "checked" : dryRun ? "would-stage" : "staged";
  return { ...base, version: latest, triples: selected, staged, exitCode: EXIT_OK, action };
}

/**
 * @param {string[]} argv
 * @returns {{
 *   check: boolean, dryRun: boolean, all: boolean, strict: boolean, help: boolean,
 *   triples: string[], renderBinDir?: string, distDir?: string, error?: string,
 * }}
 */
export function parseArgs(argv) {
  const options = { check: false, dryRun: false, all: false, strict: false, help: false, triples: [] };
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
    if (name === "--check") options.check = true;
    else if (name === "--dry-run") options.dryRun = true;
    else if (name === "--all") options.all = true;
    else if (name === "--strict") options.strict = true;
    else if (name === "--help" || name === "-h") options.help = true;
    else if (name === "--triple") {
      const value = takeValue();
      if (!value) return { ...options, error: "--triple 需要一个三元组名（如 darwin-arm64）" };
      options.triples.push(value);
    } else if (name === "--render-bin") {
      const value = takeValue();
      if (!value) return { ...options, error: "--render-bin 需要一个目录" };
      options.renderBinDir = value;
    } else if (name === "--dist") {
      const value = takeValue();
      if (!value) return { ...options, error: "--dist 需要一个目录" };
      options.distDir = value;
    } else {
      return { ...options, error: `未知参数 ${arg}` };
    }
  }
  return options;
}

const USAGE = `用法：node scripts/stage-render-binaries.js [选项]

把 ${RENDER_BIN_DIR_NAME}/manifest.json 里 pin 住的 wand-render 产物 stage 到 dist/native/<triple>/，
供 npm 包内嵌（dist/ 在 package.json 的 files 里）。

选项：
  --triple <name>    只 stage 指定三元组（可重复；默认按当前平台，含 Rosetta / uname 判定）
  --all              stage manifest 列出的所有平台
  --check            只校验（sha256 / 可执行 / 版本 / stub；并比对已 stage 的副本），不写磁盘
  --dry-run          只报告将写入什么，不写磁盘（仍做全部校验）
  --strict           ${RENDER_BIN_DIR_NAME} 子模块未初始化 / 本平台无产物 / --check 时 dist 里没有已 stage 的产物 → 视为失败（CI 发布链路用）
  --render-bin <dir> 指定 ${RENDER_BIN_DIR_NAME} 目录（默认 <pkg>/${RENDER_BIN_DIR_NAME}）
  --dist <dir>       指定 dist 目录（默认 <pkg>/dist）
  -h, --help         显示本帮助

退出码：
  0  已 stage / 可 stage / --check 校验通过（子模块未初始化时也是 0：警告并跳过）
  1  校验失败（sha256 不符 / 版本不符 / stub / 无法执行）、参数错误、--strict 下的缺产物

双重校验说明：sha256 是唯一「产物是否被改动」的判据（manifest 是 pin）；--version 自检
是唯一「这个二进制真能跑、且不是 stub」的判据。两者都不通过就不写进 dist。`;

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
    return EXIT_FAILED;
  }
  const result = stageRenderBinaries({
    check: options.check,
    dryRun: options.dryRun,
    all: options.all,
    strict: options.strict,
    triples: options.triples,
    renderBinDir: options.renderBinDir,
    distDir: options.distDir,
    logger: (message) => console.log(`[wand-render] ${message}`),
  });
  return result.exitCode;
}

// 只有被直接执行时才跑 main；被 import（测试 / Server 自检）时只暴露函数。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
