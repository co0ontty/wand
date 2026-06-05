import { existsSync, readdirSync } from "node:fs";
import { compareSemver } from "./version-utils.js";
import { getErrorMessage } from "./error-utils.js";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

/**
 * 运行时 PATH 自修复。
 *
 * 背景：用户把 wand 装成 systemd / launchd 服务时，service unit 文件里的 PATH
 * 是"安装那一刻"的快照（见 src/tui/commands.ts:buildServicePath）。之后：
 *   - 用户切 node 版本（nvm/fnm/volta），claude 装到新的 bin 目录；
 *   - 或 `npm install -g @co0ontty/wand` 重装，但没重新跑 `wand service:install`，
 *     install.sh 只 `systemctl start`，unit 里的 PATH 一直是老的；
 *   - 或 claude 装到 `~/.bun/bin`、`~/.local/bin` 等当时不在 PATH 里的位置。
 *
 * 服务进程的 process.env.PATH 就是这份陈旧快照。process-manager 给 PTY 子进程
 * 用 buildChildEnv(inheritEnv=true) 时把这份 PATH 直接透传，于是 spawn 出来的
 * shell 里 `claude` 找不到 → "command not found"。
 *
 * 修复分两层（都在 startServer() 开头跑）：
 *   1. repairRuntimePath()（同步、cheap）：扫常见工具链 bin 目录，把存在但 PATH
 *      里缺的"追加"到 process.env.PATH 末尾。
 *   2. deepRepairRuntimePath()（异步、贵一点）：起一个 login shell 拉用户实际的
 *      PATH（覆盖 ~/.bashrc、~/.zshrc、nvm/fnm/volta 的 shell-init 等所有动态
 *      逻辑），把里面 PATH 里我们还没的目录"前插"到 process.env.PATH 前面。这
 *      是真正能修好"unit 里 PATH 太旧、用户 shell 里却好好的"这种场景的关键。
 *
 * 设计决策：
 *   - 同步那层只追加不前插：尊重用户已有顺序；异步那层愿意前插，因为它拿到的是
 *     用户实际"会用的"PATH，比 unit 里的更可信。
 *   - 只加 existsSync 真实存在的：避免 PATH 里塞一堆死路径。
 *   - 用 path.delimiter：Windows 用 `;`，POSIX 用 `:`，跨平台安全。
 *   - 不重写 service unit：那需要 sudo，且语义太重；只在 install.sh 主动调
 *     `wand service:install` 时才重新烧 PATH。
 *   - login shell 用 -lc 跑，4 秒超时；失败就静默走同步路径，不阻塞启动。
 *
 * WAND_PATH_REPAIR_DISABLE=1 可以彻底关掉同步那层（极端情况下用户想完全控制 PATH 时用）。
 * WAND_PATH_REPAIR_DEEP_DISABLE=1 只关掉 login shell 探测，但保留同步追加。
 */

export interface PathRepairResult {
  /** 实际新追加进 PATH 的目录（按追加顺序）。 */
  added: string[];
  /** 关键命令的解析结果（PATH 修复后 `which` 出来的）。null = 没找到。 */
  resolved: Record<string, string | null>;
  /** 修复后的 PATH 整体；调试用。 */
  finalPath: string;
  /** login shell 探测阶段的状态：success / disabled / failed / skipped。 */
  deepProbe: "success" | "disabled" | "failed" | "skipped";
  /** 异步阶段产生的告警信息（login shell 超时、解析失败等）。 */
  warnings: string[];
}

/** 关键的 CLI 工具，会被诊断输出。 */
const PROBE_COMMANDS = ["claude", "codex"] as const;

const DEEP_PROBE_TIMEOUT_MS = 4000;

