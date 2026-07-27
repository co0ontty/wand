export const DEFAULT_BASE_URL = "https://home.huniu.fun:8183";

export function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_BASE_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return DEFAULT_BASE_URL;
    parsed.hash = "";
    parsed.search = "";
    const pathname = parsed.pathname.replace(/\/+$/g, "");
    return parsed.origin + (pathname === "/" ? "" : pathname);
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function normalizeStoredUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.origin + normalizePathname(parsed.pathname);
  } catch {
    return null;
  }
}

export function urlsMatch(storedUrl, pageUrl) {
  try {
    const stored = new URL(normalizeStoredUrl(storedUrl) || storedUrl);
    const page = new URL(pageUrl);
    const storedHost = stored.hostname.toLowerCase();
    const pageHost = page.hostname.toLowerCase();
    if (pageHost !== storedHost && !pageHost.endsWith(`.${storedHost}`)) return false;
    const storedPath = normalizePathname(stored.pathname);
    return storedPath === "/" || normalizePathname(page.pathname).startsWith(storedPath);
  } catch {
    return false;
  }
}

export function pageTitleFallback(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "Login";
  }
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}
