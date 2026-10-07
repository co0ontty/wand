/** The HTML entry declares its page before browser modules execute. */
export function isStandaloneSettingsPage(): boolean {
  return typeof document !== "undefined" && document.documentElement?.dataset.wandPage === "settings";
}

/** Presentation only; the server still validates the live client session and WebView proof. */
export function isClientSettingsPage(): boolean {
  return isStandaloneSettingsPage() && document.documentElement.dataset.wandSettingsAuth === "client";
}
