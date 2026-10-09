import { agentToolDisplayName, normalizeProviderId, renderProviderLogoMarkup, type AgentToolEngine, type ProviderId } from "../../provider-identity.js";

/** 会话的实际 CLI 优先；只有没有会话时才显示员工的首选候选。 */
export function employeeAvatarProvider(
  employee: { agents?: ReadonlyArray<{ provider?: string }> },
  provider?: string,
): ProviderId | null {
  return normalizeProviderId(provider === undefined ? employee.agents?.[0]?.provider : provider);
}

export function employeeCliLabel(provider: ProviderId, engine?: AgentToolEngine | "core"): string {
  const label = agentToolDisplayName(provider, engine);
  return provider === "pi" && (engine === "sdk" || engine === "core") ? label : `${label} CLI`;
}

/** 与 React 员工头像共用样式，供普通聊天的 vanilla renderer 使用。 */
export function renderEmployeeCliBadge(provider: unknown): string {
  const cli = normalizeProviderId(provider);
  if (!cli) return "";
  const label = employeeCliLabel(cli);
  return `<span class="wand-employee-avatar-provider" role="img" aria-label="${label}" title="${label}">${renderProviderLogoMarkup(cli)}</span>`;
}
