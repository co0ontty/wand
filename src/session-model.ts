import { getDefaultModelForProvider } from "./config.js";
import { defaultModelGroupSelector } from "./model-groups.js";
import type { SessionProvider, WandConfig } from "./types.js";

/** The repeated `group selector || provider default` tail. Callers keep their own explicit-model precedence. */
export function fallbackProviderModel(config: WandConfig, provider: SessionProvider): string | undefined {
  return defaultModelGroupSelector(config.modelGroups, provider, getDefaultModelForProvider(config, provider))
    || getDefaultModelForProvider(config, provider)
    || undefined;
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
