const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * Encode browser clipboard text as one terminal paste event.
 *
 * Writing the text directly to a PTY turns it into ordinary key events. Modern
 * TUIs such as Codex only run image-path attachment detection for a real paste
 * event, which terminals represent with bracketed-paste delimiters.
 */
export function buildTerminalPasteSequence(text: string, bracketed = true): string {
  if (!text) return "";
  const normalized = text.replace(/\r?\n/g, "\r");
  if (!bracketed) return normalized;
  const sanitized = normalized.replace(/\u001b/g, "\u241b");
  return `${BRACKETED_PASTE_START}${sanitized}${BRACKETED_PASTE_END}`;
}

/**
 * Quote a server-local path as one shell word before passing it through a paste
 * event. Codex uses shell-style path parsing, so this preserves cwd names that
 * contain whitespace or punctuation instead of treating them as plain text.
 */
export function quoteTerminalPath(path: string): string {
  if (!path) return "";
  if (/^[a-zA-Z0-9_./:@%+,=-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function buildTerminalPathPasteSequence(path: string, bracketed = true): string {
  return buildTerminalPasteSequence(quoteTerminalPath(path), bracketed);
}

export function isClipboardImageMimeType(type: string | null | undefined): boolean {
  return typeof type === "string" && type.toLowerCase().startsWith("image/");
}

export function clipboardImageExtension(type: string | null | undefined): string {
  switch (String(type || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/svg+xml":
      return ".svg";
    case "image/png":
    default:
      return ".png";
  }
}
