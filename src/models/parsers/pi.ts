import { ClaudeModelInfo } from "../../types.js";
import { isRecord, PI_MODEL_ID_PATTERN, cloneModels, PI_FALLBACK_MODELS } from "../shared.js";
import { effortLevelsFromIds, piThinkingLevelsForModel, unionModelEfforts } from "../thinking.js";

/** `pi --mode rpc` + `get_available_models`. One JSON response holds every model's thinking map. */
export function parsePiRpcModels(stdout: string): ClaudeModelInfo[] {
  let models: unknown[] | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let record: Record<string, unknown> | null = null;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      record = null;
    }
    if (!record || record.type !== "response" || record.command !== "get_available_models" || record.success !== true) {
      continue;
    }
    const data = isRecord(record.data) ? record.data : null;
    if (data && Array.isArray(data.models)) models = data.models;
  }
  if (!models) return [];
  const discovered: ClaudeModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const modelId = typeof entry.id === "string" ? entry.id.trim() : "";
    const id = provider && modelId ? `${provider}/${modelId}` : "";
    if (!id || !PI_MODEL_ID_PATTERN.test(id) || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
    const reasoningEfforts = effortLevelsFromIds(piThinkingLevelsForModel({
      reasoning: entry.reasoning === true,
      thinkingLevelMap: isRecord(entry.thinkingLevelMap) || entry.thinkingLevelMap === null
        ? entry.thinkingLevelMap as Record<string, unknown> | null
        : undefined,
    }));
    discovered.push({
      id,
      label: name === id ? id : `${name} · ${id}`,
      ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    });
  }
  if (!discovered.length) return [];
  const union = unionModelEfforts(discovered);
  return [
    {
      id: "default",
      label: "跟随 Pi 默认",
      alias: true,
      ...(union.length ? { reasoningEfforts: union } : {}),
    },
    ...discovered,
  ];
}
/**
 * Parse `pi --list-models`.
 *
 * Pi prints a padEnd-aligned table whose selectable `--model` value is
 * `provider/id` (for example `xai/grok-4.6`). The table only says thinking
 * yes/no, so per-model levels come from `parsePiRpcModels` instead.
 */
export function parsePiModels(stdout: string): ClaudeModelInfo[] {
  const discovered: ClaudeModelInfo[] = [];
  const seen = new Set(["default"]);
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
    if (!line || /^provider\s+model\b/i.test(line)) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)/);
    if (!match || !/^\d/.test(match[3])) continue;
    const id = `${match[1]}/${match[2]}`;
    if (!PI_MODEL_ID_PATTERN.test(id) || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    discovered.push({ id, label: id });
  }
  if (!discovered.length) return cloneModels(PI_FALLBACK_MODELS);
  return [
    { id: "default", label: "跟随 Pi 默认", alias: true },
    ...discovered,
  ];
}
