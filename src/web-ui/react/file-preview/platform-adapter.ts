export async function copyTextToPlatformClipboard(text: string): Promise<void> {
  if (typeof WandNative !== "undefined" && typeof WandNative.copyToClipboard === "function") {
    if (WandNative.copyToClipboard(text) !== "ok") throw new Error("复制到系统剪贴板失败。");
    return;
  }
  if (!globalThis.navigator?.clipboard?.writeText) throw new Error("当前环境无法访问剪贴板。");
  await globalThis.navigator.clipboard.writeText(text);
}
