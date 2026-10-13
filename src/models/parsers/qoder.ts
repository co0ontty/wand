import { ClaudeModelInfo } from "../../types.js";
import { QODER_FALLBACK_MODELS, QODER_MODEL_ID_PATTERN, cloneModels } from "../shared.js";

/**
 * Parse `qodercli --list-models`.
 *
 * Qoder has used both provider-qualified custom IDs (`zhipu/glm5.2-cp`) and
 * plain tier/frontier IDs (`glm51`). The CLI's human-readable rows put the
 * selectable value in the final parentheses; some versions also emit a bare
 * safe ID below the `MODEL` header.
 */
export function parseQoderModels(stdout: string): ClaudeModelInfo[] {
  const discovered: ClaudeModelInfo[] = [];
  const seen = new Set(QODER_FALLBACK_MODELS.map((model) => model.id));
  let inModelList = false;
  const add = (id: string, label: string): void => {
    if (!QODER_MODEL_ID_PATTERN.test(id) || seen.has(id)) return;
    seen.add(id);
    discovered.push({ id, label: label || id });
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
    if (/^models?\s*:?$/i.test(line)) {
      inModelList = true;
      continue;
    }
    const match = line.match(/^(.+?)\s+\(([^()]+)\)\s*$/);
    if (match) {
      const displayName = match[1].trim();
      const id = match[2].trim();
      if (displayName) add(id, displayName);
      continue;
    }
    if (inModelList && QODER_MODEL_ID_PATTERN.test(line)) add(line, line);
  }
  return [...cloneModels(QODER_FALLBACK_MODELS), ...discovered];
}
