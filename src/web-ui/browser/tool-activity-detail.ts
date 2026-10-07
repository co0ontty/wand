/** Presentation only: never infer a file path from an activity label, preview or opaque fileKey. */
export function activityFilePath(input: Record<string, unknown>, cwd?: string): string | null {
  const raw = ["move_path", "file_path", "path", "filename", "file", "notebook_path"]
    .map(key => input?.[key]).find(value => typeof value === "string" && value.trim()) as string | undefined;
  if (!raw) return null;
  const path = raw.trim();
  if (path.startsWith("~") || path.includes("\0")) return null;
  if (!path.startsWith("/") && !cwd?.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}

export function activityDetailText(value: unknown, limit = 24_000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) || "";
  return text.length > limit ? text.slice(0, limit) + `\n…（仅展示前 ${limit} 字）` : text;
}

export function activityOpensFile(block: { activity?: { kind?: string } }): boolean {
  return block.activity?.kind === "read_file" || block.activity?.kind === "edit_file";
}
