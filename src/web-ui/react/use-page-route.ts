import * as React from "react";
import { pageSearch, subscribePageRoute, updatePageRoute } from "../page-route";

export function usePageSearch(): string {
  return React.useSyncExternalStore(subscribePageRoute, pageSearch, () => "");
}

/**
 * URL is the owner, not a mirror of a local preference; Back never writes itself back.
 * Default values are left out of the URL, and `debounceMs` keeps typing local until it settles.
 */
export function usePageRouteState<T>(
  key: string, fallback: T, parse: (value: string) => T = value => value as T,
  serialize: (value: T) => string = String, mode: "push" | "replace" = "replace", debounceMs = 0,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Only this key's value is observed, so unrelated URL writes do not re-render the owner.
  const raw = React.useSyncExternalStore(subscribePageRoute, () => new URLSearchParams(pageSearch()).get(key), () => null);
  const config = React.useRef({ fallback, parse, serialize });
  config.current = { fallback, parse, serialize };
  const read = (value: string | null): T => {
    if (value === null) return config.current.fallback;
    try { return config.current.parse(value); } catch { return config.current.fallback; }
  };
  const routeValue = React.useMemo(() => read(raw), [key, raw]);
  const [draft, setDraft] = React.useState<{ value: T } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const queued = React.useRef<{ value: T } | null>(null);
  const commit = React.useCallback((value: T): void => {
    const text = config.current.serialize(value);
    const defaults = config.current.serialize(config.current.fallback);
    updatePageRoute({ [key]: text === defaults ? null : text }, mode);
  }, [key, mode]);
  const settle = React.useCallback((): void => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const item = queued.current;
    queued.current = null;
    if (item) commit(item.value);
    setDraft(null);
  }, [commit]);
  // A route change we did not make (Back, link) wins over an unsent local edit.
  React.useEffect(() => {
    if (!queued.current) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    queued.current = null;
    setDraft(null);
  }, [raw]);
  // Leaving the page drops an unsent edit: writing it later would put this page's parameter on the next page.
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); queued.current = null; }, []);
  const set = React.useCallback<React.Dispatch<React.SetStateAction<T>>>(next => {
    const base = queued.current ? queued.current.value : read(new URLSearchParams(pageSearch()).get(key));
    const resolved = typeof next === "function" ? (next as (value: T) => T)(base) : next;
    if (!debounceMs) { commit(resolved); return; }
    queued.current = { value: resolved };
    setDraft({ value: resolved });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(settle, debounceMs);
  }, [key, commit, settle, debounceMs]);
  return [draft ? draft.value : routeValue, set];
}

export const routeBoolean = (value: string): boolean => value === "true";
export const routeJson = JSON.stringify;
export function routeEnum<T extends string>(values: readonly T[], fallback: T): (value: string) => T {
  return value => values.includes(value as T) ? value as T : fallback;
}
