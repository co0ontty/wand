import { fileExtension, fileNameFromPath } from "./model";
import type {
  FilePreviewFailure,
  FilePreviewFile,
  FilePreviewKind,
  FilePreviewLoadOptions,
  FilePreviewLoadResult,
  FilePreviewRepository,
  FilePreviewSaveOutcome,
} from "./types";

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function previewKind(value: unknown): FilePreviewKind {
  switch (value) {
    case "image":
    case "pdf":
    case "video":
    case "audio":
    case "binary":
      return value;
    default:
      return "text";
  }
}

function rawUrl(path: string, download = false): string {
  return `/api/file-raw?${download ? "download=1&" : ""}path=${encodeURIComponent(path)}`;
}

async function readJson(response: Response): Promise<JsonRecord> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function failureFromResponse(
  response: Response,
  value: JsonRecord,
  path: string,
  fallback: string,
): FilePreviewFailure {
  const name = fileNameFromPath(path);
  const size = finiteNumber(value.size, -1);
  const failure: FilePreviewFailure = {
    message: stringValue(value.error, `${fallback} (HTTP ${response.status})`),
    status: response.status,
    size: size >= 0 ? size : undefined,
    maxSize: finiteNumber(value.maxSize, -1) >= 0 ? finiteNumber(value.maxSize) : undefined,
  };
  if (response.status === 413) {
    failure.download = { path, name, url: rawUrl(path, true), size: failure.size };
  }
  return failure;
}

export function normalizeFilePreview(value: unknown, requestedPath: string): FilePreviewFile {
  const record = isRecord(value) ? value : {};
  const path = stringValue(record.path, requestedPath).trim() || requestedPath;
  const name = stringValue(record.name, fileNameFromPath(path));
  const kind = previewKind(record.kind);
  const content = kind === "text" ? stringValue(record.content) : undefined;
  return {
    kind,
    path,
    name,
    ext: stringValue(record.ext, fileExtension(name)),
    size: Math.max(0, finiteNumber(record.size)),
    mime: stringValue(record.mime) || undefined,
    lang: stringValue(record.lang) || undefined,
    content,
    rawUrl: rawUrl(path),
    url: rawUrl(path, true),
  };
}

export class HttpFilePreviewRepository implements FilePreviewRepository {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async load(
    path: string,
    options: FilePreviewLoadOptions = {},
  ): Promise<FilePreviewLoadResult> {
    const response = await this.fetchImpl(
      `/api/file-preview?path=${encodeURIComponent(path)}`,
      { credentials: "same-origin", signal: options.signal },
    );
    const value = await readJson(response);
    if (!response.ok || typeof value.error === "string") {
      return { ok: false, failure: failureFromResponse(response, value, path, "加载预览失败") };
    }
    return { ok: true, file: normalizeFilePreview(value, path) };
  }

  async save(path: string, content: string): Promise<FilePreviewSaveOutcome> {
    const response = await this.fetchImpl("/api/file-write", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    const value = await readJson(response);
    if (!response.ok || typeof value.error === "string") {
      return { ok: false, failure: failureFromResponse(response, value, path, "保存文件失败") };
    }
    return {
      ok: true,
      result: {
        path: stringValue(value.path, path),
        size: Math.max(0, finiteNumber(value.size, new TextEncoder().encode(content).byteLength)),
        mtime: stringValue(value.mtime) || undefined,
      },
    };
  }
}

export const httpFilePreviewRepository = new HttpFilePreviewRepository();
