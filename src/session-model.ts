import { getDefaultModelForProvider, PROVIDER_MODEL_PREFERENCE_FIELDS, type ProviderModelField } from "./config.js";
import { defaultModelGroupSelector } from "./model-groups.js";
import type { SessionProvider, WandConfig } from "./types.js";
import { SESSION_PROVIDERS } from "./session-provider.js";
import type { WandStorage } from "./storage.js";

/** Read raw live preferences without the configured-model trim/default projection. */
export function readProviderModelPreferences(
  config: Pick<WandConfig, ProviderModelField>,
  storage: Pick<WandStorage, "getPreference">,
): Record<SessionProvider, string> {
  const models = {} as Record<SessionProvider, string>;
  for (const provider of SESSION_PROVIDERS) {
    const field = PROVIDER_MODEL_PREFERENCE_FIELDS[provider];
    models[provider] = storage.getPreference(`pref:${field}`, config[field] ?? "");
  }
  return models;
}

/** The repeated `group selector || provider default` tail. Callers keep their own explicit-model precedence. */
export function fallbackProviderModel(config: WandConfig, provider: SessionProvider): string | undefined {
  const defaultModel = getDefaultModelForProvider(config, provider);
  return defaultModelGroupSelector(config.modelGroups, provider, defaultModel) || defaultModel || undefined;
}

/** Employee and conversation creates treat blank and `default` as the configured fallback. */
export function resolveExplicitOrFallbackModel(
  config: WandConfig,
  provider: SessionProvider,
  explicit: string | null | undefined,
): string | undefined {
  const model = explicit?.trim() ?? "";
  if (model && model !== "default") return model;
  return fallbackProviderModel(config, provider);
}

/** Identity stamped onto a new session. Execution stays with the caller's own start/createSession. */
export function sessionEmployeeFields(role: { id?: string; name?: string; avatar?: string } | null | undefined): {
  employeeId?: string;
  employeeName?: string;
  employeeAvatar?: string;
} {
  return {
    employeeId: role?.id,
    employeeName: role?.name,
    employeeAvatar: role?.avatar,
  };
}
