import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";

import { resolveChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";
import { whichSync } from "./path-repair.js";
import { compareSemver, extractSemver } from "./version-utils.js";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 8_000;
const REGISTRY_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export type ProviderCliId = "claude" | "codex" | "opencode" | "grok" | "qoder" | "pi";

interface ProviderCliSpec {
  id: ProviderCliId;
  label: string;
  command: string;
  /** 有 npm 发布渠道时用它查最新版；Grok 只提供自更新，见 `cliLatestArgs`。 */
  npmPackage?: string;
  versionArgs: string[];
  updateArgs: string[];
  /** 没有 npm 渠道的 CLI 用自身 --check 读取最新版（如 `grok update --check --json`）。 */
  cliLatestArgs?: string[];
}

const PROVIDER_CLI_SPECS: readonly ProviderCliSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    versionArgs: ["--version"],
    updateArgs: ["update"],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    npmPackage: "@openai/codex",
    versionArgs: ["--version"],
    updateArgs: ["update"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    npmPackage: "opencode-ai",
    versionArgs: ["--version"],
    updateArgs: ["upgrade"],
  },
  {
    id: "grok",
    label: "Grok CLI",
    command: "grok",
    // Grok CLI 没有 npm 发布渠道，最新版只能问它自己。
    versionArgs: ["--version"],
    updateArgs: ["update"],
    cliLatestArgs: ["update", "--check", "--json"],
  },
  {
    id: "qoder",
    label: "Qoder CLI",
    command: "qodercli",
    npmPackage: "@qoder-ai/qodercli",
    versionArgs: ["--version"],
    updateArgs: ["update"],
  },
  {
    id: "pi",
    label: "Pi CLI",
    command: "pi",
    // pi 已从 @mariozechner/pi-coding-agent 改名到 @earendil-works/pi-coding-agent，
    // 继续查旧包会拿到低于本机安装版本的“最新版”，把更新判断彻底带偏。
    npmPackage: "@earendil-works/pi-coding-agent",
    versionArgs: ["--version"],
    updateArgs: ["update", "self"],
  },
] as const;

export interface ProviderCliUpdateStatus {
  id: ProviderCliId;
  label: string;
  command: string;
  executable: string | null;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateSupported: boolean;
  installKind: "native" | "npm" | "brew" | "legacy" | "unknown";
  error?: string;
}

export interface ProviderCliUpdateResult {
  id: ProviderCliId;
  label: string;
  ok: boolean;
  skipped: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  message: string;
  output?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface ProviderCliUpdaterOptions {
  inheritEnv?: boolean;
  versionTimeoutMs?: number;
  registryTimeoutMs?: number;
  updateTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
}

async function runCommand(
  command: string,
  args: string[],
  timeout: number,
  options: ProviderCliUpdaterOptions,
): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout,
    env: resolveChildEnv(options),
    maxBuffer: MAX_BUFFER,
  });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

export function parseProviderCliVersion(output: string): string | null {
  return extractSemver(output);
}

function resolveInstallKind(executable: string | null, id: ProviderCliId, version: string | null): ProviderCliUpdateStatus["installKind"] {
  if (!executable) return "unknown";
  let resolved = executable;
  try { resolved = realpathSync(executable); } catch { /* keep original */ }
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  if (id === "opencode" && version && /^0\.0\./.test(version)) return "legacy";
  if (normalized.includes("/node_modules/") || normalized.includes("/npm/")) return "npm";
  if (normalized.includes("/cellar/") || normalized.includes("/caskroom/") || normalized.includes("/homebrew/")) return "brew";
  if (normalized.includes("/.claude/") || normalized.includes("/.codex/") || normalized.includes("/.opencode/") || normalized.includes("/.grok/") || normalized.includes("/.qoder/") || normalized.includes("/.qoder-cn/")) return "native";
  return "unknown";
}

/**
 * Homebrew 托管的 CLI 官方更新器会拒绍动手（实测 `claude update` 只打印
 * "managed by Homebrew" 并不改版本），所以直接给出正确的 brew 命令。
 */
