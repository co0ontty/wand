import {
  fileExtension,
} from "../file-preview/model";
import { normalizeFilePreview } from "../file-preview/repository";
import type { FilePreviewFailure } from "../file-preview/types";
import type {
  CodeEditorFile,
  CodeEditorLoadOptions,
  CodeEditorLoadResult,
  CodeEditorRepository,
  CodeEditorSaveOutcome,
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
  fallback: string,
): FilePreviewFailure {
  return {
    message: stringValue(value.error, `${fallback} (HTTP ${response.status})`),
    status: response.status,
    size: finiteNumber(value.size, -1) >= 0 ? finiteNumber(value.size) : undefined,
    maxSize: finiteNumber(value.maxSize, -1) >= 0 ? finiteNumber(value.maxSize) : undefined,
  };
}

/** Adapter that loads/saves text files through the existing REST endpoints. */
class HttpCodeEditorRepository implements CodeEditorRepository {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async load(
    path: string,
    options: CodeEditorLoadOptions = {},
  ): Promise<CodeEditorLoadResult> {
    const response = await this.fetchImpl(
      `/api/file-preview?path=${encodeURIComponent(path)}`,
      { credentials: "same-origin", signal: options.signal },
    );
    const value = await readJson(response);
    if (!response.ok || typeof value.error === "string") {
      return { ok: false, failure: failureFromResponse(response, value, "打开文件失败") };
    }
    const preview = normalizeFilePreview(value, path);
    if (preview.kind !== "text") {
      return {
        ok: false,
        failure: {
          message: "仅支持编辑文本文件。",
          status: 415,
          size: preview.size,
        },
      };
    }
    const content = preview.content ?? "";
    const file: CodeEditorFile = {
      path: preview.path,
      name: preview.name,
      ext: preview.ext || fileExtension(preview.name),
      lang: preview.lang,
      size: preview.size ?? 0,
      mime: preview.mime,
      baseline: content,
      draft: content,
      dirty: false,
    };
    return { ok: true, file };
  }

  async save(path: string, content: string): Promise<CodeEditorSaveOutcome> {
    const response = await this.fetchImpl("/api/file-write", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    const value = await readJson(response);
    if (!response.ok || typeof value.error === "string") {
      return { ok: false, failure: failureFromResponse(response, value, "保存文件失败") };
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

export const httpCodeEditorRepository = new HttpCodeEditorRepository();
