import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";

import { buildChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";
import { whichSync } from "./path-repair.js";
import { compareSemver, extractSemver } from "./version-utils.js";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 8_000;
const REGISTRY_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export type ProviderCliId = "claude" | "codex" | "opencode";

interface ProviderCliSpec {
  id: ProviderCliId;
  label: string;
  command: string;
  npmPackage: string;
  versionArgs: string[];
  updateArgs: string[];
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

function childEnv(options: ProviderCliUpdaterOptions): NodeJS.ProcessEnv {
  return options.env ?? buildChildEnv(options.inheritEnv !== false);
}

async function runCommand(
  command: string,
  args: string[],
  timeout: number,
  options: ProviderCliUpdaterOptions,
): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout,
    env: childEnv(options),
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
  if (normalized.includes("/.claude/") || normalized.includes("/.codex/") || normalized.includes("/.opencode/")) return "native";
  return "unknown";
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
  const env = childEnv(options);
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

async function readLatestVersion(spec: ProviderCliSpec, options: ProviderCliUpdaterOptions): Promise<{
  version: string | null;
  error?: string;
}> {
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

export async function checkProviderCliUpdates(
  options: ProviderCliUpdaterOptions = {},
): Promise<ProviderCliUpdateStatus[]> {
  return Promise.all(PROVIDER_CLI_SPECS.map(async (spec) => {
    const [installed, latest] = await Promise.all([
      readInstalledVersion(spec, options),
      readLatestVersion(spec, options),
    ]);
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
      installKind: resolveInstallKind(installed.executable, spec.id, installed.version),
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
