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

/**
 * TUIs that splice the attachment placeholder into the draft without a trailing
 * separator, so the next chunk of text lands flush against it (`[Image #1]看这张图`).
 * Codex / OpenCode / Grok / Qoder insert their own space after the chip, and
 * prefixing one there would show up as a double space.
 */
export function providerGluesAfterAttachment(provider: string | null | undefined): boolean {
  const id = String(provider || "").trim().toLowerCase();
  return id === "claude" || id === "pi";
}

export interface PtyAttachmentChunk {
  data: string;
  shortcutKey?: string;
  /** 图片粘贴：CLI 要先把路径换成 [Image #N] 芯片，写入方需要给这一帧更长的重绘预算。 */
  image?: boolean;
}

/** Upload response / pending attachment shapes that can carry a file path. */
export interface PtyAttachmentSource {
  savedPath?: string;
  mimeType?: string;
  originalName?: string;
}

const ATTACHMENT_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

/** Image attachments are the ones the CLI turns into an `[Image #N]` chip. */
export function isImageAttachmentSource(source: PtyAttachmentSource | null | undefined): boolean {
  if (!source) return false;
  return isClipboardImageMimeType(source.mimeType)
    || ATTACHMENT_IMAGE_EXT.test(source.savedPath || source.originalName || "");
}

/**
 * Turn uploaded attachment paths into the exact PTY write sequence both composer
 * paths share: one terminal paste event per file, then a separator space when the
 * CLI will not add one itself.
 *
 * The path paste is tagged `shortcutKey: "paste"` so the server keeps it out of
 * the draft → session-topic inference; otherwise an uploaded path becomes the
 * session title. Codex only recognizes a pasted image path inside a real paste
 * event, and one boundary per file keeps multiple images as separate chips.
 *
 * The separator space must be its own chunk: a leading/trailing space inside the
 * paste payload gets trimmed by the CLI, and text glued to a chip stays glued.
 */
export function buildPtyAttachmentChunks(
  sources: ReadonlyArray<PtyAttachmentSource | null | undefined>,
  options: { bracketedPaste?: boolean; provider?: string | null } = {},
): PtyAttachmentChunk[] {
  const bracketed = options.bracketedPaste !== false;
  const separatorNeeded = providerGluesAfterAttachment(options.provider);
  const chunks: PtyAttachmentChunk[] = [];
  for (const source of sources || []) {
    const path = typeof source?.savedPath === "string" ? source.savedPath : "";
    if (!path) continue;
    const image = isImageAttachmentSource(source);
    chunks.push({
      data: buildTerminalPathPasteSequence(path, bracketed),
      shortcutKey: "paste",
      ...(image ? { image: true } : {}),
    });
    // Image chips already end with the CLI's own space on most providers; plain
    // paths (/path/note.txt) never get one and would glue onto the next keystroke.
    if (!image || separatorNeeded) {
      chunks.push({ data: " " });
    }
  }
  return chunks;
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