export function homebrewUpdateHint(executable: string | null): string | null {
  const install = parseHomebrewInstall(executable);
  return install ? `brew upgrade ${install.name}` : null;
}

/** 从 `/opt/homebrew/Caskroom/<cask>/…` / `/Cellar/<formula>/…` 反解 Homebrew 包名。 */
export function parseHomebrewInstall(executable: string | null): { kind: "cask" | "formula"; name: string } | null {
  if (!executable) return null;
  let resolved = executable;
  try { resolved = realpathSync(executable); } catch { /* keep original */ }
  const matched = /\/(Caskroom|Cellar)\/([^/]+)\//i.exec(resolved.replace(/\\/g, "/"));
  if (!matched) return null;
  return { kind: matched[1].toLowerCase() === "caskroom" ? "cask" : "formula", name: matched[2] };
}

function isUpdateSupported(id: ProviderCliId, version: string | null): boolean {
  return !(id === "opencode" && version !== null && /^0\.0\./.test(version));
}

export function providerCliUpdateAvailable(currentVersion: string | null, latestVersion: string | null): boolean {
  if (!currentVersion || !latestVersion) return false;
  return compareSemver(latestVersion, currentVersion) > 0;
}

async function readInstalledVersion(spec: ProviderCliSpec, options: ProviderCliUpdaterOptions): Promise<{
  executable: string | null;
  version: string | null;
  error?: string;
}> {
  const env = resolveChildEnv(options);
  const executable = whichSync(spec.command, { env, timeoutMs: options.versionTimeoutMs ?? VERSION_TIMEOUT_MS });
  if (!executable) return { executable: null, version: null };
  try {
    const result = await runCommand(executable, spec.versionArgs, options.versionTimeoutMs ?? VERSION_TIMEOUT_MS, options);
    const version = parseProviderCliVersion(`${result.stdout}\n${result.stderr}`);
    return version
      ? { executable, version }
      : { executable, version: null, error: "无法解析已安装版本。" };
  } catch (error) {
    return { executable, version: null, error: getErrorMessage(error, "读取版本失败。") };
  }
}

async function readLatestVersion(spec: ProviderCliSpec, options: ProviderCliUpdaterOptions, status?: {
  executable: string | null;
  installKind: ProviderCliUpdateStatus["installKind"];
}): Promise<{
  version: string | null;
  error?: string;
}> {
  if (spec.cliLatestArgs) return readLatestVersionFromCli(spec, options);
  // Homebrew 安装跟 npm 的 latest 不是同一个发布渠道（cask 通常落后一两个版本），
  // 拿 npm 比会永久显示“有更新”。
  if (status?.installKind === "brew") {
    const install = parseHomebrewInstall(status.executable);
    if (install) return readBrewLatestVersion(install, options);
  }
  if (!spec.npmPackage) return { version: null, error: "该 CLI 没有配置版本来源。" };
  const npm = options.env?.WAND_NPM_BIN || process.env.WAND_NPM_BIN || (process.platform === "win32" ? "npm.cmd" : "npm");
  try {
    const result = await runCommand(
      npm,
      ["view", `${spec.npmPackage}@latest`, "version"],
      options.registryTimeoutMs ?? REGISTRY_TIMEOUT_MS,
      options,
    );
    const version = parseProviderCliVersion(result.stdout);
    return version ? { version } : { version: null, error: "npm registry 未返回版本。" };
  } catch (error) {
    return { version: null, error: getErrorMessage(error, "无法连接 npm registry。") };
  }
}

