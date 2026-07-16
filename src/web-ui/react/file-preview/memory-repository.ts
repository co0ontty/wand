import type {
  FilePreviewFailure,
  FilePreviewFile,
  FilePreviewLoadOptions,
  FilePreviewLoadResult,
  FilePreviewRepository,
  FilePreviewSaveOutcome,
} from "./types";

export type FilePreviewRepositoryOperation = "load" | "save";

export interface MemoryFilePreviewSeed {
  files?: ReadonlyArray<FilePreviewFile>;
  loadFailures?: Readonly<Record<string, FilePreviewFailure>>;
  saveFailures?: Readonly<Record<string, FilePreviewFailure>>;
  errors?: Partial<Record<FilePreviewRepositoryOperation, Error>>;
}

/** Deterministic second Adapter at the File Preview Repository seam. */
export class MemoryFilePreviewRepository implements FilePreviewRepository {
  readonly calls: Array<{
    operation: FilePreviewRepositoryOperation;
    path: string;
    content?: string;
  }> = [];

  private readonly files = new Map<string, FilePreviewFile>();
  private readonly loadFailures = new Map<string, FilePreviewFailure>();
  private readonly saveFailures = new Map<string, FilePreviewFailure>();

  constructor(public seed: MemoryFilePreviewSeed = {}) {
    for (const file of seed.files ?? []) this.files.set(file.path, structuredClone(file));
    for (const [path, failure] of Object.entries(seed.loadFailures ?? {})) {
      this.loadFailures.set(path, structuredClone(failure));
    }
    for (const [path, failure] of Object.entries(seed.saveFailures ?? {})) {
      this.saveFailures.set(path, structuredClone(failure));
    }
  }

  setFile(file: FilePreviewFile): void {
    this.files.set(file.path, structuredClone(file));
    this.loadFailures.delete(file.path);
  }

  setLoadFailure(path: string, failure: FilePreviewFailure): void {
    this.loadFailures.set(path, structuredClone(failure));
  }

  setSaveFailure(path: string, failure: FilePreviewFailure): void {
    this.saveFailures.set(path, structuredClone(failure));
  }

  async load(
    path: string,
    options: FilePreviewLoadOptions = {},
  ): Promise<FilePreviewLoadResult> {
    this.calls.push({ operation: "load", path });
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.seed.errors?.load) throw this.seed.errors.load;
    const failure = this.loadFailures.get(path);
    if (failure) return { ok: false, failure: structuredClone(failure) };
    const file = this.files.get(path);
    if (!file) return { ok: false, failure: { message: "找不到预览文件。", status: 404 } };
    return { ok: true, file: structuredClone(file) };
  }

  async save(path: string, content: string): Promise<FilePreviewSaveOutcome> {
    this.calls.push({ operation: "save", path, content });
    if (this.seed.errors?.save) throw this.seed.errors.save;
    const failure = this.saveFailures.get(path);
    if (failure) return { ok: false, failure: structuredClone(failure) };
    const file = this.files.get(path);
    if (!file || file.kind !== "text") {
      return { ok: false, failure: { message: "仅支持保存文本文件。", status: 415 } };
    }
    const size = new TextEncoder().encode(content).byteLength;
    this.files.set(path, { ...file, content, size });
    return { ok: true, result: { path, size } };
  }
}
