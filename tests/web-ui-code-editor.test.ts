import assert from "node:assert/strict";
import test from "node:test";

import { createCodeEditorModule } from "../src/web-ui/react/code-editor/controller.ts";
import { HttpCodeEditorRepository } from "../src/web-ui/react/code-editor/repository.ts";
import type {
  CodeEditorConflictChoice,
  CodeEditorFile,
  CodeEditorLoadResult,
  CodeEditorRepository,
  CodeEditorSaveOptions,
  CodeEditorSaveOutcome,
  CodeEditorRuntimeAdapter,
} from "../src/web-ui/react/code-editor/types.ts";
import type { FilePreviewFailure } from "../src/web-ui/react/file-preview/types.ts";

function textFile(path: string, content = "", name?: string): CodeEditorFile {
  const leaf = name ?? path.split("/").pop() ?? "file";
  return {
    path,
    name: leaf,
    ext: ".ts",
    size: content.length,
    baseline: content,
    draft: content,
    dirty: false,
  };
}

class MemoryCodeEditorRepository implements CodeEditorRepository {
  readonly calls: Array<{
    op: "load" | "save";
    path: string;
    content?: string;
    options?: CodeEditorSaveOptions;
  }> = [];
  private readonly files = new Map<string, CodeEditorFile>();
  readonly saveFailures = new Map<string, FilePreviewFailure>();
  readonly saveConflicts = new Map<string, { message: string; path: string; size?: number; mtime?: string }>();
  disk = new Map<string, { content: string; mtime: string; size: number }>();

  constructor(seeds: CodeEditorFile[] = []) {
    for (const file of seeds) {
      this.files.set(file.path, { ...file });
      this.disk.set(file.path, {
        content: file.baseline,
        mtime: file.mtime ?? "t0",
        size: file.size,
      });
    }
  }

  async load(path: string): Promise<CodeEditorLoadResult> {
    this.calls.push({ op: "load", path });
    const disk = this.disk.get(path);
    if (disk) {
      const existing = this.files.get(path);
      const file = textFile(path, disk.content, existing?.name);
      file.mtime = disk.mtime;
      file.size = disk.size;
      this.files.set(path, file);
      return { ok: true, file: { ...file } };
    }
    const file = this.files.get(path);
    if (!file) return { ok: false, failure: { message: "找不到文件", status: 404 } };
    return { ok: true, file: { ...file } };
  }

  async save(path: string, content: string, options: CodeEditorSaveOptions = {}): Promise<CodeEditorSaveOutcome> {
    this.calls.push({ op: "save", path, content, options });
    const failure = this.saveFailures.get(path);
    if (failure) return { ok: false, failure };
    const conflict = this.saveConflicts.get(path);
    if (conflict && !options.overwrite) return { ok: false, conflict };
    const existing = this.files.get(path);
    if (!existing) return { ok: false, failure: { message: "文件已删除", status: 404 } };
    const size = content.length;
    const mtime = `saved-${this.calls.filter((call) => call.op === "save").length}`;
    this.files.set(path, { ...existing, draft: content, baseline: content, dirty: false, size, mtime });
    this.disk.set(path, { content, mtime, size });
    this.saveConflicts.delete(path);
    return { ok: true, result: { path, size, mtime } };
  }
}

const noopRuntime: CodeEditorRuntimeAdapter = {
  confirmDiscard: async () => true,
  notify() { /* no-op */ },
  onSaved() { /* no-op */ },
};

test("code editor opens a file, tracks dirty changes, and saves", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "const x = 1;")]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;
  try {
    const opened = await controller.open("/app/a.ts");
    assert.equal(opened, true);
    assert.equal(store.getSnapshot().status, "ready");
    assert.equal(store.getSnapshot().file?.baseline, "const x = 1;");
    assert.equal(store.getSnapshot().file?.dirty, false);

    await controller.execute({ type: "change", value: "const x = 2;" });
    assert.equal(store.getSnapshot().file?.dirty, true);
    assert.equal(store.getSnapshot().file?.draft, "const x = 2;");

    const saved = await controller.execute({ type: "save" });
    assert.equal(saved, true);
    assert.equal(store.getSnapshot().file?.dirty, false);
    assert.equal(store.getSnapshot().file?.baseline, "const x = 2;");
    assert.equal(repo.calls.some((call) => call.op === "save" && call.content === "const x = 2;"), true);
  } finally {
    module_.store.getSnapshot();
  }
});

