import { PROVIDER_IDS, type ProviderId } from "../provider-identity";

export type ProviderUsage = Partial<Record<ProviderId, number>>;

/** One retained interactive CLI session counts as one launch. */
export async function fetchProviderUsage(
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchImpl("/api/sessions/provider-usage", {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`Unable to load tool usage (HTTP ${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const counts: ProviderUsage = {};
  for (const provider of PROVIDER_IDS) {
    const count = (body as Record<string, unknown>)[provider];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
      counts[provider] = count;
    }
  }
  return counts;
}
