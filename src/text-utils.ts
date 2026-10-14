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

/** Single-line summaries retain the existing UTF-16 budget and ellipsis rules. */
export function collapseWhitespaceAndClip(value: string, maxLength: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length > maxLength) {
    let end = Math.max(1, maxLength - 1);
    const previous = flat.charCodeAt(end - 1);
    const next = flat.charCodeAt(end);
    // Shorten the prefix rather than emitting half of an otherwise valid surrogate pair.
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    return `${flat.slice(0, end)}…`;
  }
  return flat;
}
