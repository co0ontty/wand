import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeModelInfo } from "./types.js";

const execAsync = promisify(exec);

const BUILT_IN_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "default（跟随 Claude Code 默认）", alias: true },
  { id: "opus", label: "opus（最新 Opus）", alias: true },
  { id: "sonnet", label: "sonnet（最新 Sonnet）", alias: true },
  { id: "haiku", label: "haiku（最新 Haiku）", alias: true },
  { id: "claude-opus-4-7", label: "Opus 4.7 · claude-opus-4-7" },
  { id: "claude-opus-4-6", label: "Opus 4.6 · claude-opus-4-6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · claude-sonnet-4-6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · claude-haiku-4-5-20251001" },
];

interface ModelCache {
  models: ClaudeModelInfo[];
  claudeVersion: string | null;
  refreshedAt: string;
}

let cache: ModelCache | null = null;

function cloneDefaults(): ClaudeModelInfo[] {
  return BUILT_IN_MODELS.map((m) => ({ ...m }));
}

async function probeClaudeVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("claude --version", { timeout: 5000 });
    const match = stdout.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/);
    return match ? match[0] : stdout.trim().slice(0, 64) || null;
  } catch {
    return null;
  }
}

export function getCachedModels(): ModelCache {
  if (!cache) {
    cache = {
      models: cloneDefaults(),
      claudeVersion: null,
      refreshedAt: new Date().toISOString(),
    };
  }
  return cache;
}

export async function refreshModels(): Promise<ModelCache> {
  const version = await probeClaudeVersion();
  cache = {
    models: cloneDefaults(),
    claudeVersion: version,
    refreshedAt: new Date().toISOString(),
  };
  return cache;
}

/** 返回可用于 claude CLI 的全部已知 model id（含别名） */
export function knownModelIds(): string[] {
  return BUILT_IN_MODELS.map((m) => m.id);
}

/** 判断传入值是否是已知模型；允许自由文本，因此总是返回 true。保留接口以便将来严格校验。 */
export function isKnownModel(_value: string): boolean {
  return true;
}
