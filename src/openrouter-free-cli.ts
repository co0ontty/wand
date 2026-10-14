import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Api } from "@earendil-works/pi-ai";
import { openStorageReadonly, revokeOpenRouterFreeAccessAt } from "./storage/readonly.js";
import { OpenRouterFreeModelsService, OPENROUTER_FREE_SELECTOR,
  type FreeModelRequirements, type OpenRouterFreeStorage } from "./openrouter-free-models.js";
import type { WandStorage } from "./storage.js";
import type { PreparedPiResources } from "./pi-resource-run.js";
import type { StructuredRunnerContext } from "./structured-runner.js";

export interface OpenRouterFreeCliPolicy {
  databasePath: string;
  model: Model<Api>;
}
export interface OpenRouterFreeCliDependencies {
  storage: WandStorage;
  service: OpenRouterFreeModelsService;
}

/** Only an opaque, revocable capability goes into the child env; never the connector Key. */
export function prepareOpenRouterFreeCli(deps: OpenRouterFreeCliDependencies,
  context: StructuredRunnerContext): PreparedPiResources {
  const selector = context.session.selectedModel!;
  const effort = context.session.thinkingEffort?.split(":").at(-1);
  const requirements: FreeModelRequirements = { preferReasoning: !!effort && effort !== "off",
    ...(context.modelGroupModels ? { allowedSelectors: context.modelGroupModels } : {}) };
  const resolved = deps.service.resolve(selector, requirements) ?? deps.service.resolve(OPENROUTER_FREE_SELECTOR, requirements);
  if (!resolved) throw new Error("免费模型已下架或 OpenRouter Key 未配置，请同步免费分组并重新选择模型。");
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-pi-free-"));
  let token: string | undefined;
  const close = (): void => {
    if (token) {
      try { deps.storage.revokeOpenRouterFreeAccess(token); } catch { /* The durable CLI owns cleanup after a web restart. */ }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    token = deps.storage.issueOpenRouterFreeAccess(context.session.id, selector,
      createHash("sha256").update(resolved.apiKey).digest("hex"), requirements);
    const file = path.join(dir, "model.json");
    const policy: OpenRouterFreeCliPolicy = { databasePath: deps.storage.databasePath(), model: resolved.model };
    writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
    const js = fileURLToPath(new URL("./pi-openrouter-free-bridge.js", import.meta.url));
    return { args: ["--extension", existsSync(js) ? js : js.replace(/\.js$/, ".ts")],
      env: { ...context.env, WAND_PI_FREE_POLICY: file, WAND_PI_FREE_TOKEN: token }, close };
  } catch (error) { close(); throw error; }
}

/** Read-only projection: no migrations, no key creation, no shared catalog writes from a running Pi child. */
export function openOpenRouterFreeCliAccess(databasePath: string, token: string,
  fetchImpl: typeof fetch = globalThis.fetch) {
  if (!path.isAbsolute(databasePath) || !/^wf_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("免费模型调用授权无效。");
  }
  const handle = openStorageReadonly(databasePath);
  const hash = createHash("sha256").update(token).digest("hex");
  const scope = () => {
    const row = handle.openRouterFreeScope(hash, Date.now());
    if (!row) throw new Error("免费模型调用授权已失效，请重新发送。");
    return row;
  };
  try {
    const access = scope();
    const localCache = new Map<string, string>();
    const storage: OpenRouterFreeStorage = {
      getConnectorToken: () => {
        const current = scope();
        const key = handle.getConnectorToken("openrouter");
        if (!key || createHash("sha256").update(key).digest("hex") !== current.credential_hash) {
          throw new Error("OpenRouter Key 已变化，本次免费调用已停止，请重新发送。");
        }
        return key;
      },
      getConfigValue: (key) => localCache.get(key) ?? handle.getConfigValue(key),
      setConfigValue: (key, value) => { scope(); localCache.set(key, value); },
      getPreference: <T>(key: string, fallback: T): T => {
        try { return JSON.parse(handle.getConfigValue(key) ?? "null") as T ?? fallback; } catch { return fallback; }
      },
      saveConnector: () => { throw new Error("CLI 不可修改 OpenRouter Key。"); },
      deleteConnector: () => { throw new Error("CLI 不可删除 OpenRouter Key。"); },
    };
    const service = new OpenRouterFreeModelsService(storage, fetchImpl);
    return { selector: String(access.selector), requirements: JSON.parse(String(access.requirements_json)) as FreeModelRequirements,
      service, assertCurrent: () => { storage.getConnectorToken("openrouter"); },
      close: () => { service.dispose(); handle.close(); } };
  } catch (error) { handle.close(); throw error; }
}

/** The CLI, not its original Server owner, revokes scope on shutdown. */
export function revokeOpenRouterFreeCliAccess(databasePath: string, token: string): void {
  revokeOpenRouterFreeAccessAt(databasePath, createHash("sha256").update(token).digest("hex"));
}
