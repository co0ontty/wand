import { ClaudeModelInfo } from "../../types.js";
import { variantsToEfforts } from "../thinking.js";
import { cloneModels, isRecord, OPENCODE_FALLBACK_MODELS } from "../shared.js";

/**
 * `opencode models --verbose` 是「一行 id + 一段 JSON」。
 * variants 是这个模型自己的推理档位；没有 JSON 时退回一行一个 id。
 */
export function parseOpenCodeModelCatalog(stdout: string): ClaudeModelInfo[] {
  const verbose = parseOpenCodeVerboseModels(stdout);
  if (verbose.length) return verbose;
  if (stdout.trimStart().startsWith("{")) return [{ id: "default", label: "跟随 OpenCode 默认", alias: true }];
  return parseOpenCodeModels(stdout);
}
/** Shared native catalog records; callers enforcing prices must never fall back to bare IDs. */
export function parseOpenCodeModelRecords(stdout: string): Array<{ id: string; record: Record<string, unknown> }> {
  if (stdout.trimStart().startsWith("{")) {
    const response: unknown = JSON.parse(stdout);
    if (!isRecord(response) || !Array.isArray(response.data)) throw new Error("OpenCode 模型目录响应无效。");
    return response.data.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.providerID !== "string" || typeof entry.id !== "string"
        || entry.enabled === false) return [];
      const id = `${entry.providerID}/${entry.id}`;
      if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(id)) return [];
      // Project only model metadata; settings can contain credentials and never leave discovery.
      const settings = isRecord(entry.settings) ? entry.settings : {};
      const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
      const sdk = entry.package === "@opencode/ai/providers/openai-compatible" ? "@ai-sdk/openai-compatible"
        : entry.package === "@opencode/ai/providers/openai" ? "@ai-sdk/openai" : undefined;
      return [{ id, record: {
        providerID: entry.providerID, status: entry.status, cost: entry.cost,
        api: { id: entry.modelID, url: settings.baseURL, npm: sdk },
        capabilities: {
          input: { text: Array.isArray(capabilities.input) && capabilities.input.includes("text") },
          output: { text: Array.isArray(capabilities.output) && capabilities.output.includes("text") },
          toolcall: capabilities.tools === true,
        },
        variants: Array.isArray(entry.variants) ? entry.variants.flatMap((variant) =>
          isRecord(variant) && typeof variant.id === "string" ? [variant.id] : []) : [],
      } }];
    });
  }
  const lines = stdout.split(/\r?\n/);
  const found: Array<{ id: string; record: Record<string, unknown> }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(header)) continue;
    if ((lines[index + 1] ?? "").trim() !== "{") continue;
    let depth = 0, quoted = false, escaped = false;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      for (const character of lines[end] ?? "") {
        if (escaped) { escaped = false; continue; }
        if (quoted && character === "\\") { escaped = true; continue; }
        if (character === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
      }
      if (depth === 0) break;
    }
    if (depth !== 0) continue;
    let record: Record<string, unknown> | null = null;
    try {
      record = JSON.parse(lines.slice(index + 1, end + 1).join("\n")) as Record<string, unknown>;
    } catch {
      record = null;
    }
    if (record && typeof record === "object" && !Array.isArray(record)) found.push({ id: header, record });
    index = end;
  }
  return found;
}

export function parseOpenCodeVerboseModels(stdout: string): ClaudeModelInfo[] {
  const found = parseOpenCodeModelRecords(stdout).map(({ id, record }) => {
    const reasoningEfforts = variantsToEfforts(record.variants);
    return { id, label: id, ...(reasoningEfforts.length ? { reasoningEfforts } : {}) };
  });
  if (!found.length) return [];
  return [{ id: "default", label: "跟随 OpenCode 默认", alias: true }, ...found];
}
/** Parse `opencode models`, whose stable machine-friendly output is one provider/model id per line. */
export function parseOpenCodeModels(stdout: string): ClaudeModelInfo[] {
  const ids = Array.from(new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").trim())
      .filter((line) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(line)),
  ));
  if (!ids.length) return cloneModels(OPENCODE_FALLBACK_MODELS);
  return [
    { id: "default", label: "跟随 OpenCode 默认", alias: true },
    ...ids.map((id) => ({ id, label: id })),
  ];
}
