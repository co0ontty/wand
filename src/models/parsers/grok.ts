import { ClaudeModelInfo } from "../../types.js";
import { cloneModels, GROK_FALLBACK_MODELS } from "../shared.js";

/**
 * Parse `grok models` human-readable output:
 *
 *   Default model: grok-4.5
 *   Available models:
 *     * grok-4.5 (default)
 */
export function parseGrokModels(stdout: string): ClaudeModelInfo[] {
  const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
  const lines = stdout.split(/\r?\n/).map((line) => stripAnsi(line).trim()).filter(Boolean);
  let defaultModel = "";
  const ids: string[] = [];
  for (const line of lines) {
    const defaultMatch = line.match(/^Default model:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\s*$/i);
    if (defaultMatch) {
      defaultModel = defaultMatch[1];
      continue;
    }
    const bulletMatch = line.match(/^[-*•]+\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\s*\(.*\))?\s*$/);
    if (bulletMatch) {
      ids.push(bulletMatch[1]);
      continue;
    }
    // Some builds may print plain model ids after the "Available models" header.
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(line) && !/^(available|default)\b/i.test(line)) {
      ids.push(line);
    }
  }
  const unique = Array.from(new Set(ids.filter((id) => id && id !== "default")));
  if (defaultModel && !unique.includes(defaultModel)) unique.unshift(defaultModel);
  if (!unique.length && !defaultModel) return cloneModels(GROK_FALLBACK_MODELS);
  const defaultLabel = defaultModel
    ? `${defaultModel}（Grok 默认）`
    : "跟随 Grok 默认";
  return [
    { id: "default", label: defaultLabel, alias: true },
    ...unique.map((id) => ({ id, label: id })),
  ];
}
