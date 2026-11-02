/** UUID syntax identifies a reference, while the authenticated server resolves its actual owner. */
export const WAND_REFERENCE_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
export function referenceHref(id: string): string { return `/api/reference/${encodeURIComponent(id)}`; }
export function referenceHtml(escapedText: string): string {
  return escapedText.replace(WAND_REFERENCE_PATTERN, id => `<a href="${referenceHref(id)}" title="定位此 Wand 记录">${id}</a>`);
}
