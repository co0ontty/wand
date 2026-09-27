import { useEffect, useState } from "react";
import type { ProviderId } from "../provider-identity";
import { fetchProviderUsage, type ProviderUsage } from "./provider-usage-repository";

/** Load on entry, rather than on selection: choices do not move under a user's pointer. */
export function useProviderUsage(enabled = true): ProviderUsage | null {
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }
    const abort = new AbortController();
    setUsage(null);
    void fetchProviderUsage(undefined, abort.signal)
      .then((counts) => { if (!abort.signal.aborted) setUsage(counts); })
      .catch(() => { if (!abort.signal.aborted) setUsage({}); });
    return () => abort.abort();
  }, [enabled]);
  return usage;
}

/** Descending call count; ties keep the caller's fixed order. Bare shell always comes last. */
export function sortProviderOptions<T>(
  options: readonly T[],
  usage: ProviderUsage,
  providerOf: (option: T) => string,
): T[] {
  const count = (provider: string): number =>
    provider === "shell" ? -1 : usage[provider as ProviderId] ?? 0;
  return options.map((option, index) => ({ option, index })).sort((a, b) =>
    count(providerOf(b.option)) - count(providerOf(a.option)) || a.index - b.index
  ).map(({ option }) => option);
}
