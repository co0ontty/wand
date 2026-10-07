/** Pi CLI provider bridge. No Agent/SDK runner and no changes to the user's Pi auth/models files. */
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createAssistantMessageEventStream, lazyApi, type Api, type Model,
  type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPENROUTER_FREE_PROVIDER, OPENROUTER_FREE_ROUTING } from "./openrouter-free-models.js";
import { openOpenRouterFreeCliAccess, revokeOpenRouterFreeCliAccess, type OpenRouterFreeCliPolicy } from "./openrouter-free-cli.js";

export default function wandOpenRouterFree(pi: ExtensionAPI): void {
  const file = process.env.WAND_PI_FREE_POLICY;
  const token = process.env.WAND_PI_FREE_TOKEN ?? "";
  delete process.env.WAND_PI_FREE_POLICY;
  delete process.env.WAND_PI_FREE_TOKEN;
  if (!file) throw new Error("免费模型调用缺少本轮策略。");
  const policy = JSON.parse(readFileSync(file, "utf8")) as OpenRouterFreeCliPolicy;
  // Pi applies its HTTP/proxy configuration after factories load; use the current fetch per request.
  const access = openOpenRouterFreeCliAccess(policy.databasePath, token, (url, init) => globalThis.fetch(url, init));
  const api = lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"));
  let activeModel = policy.model;
  const streamSimple = (model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      let key = "";
      try {
        const checked = await access.service.resolveForCall(`${OPENROUTER_FREE_PROVIDER}/${activeModel.id}`,
          options?.signal, access.requirements);
        activeModel = checked.model;
        key = checked.apiKey;
        const inner = api.streamSimple(activeModel, transcript, {
          ...options, apiKey: key,
          maxTokens: Math.min(options?.maxTokens ?? activeModel.maxTokens, activeModel.maxTokens),
          reasoning: activeModel.reasoning ? options?.reasoning : undefined,
          onPayload: async (payload, dispatchedModel) => {
            const customized = await options?.onPayload?.(payload, dispatchedModel) ?? payload;
            access.assertCurrent();
            return { ...(customized as Record<string, unknown>), model: activeModel.id, provider: OPENROUTER_FREE_ROUTING };
          },
        });
        for await (const event of inner) {
          if (event.type === "error" && event.error.errorMessage) {
            event.error.errorMessage = event.error.errorMessage.replaceAll(key, "[REDACTED]");
          }
          stream.push(event);
        }
      } catch (cause) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const message = cause instanceof Error ? cause.message : "免费模型调用失败。";
        stream.push({ type: "error", reason, error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: activeModel.id,
          timestamp: Date.now(), stopReason: reason, errorMessage: key ? message.replaceAll(key, "[REDACTED]") : message,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
      } finally { stream.end(); }
    })();
    return stream;
  };
  // Use a distinct API handler: never replace Pi's built-in openai-completions implementation.
  pi.registerProvider(OPENROUTER_FREE_PROVIDER, {
    name: "OpenRouter 免费分组", api: "wand-openrouter-free-completions", apiKey: "wand-scoped-free-inference",
    baseUrl: activeModel.baseUrl,
    models: [{ ...activeModel, api: "wand-openrouter-free-completions",
      id: access.selector.slice(OPENROUTER_FREE_PROVIDER.length + 1) }],
    streamSimple,
  });
  let closed = false;
  pi.on("session_shutdown", () => {
    if (closed) return;
    closed = true;
    access.close();
    try { revokeOpenRouterFreeCliAccess(policy.databasePath, token); } catch { /* Expiry and the parent are additional cleanup paths. */ }
    rmSync(dirname(file), { recursive: true, force: true });
  });
}
