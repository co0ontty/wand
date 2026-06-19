import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeModelInfo } from "./types.js";
import { extractSemver } from "./version-utils.js";

const execAsync = promisify(exec);

const CLAUDE_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "Sonnet 4.6 · claude-sonnet-4-6（Claude Code 默认）", alias: true },
  { id: "opus", label: "opus（最新 Opus）", alias: true },
  { id: "sonnet", label: "sonnet（最新 Sonnet）", alias: true },
  { id: "haiku", label: "haiku（最新 Haiku）", alias: true },
  { id: "claude-opus-4-7", label: "Opus 4.7 · claude-opus-4-7" },
  { id: "claude-opus-4-6", label: "Opus 4.6 · claude-opus-4-6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · claude-sonnet-4-6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · claude-haiku-4-5-20251001" },
];

const CODEX_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "GPT-5.5 · gpt-5.5（Codex 默认）", alias: true },
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
    return extractSemver(stdout) ?? (stdout.trim().slice(0, 64) || null);
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
    const defaultModel = visible[0];
    const defaultLabel = formatCodexModelLabel(defaultModel);
    const result: ClaudeModelInfo[] = [
      { id: "default", label: `${defaultLabel}（Codex 默认）`, alias: true },
    ];
    for (const m of visible) {
      result.push({
        id: m.slug,
        label: formatCodexModelLabel(m),
      });
    }
    return result;
  } catch {
    return CODEX_FALLBACK_MODELS.map((m) => ({ ...m }));
  }
}

function formatCodexModelLabel(model: CodexModelEntry): string {
  return model.display_name && model.display_name !== model.slug
    ? `${model.display_name} · ${model.slug}`
    : model.slug;
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