/**
 * 构造候选 bin 目录列表（按优先级，前面的更可信）。
 *
 * 顺序原则：
 *   1. 当前 node 的 bin 目录（claude 大概率就装这里：`npm install -g claude` 把 bin
 *      放在与 node 同 prefix 的 bin 目录）；
 *   2. 用户级常见 npm-global / 语言工具链路径；
 *   3. Homebrew（macOS）；
 *   4. /usr/local/... 等系统标准路径兜底。
 */
function candidateBinDirs(): string[] {
  const home = os.homedir();
  const nodeBinDir = path.dirname(process.execPath);

  const candidates: string[] = [
    nodeBinDir,
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".pnpm"),
    path.join(home, "Library", "pnpm"),   // pnpm 在 macOS 默认这里
  ];

  // nvm / fnm / n 这种多版本管理器：扫最新几个 node 版本的 bin 目录加进去。
  // 不会拿单一"激活"版本（service 进程拿不到 shell init），所以宁可多塞几个；
  // 重复目录会在 repairRuntimePath() 的 Set 里被去重。
  for (const dir of scanNodeVersionManagerBins(home)) candidates.push(dir);

  if (process.platform === "darwin") {
    candidates.push("/opt/homebrew/bin", "/opt/homebrew/sbin");
  }
  candidates.push(
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  );

  return candidates;
}

/**
 * 扫各种 node 版本管理器的 bin 目录。返回的路径都不带 versions/<v>/bin 检查——
 * 调用方负责 existsSync 过滤。
 *
 * 覆盖：
 *   - nvm:        ~/.nvm/versions/node/<v>/bin
 *   - fnm:        ~/.local/share/fnm/node-versions/<v>/installation/bin 或
 *                 ~/Library/Application Support/fnm/node-versions/<v>/installation/bin
 *   - n（tj/n）:  /usr/local/n/versions/node/<v>/bin
 */
function scanNodeVersionManagerBins(home: string): string[] {
  const results: string[] = [];

  // nvm
  const nvmBase = path.join(home, ".nvm", "versions", "node");
  for (const v of listLatestVersions(nvmBase, 4)) {
    results.push(path.join(nvmBase, v, "bin"));
  }

  // fnm（Linux 默认 / macOS 默认）
  const fnmCandidates = [
    path.join(home, ".local", "share", "fnm", "node-versions"),
    path.join(home, "Library", "Application Support", "fnm", "node-versions"),
  ];
  for (const fnmBase of fnmCandidates) {
    for (const v of listLatestVersions(fnmBase, 4)) {
      results.push(path.join(fnmBase, v, "installation", "bin"));
    }
  }

  // tj/n
  const nBase = "/usr/local/n/versions/node";
  for (const v of listLatestVersions(nBase, 4)) {
    results.push(path.join(nBase, v, "bin"));
  }

  return results;
}

