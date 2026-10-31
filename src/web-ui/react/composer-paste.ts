/**
 * Files carried by one clipboard paste.
 *
 * Chrome fills `clipboardData.files` for screenshots and copied images, but
 * Safari and several macOS apps expose the file only through
 * `clipboardData.items` (and `files` can stay empty even though an image is on
 * the clipboard). Use item files when available, otherwise the FileList.
 * Browsers may expose distinct File objects for the same clipboard payload.
 */
function normalizeClipboardFile(file: File, index: number): File {
  const isImage = file.type.toLowerCase().startsWith("image/");
  const hasExt = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name);
  if (!isImage || (file.name && file.name !== "blob" && hasExt)) return file;
  const ext = file.type === "image/jpeg" ? ".jpg" : file.type === "image/webp" ? ".webp" : file.type === "image/gif" ? ".gif" : ".png";
  const base = file.name && file.name !== "blob" ? file.name : `image-${Date.now()}-${index + 1}`;
  return new File([file], hasExt ? base : `${base}${ext}`, { type: file.type, lastModified: file.lastModified });
}

export function clipboardFiles(clipboard: DataTransfer | null | undefined): File[] {
  if (!clipboard) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && !files.includes(file)) files.push(normalizeClipboardFile(file, files.length));
  }
  if (files.length) return files;
  return Array.from(clipboard.files ?? []).map((file, index) => normalizeClipboardFile(file, index));
}

/**
 * Composer paste handler. Only a paste that actually carries files is consumed;
 * text pastes keep the browser's native insert so drafts, IME and the PTY text
 * path stay owned by their existing handlers.
 */
export function pasteFilesInto(addFiles: (files: File[]) => void): (event: { clipboardData: DataTransfer | null; preventDefault(): void }) => void {
  return event => {
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  };
}