test("code editor supports multiple tabs and switching", async () => {
  const repo = new MemoryCodeEditorRepository([
    textFile("/app/a.ts", "a"),
    textFile("/app/b.ts", "b"),
  ]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;

  await controller.open("/app/a.ts");
  await controller.open("/app/b.ts");
  assert.equal(store.getSnapshot().activePath, "/app/b.ts");
  assert.equal(store.getSnapshot().tabs.length, 2);

  await controller.execute({ type: "activate", path: "/app/a.ts" });
  assert.equal(store.getSnapshot().activePath, "/app/a.ts");
  assert.equal(store.getSnapshot().file?.baseline, "a");
});

test("switching files preserves dirty drafts without a discard prompt", async () => {
  const repo = new MemoryCodeEditorRepository([
    textFile("/app/a.ts", "a"),
    textFile("/app/b.ts", "b"),
  ]);
  let confirmCalls = 0;
  const module_ = createCodeEditorModule({
    repository: repo,
    runtime: {
      ...noopRuntime,
      confirmDiscard: async () => {
        confirmCalls += 1;
        return false;
      },
    },
  });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "dirty-a" });
  assert.equal(await controller.open("/app/b.ts"), true);
  assert.deepEqual(store.getSnapshot().tabs.map((tab) => tab.path), ["/app/a.ts", "/app/b.ts"]);
  assert.equal(store.getSnapshot().tabs[0]?.dirty, true);
  await controller.execute({ type: "activate", path: "/app/a.ts" });
  assert.equal(store.getSnapshot().file?.draft, "dirty-a");
  assert.equal(confirmCalls, 0);
});

test("closing the last tab hides the editor", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "a")]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;

  await controller.open("/app/a.ts");
  assert.equal(store.getSnapshot().open, true);
  await controller.execute({ type: "close", path: "/app/a.ts" });
  assert.equal(store.getSnapshot().open, false);
  assert.equal(store.getSnapshot().activePath, null);
});

test("revert restores baseline content and clears dirty state", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "original")]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;

  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "modified" });
  assert.equal(store.getSnapshot().file?.dirty, true);
  await controller.execute({ type: "revert" });
  assert.equal(store.getSnapshot().file?.draft, "original");
  assert.equal(store.getSnapshot().file?.dirty, false);
});

test("discard confirmation blocks closing a dirty tab", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "a")]);
  let confirmCalls = 0;
  const runtime: CodeEditorRuntimeAdapter = {
    ...noopRuntime,
    confirmDiscard: async () => {
      confirmCalls += 1;
      return false;
    },
  };
  const module_ = createCodeEditorModule({ repository: repo, runtime });
  const { controller, store } = module_;

  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "dirty" });
  const closed = await controller.execute({ type: "close", path: "/app/a.ts" });
  assert.equal(closed, false);
  assert.equal(confirmCalls, 1);
  assert.equal(store.getSnapshot().open, true);
});

test("save failure surfaces the failure and keeps the draft", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "a")]);
  repo.saveFailures.set("/app/a.ts", { message: "磁盘已满", status: 500 });
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;

  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "dirty" });
  const saved = await controller.execute({ type: "save" });
  assert.equal(saved, false);
  assert.equal(store.getSnapshot().failure?.message, "磁盘已满");
  assert.equal(store.getSnapshot().file?.dirty, true);
  assert.equal(store.getSnapshot().file?.draft, "dirty");
});

test("save keeps its file identity and blocks tab changes while in flight", async () => {
  let finishSave: ((outcome: CodeEditorSaveOutcome) => void) | null = null;
  const repository: CodeEditorRepository = {
    async load(path) {
      return { ok: true, file: textFile(path, path.endsWith("a.ts") ? "a" : "b") };
    },
    save() {
      return new Promise<CodeEditorSaveOutcome>((resolve) => { finishSave = resolve; });
    },
  };
  const module_ = createCodeEditorModule({ repository, runtime: noopRuntime });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "saved-a" });
  const pendingSave = controller.execute({ type: "save" });

  assert.equal(store.getSnapshot().saving, true);
  assert.equal(await controller.open("/app/b.ts"), false);
  assert.equal(await controller.execute({ type: "change", value: "typed-during-save" }), true);
  finishSave?.({ ok: true, result: { path: "/app/a.ts", size: 7 } });
  assert.equal(await pendingSave, true);
  assert.equal(store.getSnapshot().activePath, "/app/a.ts");
  assert.equal(store.getSnapshot().file?.baseline, "saved-a");
  assert.equal(store.getSnapshot().file?.draft, "typed-during-save");
  assert.equal(store.getSnapshot().file?.dirty, true);
});


test("save sends expected mtime and keeps baseline on the written draft", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "original")]);
  const openedFile = await repo.load("/app/a.ts");
  assert.equal(openedFile.ok, true);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "written" });
  const saved = await controller.execute({ type: "save" });
  assert.equal(saved, true);
  const saveCall = repo.calls.find((call) => call.op === "save");
  assert.equal(saveCall?.options?.expectedMtime, "t0");
  assert.equal(saveCall?.options?.overwrite, false);
  assert.equal(store.getSnapshot().file?.mtime?.startsWith("saved-"), true);
  assert.equal(store.getSnapshot().file?.baseline, "written");
});

