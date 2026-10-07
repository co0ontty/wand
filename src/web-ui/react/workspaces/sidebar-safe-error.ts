/** Sidebar errors remain readable without echoing URLs, local paths or authentication material. */
export function sidebarSafeError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s，。；]+/gi, "[服务地址]")
    .replace(/(?:Bearer\s+\S+|(?:token|password|connectionCode|appToken)\s*[:=]\s*\S+)/gi, "[凭据已隐藏]")
    .replace(/(?:\/[\w.~-]+){2,}/g, "[路径]");
}
