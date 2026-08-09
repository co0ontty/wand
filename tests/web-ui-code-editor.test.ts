import assert from "node:assert/strict";
import test from "node:test";

import { createCodeEditorModule } from "../src/web-ui/react/code-editor/controller.ts";
import type {
  CodeEditorFile,
  CodeEditorLoadResult,
  CodeEditorRepository,
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
  readonly calls: Array<{ op: "load" | "save"; path: string; content?: string }> = [];
  private readonly files = new Map<string, CodeEditorFile>();
  readonly saveFailures = new Map<string, FilePreviewFailure>();

  constructor(seeds: CodeEditorFile[] = []) {
    for (const file of seeds) this.files.set(file.path, { ...file });
  }

  async load(path: string): Promise<CodeEditorLoadResult> {
    this.calls.push({ op: "load", path });
    const file = this.files.get(path);
    if (!file) return { ok: false, failure: { message: "找不到文件", status: 404 } };
    return { ok: true, file: { ...file } };
  }

  async save(path: string, content: string): Promise<CodeEditorSaveOutcome> {
    this.calls.push({ op: "save", path, content });
    const failure = this.saveFailures.get(path);
    if (failure) return { ok: false, failure };
    const existing = this.files.get(path);
    if (!existing) return { ok: false, failure: { message: "文件已删除", status: 404 } };
    const size = content.length;
    this.files.set(path, { ...existing, draft: content, baseline: content, dirty: false, size });
    return { ok: true, result: { path, size } };
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
  assert.equal(await controller.execute({ type: "change", value: "not-written" }), false);
  finishSave?.({ ok: true, result: { path: "/app/a.ts", size: 7 } });
  assert.equal(await pendingSave, true);
  assert.equal(store.getSnapshot().activePath, "/app/a.ts");
  assert.equal(store.getSnapshot().file?.baseline, "saved-a");
  assert.equal(store.getSnapshot().file?.dirty, false);
});
