import type {
  FolderPickerItem,
  FolderPickerListing,
  FolderPickerRepository,
  FolderPickerRepositoryOptions,
} from "./types";

export type FolderPickerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function messageFromPayload(payload: unknown, fallback: string): string {
  if (
    payload
    && typeof payload === "object"
    && "error" in payload
    && typeof payload.error === "string"
    && payload.error.trim()
  ) {
    return payload.error;
  }
  return fallback;
}

function normalizeListing(payload: unknown, requestedPath: string): FolderPickerListing {
  if (!payload || typeof payload !== "object") {
    throw new Error("目录服务返回了无效数据。");
  }
  const record = payload as Record<string, unknown>;
  const currentPath = typeof record.currentPath === "string" && record.currentPath.trim()
    ? record.currentPath
    : requestedPath;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items: FolderPickerItem[] = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (
      typeof item.path !== "string"
      || !item.path.trim()
      || typeof item.name !== "string"
      || (item.type !== "parent" && item.type !== "dir")
    ) continue;
    items.push({ path: item.path, name: item.name, type: item.type });
  }
  return { currentPath, items };
}

export class HttpFolderPickerRepository implements FolderPickerRepository {
  constructor(
    private readonly fetchImpl: FolderPickerFetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async list(
    path: string,
    options: FolderPickerRepositoryOptions = {},
  ): Promise<FolderPickerListing> {
    const requestedPath = path.trim();
    if (!requestedPath) throw new Error("请输入工作目录。");
    const response = await this.fetchImpl(`/api/folders?q=${encodeURIComponent(requestedPath)}`, {
      credentials: "same-origin",
      signal: options.signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(messageFromPayload(payload, "无法读取该目录。"));
    }
    return normalizeListing(payload, requestedPath);
  }
}

export const httpFolderPickerRepository = new HttpFolderPickerRepository();