/** 列出 base 下"看起来像 node 版本号"的目录，按 semver 降序取前 N 个。 */
function listLatestVersions(base: string, limit: number): string[] {
  if (!existsSync(base)) return [];
  try {
    const entries = readdirSync(base);
    return entries
      .filter((e) => /^v?\d+\.\d+\.\d+/.test(e))
      .sort((a, b) => compareSemver(b, a))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 把候选目录中"存在 + 未在 PATH 中"的追加到 process.env.PATH。
 *
 * 不会去重已经在 PATH 里的项（即使顺序不理想也保持原样），只往末尾补。
 */
export function repairRuntimePath(): PathRepairResult {
  if (process.env.WAND_PATH_REPAIR_DISABLE === "1") {
    return {
      added: [],
      resolved: probeCommands(),
      finalPath: process.env.PATH ?? "",
      deepProbe: "disabled",
      warnings: [],
    };
  }

  const delim = path.delimiter;
  const currentPath = process.env.PATH ?? "";
  const existing = new Set(
    currentPath
      .split(delim)
      .map((seg) => seg.trim())
      .filter((seg) => seg.length > 0),
  );

  const added: string[] = [];
  for (const dir of candidateBinDirs()) {
    if (!dir || existing.has(dir)) continue;
    // existsSync 不抛错，权限不够 / 路径里有 EACCES 都返回 false，安全。
    let ok = false;
    try {
      ok = existsSync(dir);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    existing.add(dir);
    added.push(dir);
  }

  if (added.length > 0) {
    const suffix = added.join(delim);
    process.env.PATH = currentPath
      ? `${currentPath}${delim}${suffix}`
      : suffix;
  }

  return {
    added,
    resolved: probeCommands(),
    finalPath: process.env.PATH ?? "",
    deepProbe: "skipped",
    warnings: [],
  };
}

/**
 * 在 repairRuntimePath() 同步追加完之后，再用 login shell 拉一份用户实际的 PATH
 * 合并进来。这是真正能修好"unit 里 PATH 太旧、用户 shell 里 claude 好好的"那种
 * 升级回归的关键——同步阶段只能扫已知路径，login shell 才能拿到 nvm/fnm/volta
 * 这种动态注入的 PATH。
 *
 * 行为：
 *   - 跑 `${shell} -l -c '...'` 拉 $PATH 和 command -v claude/codex（4s 超时）
 *   - 把 login shell PATH 里我们还没收录的目录 **前插** 到 process.env.PATH（注意
 *     是前插，不是追加 —— 它比 unit 里的更可信）
 *   - 失败时静默走同步那一版结果
 *
 * 接受一个已经跑过同步阶段的 result，在上面 mutate。
 */
export async function deepRepairRuntimePath(
  result: PathRepairResult,
  opts: { shell?: string; timeoutMs?: number } = {},
): Promise<PathRepairResult> {
  if (process.env.WAND_PATH_REPAIR_DISABLE === "1") {
    result.deepProbe = "disabled";
    return result;
  }
  if (process.env.WAND_PATH_REPAIR_DEEP_DISABLE === "1") {
    result.deepProbe = "disabled";
    return result;
  }

  const shell = pickProbeShell(opts.shell);
  if (!shell) {
    result.warnings.push("跳过 login shell 探测：未找到可用 shell");
    result.deepProbe = "skipped";
    return result;
  }

  let probe: ProbeResult;
  try {
    probe = await probeLoginShell(shell, opts.timeoutMs ?? DEEP_PROBE_TIMEOUT_MS);
  } catch (err) {
    result.warnings.push(`login shell 探测失败 (${shell}): ${getErrorMessage(err)}`);
    result.deepProbe = "failed";
    return result;
  }

  const delim = path.delimiter;
  const existing = new Set(
    (process.env.PATH ?? "")
      .split(delim)
      .map((seg) => seg.trim())
      .filter((seg) => seg.length > 0),
  );

  // login shell 报告的所有 PATH 段 + claude/codex 解析出的目录都纳入候选。
  const fromShell: string[] = [];
  for (const seg of probe.path.split(delim).map((s) => s.trim()).filter(Boolean)) {
    fromShell.push(seg);
  }
  if (probe.claude) fromShell.push(path.dirname(probe.claude));
  if (probe.codex) fromShell.push(path.dirname(probe.codex));

  const additions: string[] = [];
  for (const dir of fromShell) {
    if (!dir || existing.has(dir)) continue;
    let ok = false;
    try { ok = existsSync(dir); } catch { ok = false; }
    if (!ok) continue;
    existing.add(dir);
    additions.push(dir);
  }

  if (additions.length > 0) {
    // 前插：login shell 的 PATH 优先级比 unit 写死的高，让 claude 解析到用户期望的版本。
    const prefix = additions.join(delim);
    const currentPath = process.env.PATH ?? "";
    process.env.PATH = currentPath ? `${prefix}${delim}${currentPath}` : prefix;
    result.added.push(...additions);
  }

  result.finalPath = process.env.PATH ?? "";
  // 修复完再 probe 一次，让 resolved 字段反映最终能找到的位置（之前 sync 阶段
  // 可能 claude 还是 missing，login shell 注入 nvm 目录后这次能命中）。
  result.resolved = probeCommands();
  result.deepProbe = "success";
  return result;
}

interface ProbeResult {
  path: string;
  claude: string | null;
  codex: string | null;
}

function pickProbeShell(configured?: string): string | null {
  const candidates = [
    configured,
    process.env.SHELL,
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/zsh",
    "/usr/bin/zsh",
    "/bin/sh",
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 用 login shell 跑一段最小脚本，拿到用户实际的 PATH 和 claude/codex 解析路径。
 * 用 \x1f（ASCII Unit Separator）作字段分隔符避免和路径里的字符冲突。
 */
function probeLoginShell(shell: string, timeoutMs: number): Promise<ProbeResult> {
  const script =
    `printf 'PATH\\x1f%s\\n' "$PATH"; ` +
    `printf 'CLAUDE\\x1f%s\\n' "$(command -v claude 2>/dev/null)"; ` +
    `printf 'CODEX\\x1f%s\\n' "$(command -v codex 2>/dev/null)"`;

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-l", "-c", script], {
      env: {
        ...process.env,
        // 防止 PROMPT_COMMAND / PS1 等钩子往 stdout 喷东西干扰解析
        PS1: "",
        PROMPT_COMMAND: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finalize = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
      finalize(() => reject(new Error(`login shell probe timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      finalize(() => reject(err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finalize(() => {
        if (!stdout && code !== 0) {
          reject(new Error(`login shell exited ${code}: ${stderr.trim().slice(0, 200)}`));
          return;
        }
        const out: ProbeResult = { path: "", claude: null, codex: null };
        for (const line of stdout.split("\n")) {
          const idx = line.indexOf("\x1f");
          if (idx < 0) continue;
          const key = line.slice(0, idx);
          const val = line.slice(idx + 1).trim();
          if (!val) continue;
          if (key === "PATH") out.path = val;
          else if (key === "CLAUDE") out.claude = val;
          else if (key === "CODEX") out.codex = val;
        }
        resolve(out);
      });
    });
  });
}

/** 用系统 `which` / `where` 查询关键命令。失败/没找到统一返回 null。 */
function probeCommands(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of PROBE_COMMANDS) {
    out[name] = whichSync(name);
  }
  return out;
}

export function whichSync(cmd: string, options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): string | null {
  // Windows 用 `where`，POSIX 用 `which`。默认走 process.env.PATH（因此一定要在
  // repairRuntimePath() 追加完 PATH 之后再调）；options.env 可覆盖（如用 buildChildEnv 的 PATH）。
  const tool = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(tool, [cmd], { encoding: "utf8", env: options?.env, timeout: options?.timeoutMs });
    if (res.status !== 0) return null;
    const first = (res.stdout || "").split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 把修复结果格式化为一行可读摘要（startServer 启动日志用）。
 *
 * 例：
 *   `[wand] PATH augmented (+3 dirs); claude=/usr/local/bin/claude, codex=<missing>`
 *   `[wand] PATH already complete; claude=/Users/foo/.bun/bin/claude`
 */
export function formatPathRepairSummary(result: PathRepairResult): string {
  const parts: string[] = [];
  if (result.added.length > 0) {
    parts.push(`PATH augmented (+${result.added.length} dirs: ${result.added.join(", ")})`);
  } else {
    parts.push("PATH already complete");
  }
  const probes: string[] = [];
  for (const [name, resolved] of Object.entries(result.resolved)) {
    probes.push(`${name}=${resolved ?? "<missing>"}`);
  }
  if (probes.length > 0) parts.push(probes.join(", "));
  if (result.deepProbe === "failed" && result.warnings.length > 0) {
    parts.push(`deep-probe: ${result.warnings[0]}`);
  } else if (result.deepProbe === "success") {
    parts.push("deep-probe: ok");
  }
  return parts.join("; ");
}
