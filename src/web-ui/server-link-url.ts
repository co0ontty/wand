/** Only the connected Wand origin may turn an absolute web URL into a server
 * file route. A lookalike route on another origin remains an ordinary web link. */
export function sameOriginServerLink(input: string, origin?: string): string | null {
  const base = origin ?? (typeof window === "undefined" ? undefined : window.location.origin);
  if (!base || !/^https?:\/\//i.test(input) || /[\u0000-\u001f]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.origin !== new URL(base).origin || url.username || url.password) return null;
    if (!/^\/api\/(?:file-raw|file-preview|session-file|local-file|local-preview)(?:[/?]|$)/.test(url.pathname)) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}
