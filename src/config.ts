import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ExecutionMode, WandConfig } from "./types.js";

export const DEFAULT_CONFIG_DIR = ".wand";
export const DEFAULT_CONFIG_FILE = "config.json";

export const defaultConfig = (): WandConfig => ({
  host: "127.0.0.1",
  port: 3170,
  password: "change-me",
  defaultMode: "default",
  shell: process.env.SHELL || "/bin/bash",
  defaultCwd: process.cwd(),
  startupCommands: [],
  allowedCommandPrefixes: [],
  commandPresets: [
    {
      label: "Codex",
      command: "codex",
      mode: "default"
    },
    {
      label: "Claude",
      command: "claude",
      mode: "default"
    },
    {
      label: "Cursor Agent",
      command: "cursor-agent",
      mode: "default"
    }
  ]
});

export function resolveConfigPath(inputPath?: string): string {
  if (inputPath) {
    return path.resolve(process.cwd(), inputPath);
  }

  return path.resolve(process.cwd(), DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE);
}

export async function ensureConfig(configPath: string): Promise<WandConfig> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });

  try {
    const raw = await readFile(configPath, "utf8");
    const merged = mergeWithDefaults(JSON.parse(raw) as Partial<WandConfig>);
    await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return merged;
  } catch {
    const config = defaultConfig();
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return config;
  }
}

export async function loadConfig(configPath: string): Promise<WandConfig> {
  const raw = await readFile(configPath, "utf8");
  return mergeWithDefaults(JSON.parse(raw) as Partial<WandConfig>);
}

export async function saveConfig(configPath: string, config: WandConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function mergeWithDefaults(input: Partial<WandConfig>): WandConfig {
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...input,
    defaultCwd:
      typeof input.defaultCwd === "string" && input.defaultCwd.trim()
        ? input.defaultCwd
        : defaults.defaultCwd,
    startupCommands: Array.isArray(input.startupCommands) ? input.startupCommands : defaults.startupCommands,
    allowedCommandPrefixes: Array.isArray(input.allowedCommandPrefixes)
      ? input.allowedCommandPrefixes
      : defaults.allowedCommandPrefixes,
    commandPresets: Array.isArray(input.commandPresets)
      ? input.commandPresets
          .filter(
            (preset): preset is { label: string; command: string; mode?: WandConfig["defaultMode"] } =>
              typeof preset === "object" &&
              preset !== null &&
              typeof preset.label === "string" &&
              typeof preset.command === "string"
          )
          .map((preset) => ({
            label: normalizePresetLabel(preset.label, preset.command),
            command: normalizePresetCommand(preset.command),
            mode: isExecutionMode(preset.mode) ? preset.mode : undefined
          }))
      : defaults.commandPresets
  };
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "auto-edit" || value === "default" || value === "full-access";
}

function normalizePresetCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "cloud-code" || trimmed === "cloudcode" || trimmed === "claude code") {
    return "claude";
  }
  return trimmed;
}

function normalizePresetLabel(label: string, command: string): string {
  const normalizedCommand = normalizePresetCommand(command);
  if (normalizedCommand === "claude" && (label === "CloudCode" || label === "Claude Code")) {
    return "Claude";
  }
  return label;
}