/** `brew info --json=v2` 的 cask/formula 最新版。 */
async function readBrewLatestVersion(
  install: { kind: "cask" | "formula"; name: string },
  options: ProviderCliUpdaterOptions,
): Promise<{ version: string | null; error?: string }> {
  const env = resolveChildEnv(options);
  const brew = whichSync("brew", { env, timeoutMs: options.versionTimeoutMs ?? VERSION_TIMEOUT_MS });
  if (!brew) return { version: null, error: "未找到 brew 命令，无法检查 Homebrew 最新版。" };
  try {
    const result = await runCommand(
      brew,
      ["info", "--json=v2", install.kind === "cask" ? "--cask" : "--formula", install.name],
      options.registryTimeoutMs ?? REGISTRY_TIMEOUT_MS,
      options,
    );
    const version = parseBrewInfoVersion(result.stdout, install.kind);
    return version ? { version } : { version: null, error: "brew info 未返回版本。" };
  } catch (error) {
    return { version: null, error: getErrorMessage(error, "无法运行 brew info。") };
  }
}

/** 从 `brew info --json=v2` 输出里取 cask version / formula stable 版本。 */
export function parseBrewInfoVersion(output: string, kind: "cask" | "formula"): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const list = kind === "cask" ? root.casks : root.formulae;
  const entry = Array.isArray(list) && list.length && list[0] && typeof list[0] === "object"
    ? list[0] as Record<string, unknown>
    : null;
  if (!entry) return null;
  if (kind === "cask") return typeof entry.version === "string" ? extractSemver(entry.version) : null;
  const versions = entry.versions && typeof entry.versions === "object" ? entry.versions as Record<string, unknown> : {};
  return typeof versions.stable === "string" ? extractSemver(versions.stable) : null;
}

/** `grok update --check --json` 的 JSON 行里取 `latestVersion`；日志混排也能挑出来。 */
export function parseCliLatestVersionJson(output: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const latest = parsed && typeof parsed === "object"
      ? (parsed as { latestVersion?: unknown }).latestVersion
      : null;
    const version = typeof latest === "string" ? extractSemver(latest) : null;
    if (version) return version;
  }
  return null;
}

async function readLatestVersionFromCli(spec: ProviderCliSpec, options: ProviderCliUpdaterOptions): Promise<{
  version: string | null;
  error?: string;
}> {
  const env = resolveChildEnv(options);
  const executable = whichSync(spec.command, { env, timeoutMs: options.versionTimeoutMs ?? VERSION_TIMEOUT_MS });
  // 没装就没有“最新版”可比，交给上面按未安装展示。
  if (!executable) return { version: null };
  try {
    const result = await runCommand(
      executable,
      spec.cliLatestArgs as string[],
      options.registryTimeoutMs ?? REGISTRY_TIMEOUT_MS,
      options,
    );
    const version = parseCliLatestVersionJson(`${result.stdout}\n${result.stderr}`);
    return version ? { version } : { version: null, error: "CLI 未返回可解析的最新版本。" };
  } catch (error) {
    return { version: null, error: getErrorMessage(error, "无法检查 CLI 最新版本。") };
  }
}

export async function checkProviderCliUpdates(
  options: ProviderCliUpdaterOptions = {},
): Promise<ProviderCliUpdateStatus[]> {
  return Promise.all(PROVIDER_CLI_SPECS.map(async (spec) => {
    // 串行：查最新版要先用 installKind 判断是不是 Homebrew 安装（其它 5 个 CLI 仍并发）。
    const installed = await readInstalledVersion(spec, options);
    const installKind = resolveInstallKind(installed.executable, spec.id, installed.version);
    const latest = await readLatestVersion(spec, options, { executable: installed.executable, installKind });
    const updateSupported = isUpdateSupported(spec.id, installed.version);
    const errors = [installed.error, latest.error].filter(Boolean);
    if (!updateSupported) {
      errors.push("检测到已归档的 OpenCode 0.0.x；请先卸载旧包并安装 opencode-ai@latest。");
    }
    return {
      id: spec.id,
      label: spec.label,
      command: spec.command,
      executable: installed.executable,
      installed: installed.executable !== null,
      currentVersion: installed.version,
      latestVersion: latest.version,
      updateAvailable: providerCliUpdateAvailable(installed.version, latest.version),
      updateSupported,
      installKind,
      ...(errors.length ? { error: errors.join("；") } : {}),
    };
  }));
}

function trimOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 4_096 ? `...${trimmed.slice(-4_096)}` : trimmed;
}

export async function updateProviderClis(
  statuses: ProviderCliUpdateStatus[],
  ids?: ProviderCliId[],
  options: ProviderCliUpdaterOptions = {},
): Promise<ProviderCliUpdateResult[]> {
  const selected = new Set(ids?.length ? ids : statuses.filter((item) => item.updateAvailable).map((item) => item.id));
  const results: ProviderCliUpdateResult[] = [];
  for (const spec of PROVIDER_CLI_SPECS) {
    if (!selected.has(spec.id)) continue;
    const status = statuses.find((item) => item.id === spec.id);
    if (!status?.installed) {
      results.push({
        id: spec.id,
        label: spec.label,
        ok: false,
        skipped: true,
        fromVersion: status?.currentVersion ?? null,
        toVersion: status?.latestVersion ?? null,
        message: `${spec.label} 未安装。`,
      });
      continue;
    }
    if (!status.updateAvailable) {
      results.push({
        id: spec.id,
        label: spec.label,
        ok: true,
        skipped: true,
        fromVersion: status.currentVersion,
        toVersion: status.latestVersion,
        message: `${spec.label} 已是最新版。`,
      });
      continue;
    }
    if (!status.updateSupported) {
      results.push({
        id: spec.id,
        label: spec.label,
        ok: false,
        skipped: true,
        fromVersion: status.currentVersion,
        toVersion: status.latestVersion,
        message: status.error ?? `${spec.label} 当前安装方式不支持自动更新。`,
      });
      continue;
    }

    const executable = status.executable as string;
    // Homebrew 托管的安装不能靠 CLI 自更新（它会直接拒绍），别浪费一次必然失败的子进程。
    if (status.installKind === "brew") {
      const hint = homebrewUpdateHint(executable);
      results.push({
        id: spec.id,
        label: spec.label,
        ok: false,
        skipped: true,
        fromVersion: status.currentVersion,
        toVersion: status.latestVersion,
        message: hint
          ? `${spec.label} 由 Homebrew 安装，请运行 \`${hint}\` 更新。`
          : `${spec.label} 由 Homebrew 安装，请用 \`brew upgrade\` 更新。`,
      });
      continue;
    }
    options.onLog?.(`[CLI Update] ${spec.label}: ${status.currentVersion} -> ${status.latestVersion}`);
    try {
      const output = await runCommand(executable, spec.updateArgs, options.updateTimeoutMs ?? UPDATE_TIMEOUT_MS, options);
      const combined = trimOutput([output.stdout, output.stderr].filter(Boolean).join("\n"));
      results.push({
        id: spec.id,
        label: spec.label,
        ok: true,
        skipped: false,
        fromVersion: status.currentVersion,
        toVersion: status.latestVersion,
        message: `${spec.label} 更新命令执行完成。`,
        ...(combined ? { output: combined } : {}),
      });
    } catch (error) {
      results.push({
        id: spec.id,
        label: spec.label,
        ok: false,
        skipped: false,
        fromVersion: status.currentVersion,
        toVersion: status.latestVersion,
        message: getErrorMessage(error, `${spec.label} 更新失败。`),
      });
    }
  }
  return results;
}

/** Re-check the active PATH after updating so duplicate installs cannot masquerade as success. */
export function verifyProviderCliUpdateResults(
  results: ProviderCliUpdateResult[],
  statuses: ProviderCliUpdateStatus[],
): ProviderCliUpdateResult[] {
  return results.map((result) => {
    if (!result.ok || result.skipped) return result;
    const active = statuses.find((item) => item.id === result.id);
    if (!active || !active.updateAvailable) return result;
    return {
      ...result,
      ok: false,
      message: `${result.label} updater 已执行，但当前 PATH 仍指向 ${active.currentVersion ?? "旧版本"}；请检查是否存在多份安装。`,
    };
  });
}
