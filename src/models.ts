import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeModelInfo, SessionProvider } from "./types.js";

const execAsync = promisify(exec);

const CLAUDE_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "default（跟随 Claude Code 默认）", alias: true },
  { id: "opus", label: "opus（最新 Opus）", alias: true },
  { id: "sonnet", label: "sonnet（最新 Sonnet）", alias: true },
  { id: "haiku", label: "haiku（最新 Haiku）", alias: true },
  { id: "claude-opus-4-7", label: "Opus 4.7 · claude-opus-4-7" },
  { id: "claude-opus-4-6", label: "Opus 4.6 · claude-opus-4-6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · claude-sonnet-4-6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · claude-haiku-4-5-20251001" },
];

const CODEX_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "default（跟随 Codex 默认）", alias: true },
];

interface ModelCache {
  models: ClaudeModelInfo[];
  codexModels: ClaudeModelInfo[];
  claudeVersion: string | null;
  refreshedAt: string;
}

let cache: ModelCache | null = null;

function cloneClaudeModels(): ClaudeModelInfo[] {
  return CLAUDE_MODELS.map((m) => ({ ...m }));
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

interface CodexModelEntry {
  slug: string;
  display_name?: string;
  visibility?: string;
  priority?: number;
}

async function probeCodexModels(): Promise<ClaudeModelInfo[]> {
  try {
    const { stdout } = await execAsync("codex debug models", { timeout: 8000 });
    const data = JSON.parse(stdout) as { models: CodexModelEntry[] };
    const visible = data.models
      .filter((m) => m.visibility === "list")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    if (!visible.length) return CODEX_FALLBACK_MODELS.map((m) => ({ ...m }));
    const result: ClaudeModelInfo[] = [
      { id: "default", label: "default（跟随 Codex 默认）", alias: true },
    ];
    for (const m of visible) {
      result.push({
        id: m.slug,
        label: m.display_name && m.display_name !== m.slug
          ? `${m.display_name} · ${m.slug}`
          : m.slug,
      });
    }
    return result;
  } catch {
    return CODEX_FALLBACK_MODELS.map((m) => ({ ...m }));
  }
}

export function getCachedModels(): ModelCache {
  if (!cache) {
    cache = {
      models: cloneClaudeModels(),
      codexModels: CODEX_FALLBACK_MODELS.map((m) => ({ ...m })),
      claudeVersion: null,
      refreshedAt: new Date().toISOString(),
    };
  }
  return cache;
}

export async function refreshModels(): Promise<ModelCache> {
  const [version, codexModels] = await Promise.all([
    probeClaudeVersion(),
    probeCodexModels(),
  ]);
  cache = {
    models: cloneClaudeModels(),
    codexModels,
    claudeVersion: version,
    refreshedAt: new Date().toISOString(),
  };
  return cache;
}

export function getModelsForProvider(provider: SessionProvider): ClaudeModelInfo[] {
  const cached = getCachedModels();
  return provider === "codex" ? cached.codexModels : cached.models;
}

/** 返回可用于 claude CLI 的全部已知 model id（含别名） */
export function knownModelIds(): string[] {
  return CLAUDE_MODELS.map((m) => m.id);
}

/** 判断传入值是否是已知模型；允许自由文本，因此总是返回 true。保留接口以便将来严格校验。 */
export function isKnownModel(_value: string): boolean {
  return true;
}