test("409 conflict can reload disk content without writing the stale draft", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "original")]);
  const choices: CodeEditorConflictChoice[] = [];
  const notices: Array<[string, string]> = [];
  const module_ = createCodeEditorModule({
    repository: repo,
    runtime: {
      ...noopRuntime,
      confirmConflict: async () => {
        choices.push("reload");
        return "reload";
      },
      notify(message, tone) {
        notices.push([message, tone]);
      },
    },
  });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "stale editor draft" });
  repo.disk.set("/app/a.ts", { content: "external agent changes", mtime: "t-ext", size: 22 });
  repo.saveConflicts.set("/app/a.ts", {
    message: "文件已被外部修改。",
    path: "/app/a.ts",
    mtime: "t-ext",
    size: 22,
  });
  const saved = await controller.execute({ type: "save" });
  assert.equal(saved, true);
  assert.deepEqual(choices, ["reload"]);
  assert.equal(store.getSnapshot().file?.draft, "external agent changes");
  assert.equal(store.getSnapshot().file?.baseline, "external agent changes");
  assert.equal(store.getSnapshot().file?.dirty, false);
  assert.equal(store.getSnapshot().file?.mtime, "t-ext");
  assert.equal(repo.disk.get("/app/a.ts")?.content, "external agent changes");
  assert.equal(notices.some((item) => item[0] === "已重新加载磁盘文件"), true);
});

test("409 conflict overwrite writes only after explicit confirmation", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "original")]);
  const choices: CodeEditorConflictChoice[] = [];
  const module_ = createCodeEditorModule({
    repository: repo,
    runtime: {
      ...noopRuntime,
      confirmConflict: async () => {
        choices.push("overwrite");
        return "overwrite";
      },
    },
  });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "stale editor draft" });
  repo.saveConflicts.set("/app/a.ts", {
    message: "文件已被外部修改。",
    path: "/app/a.ts",
    mtime: "t-ext",
    size: 22,
  });
  const saved = await controller.execute({ type: "save" });
  assert.equal(saved, true);
  assert.deepEqual(choices, ["overwrite"]);
  const saveCalls = repo.calls.filter((call) => call.op === "save");
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[0]?.options?.overwrite, false);
  assert.equal(saveCalls[1]?.options?.overwrite, true);
  assert.equal(saveCalls[1]?.content, "stale editor draft");
  assert.equal(store.getSnapshot().file?.baseline, "stale editor draft");
  assert.equal(repo.disk.get("/app/a.ts")?.content, "stale editor draft");
});

test("save during later typing only advances baseline to the written draft", async () => {
  let finishSave: ((outcome: CodeEditorSaveOutcome) => void) | null = null;
  const saveOptions: CodeEditorSaveOptions[] = [];
  const repository: CodeEditorRepository = {
    async load(path) {
      return { ok: true, file: { ...textFile(path, "a"), mtime: "t0" } };
    },
    save(_path, _content, options = {}) {
      saveOptions.push(options);
      return new Promise<CodeEditorSaveOutcome>((resolve) => { finishSave = resolve; });
    },
  };
  const module_ = createCodeEditorModule({ repository, runtime: noopRuntime });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "saved-a" });
  const pendingSave = controller.execute({ type: "save" });
  assert.equal(store.getSnapshot().saving, true);
  assert.equal(await controller.execute({ type: "change", value: "typed-during-save" }), true);
  finishSave?.({ ok: true, result: { path: "/app/a.ts", size: 7, mtime: "t1" } });
  assert.equal(await pendingSave, true);
  assert.equal(store.getSnapshot().file?.baseline, "saved-a");
  assert.equal(store.getSnapshot().file?.draft, "typed-during-save");
  assert.equal(store.getSnapshot().file?.dirty, true);
  assert.equal(store.getSnapshot().file?.mtime, "t1");
  assert.equal(saveOptions[0]?.expectedMtime, "t0");
});

test("HTTP repository captures preview mtime and sends expected mtime unless overwrite", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const repository = new HttpCodeEditorRepository(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.startsWith("/api/file-preview")) {
      return new Response(JSON.stringify({
        kind: "text",
        path: "/tmp/a.ts",
        name: "a.ts",
        ext: ".ts",
        size: 3,
        content: "abc",
        mtime: "2026-09-10T00:00:00.000Z",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (body && typeof body === "object" && "expectedMtime" in body) {
      return new Response(JSON.stringify({
        error: "文件已被外部修改。",
        errorCode: "FILE_CHANGED",
        path: "/tmp/a.ts",
        size: 10,
        mtime: "2026-09-10T00:00:01.000Z",
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true,
      path: "/tmp/a.ts",
      size: 5,
      mtime: "2026-09-10T00:00:02.000Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const loaded = await repository.load("/tmp/a.ts");
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ok && loaded.file?.mtime, "2026-09-10T00:00:00.000Z");

  const conflict = await repository.save("/tmp/a.ts", "draft", {
    expectedMtime: "2026-09-10T00:00:00.000Z",
    expectedSize: 3,
  });
  assert.equal(conflict.ok, false);
  assert.equal("conflict" in conflict && conflict.ok === false ? conflict.conflict.mtime : "", "2026-09-10T00:00:01.000Z");
  assert.deepEqual(calls[1]?.body, {
    path: "/tmp/a.ts",
    content: "draft",
    expectedMtime: "2026-09-10T00:00:00.000Z",
    expectedSize: 3,
  });

  const overwritten = await repository.save("/tmp/a.ts", "draft", { overwrite: true, expectedMtime: "old" });
  assert.equal(overwritten.ok, true);
  assert.deepEqual(calls[2]?.body, { path: "/tmp/a.ts", content: "draft" });
});

