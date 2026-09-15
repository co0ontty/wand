/**
 * 文本裁剪：超长时优先在空格处断句，避免标题被截成半句话。
 *
 * 只有当空格出现在靠后的位置（≥ 55%）才按单词断，否则直接硬截，
 * 防止「一个很长的英文单词 + 少量尾巴」的场景退化成只剩单词头。
 */
export function clipAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliced = value.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLength * 0.55)) return sliced.slice(0, lastSpace);
  return sliced;
}
