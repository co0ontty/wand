import { normalizeWandTheme, THEME_STORAGE_KEY, type WandThemeId } from "./theme-palettes";

function readTheme(): WandThemeId {
  try { return normalizeWandTheme(window.localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return "warm"; }
}
let current = readTheme();
const listeners = new Set<() => void>();
function publish(next: WandThemeId): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}
export const wandThemeStore = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: (): WandThemeId => current,
  getServerSnapshot: (): WandThemeId => "warm",
};
/** Apply immediately; report denied storage honestly without losing the current-page choice. */
export function setWandTheme(next: WandThemeId): boolean {
  const value = normalizeWandTheme(next);
  let persisted = true;
  try { window.localStorage.setItem(THEME_STORAGE_KEY, value); }
  catch { persisted = false; }
  publish(value);
  return persisted;
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === THEME_STORAGE_KEY || event.key === null) publish(readTheme());
});
