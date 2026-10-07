import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createCodeEditorModule } from "../src/web-ui/react/code-editor/controller.ts";
import {
  codeEditorFindMatches,
  stepCodeEditorFindIndex,
} from "../src/web-ui/react/code-editor/model.ts";
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
  const dot = leaf.lastIndexOf(".");
  return {
    path,
    name: leaf,
    ext: dot > 0 ? leaf.slice(dot) : "",
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

test("closing an inactive dirty tab still asks before discarding", async () => {
  const repo = new MemoryCodeEditorRepository([
    textFile("/app/a.ts", "a"),
    textFile("/app/b.ts", "b"),
  ]);
  const subjects: string[] = [];
  let decide = false;
  const module_ = createCodeEditorModule({
    repository: repo,
    runtime: {
      ...noopRuntime,
      async confirmDiscard(_reason, path) {
        subjects.push(path);
        return decide;
      },
    },
  });
  const { controller, store } = module_;

  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "dirty-a" });
  await controller.open("/app/b.ts"); // a 成了非激活的脏标签
  assert.equal(store.getSnapshot().activePath, "/app/b.ts");

  assert.equal(await controller.execute({ type: "close", path: "/app/a.ts" }), false);
  assert.deepEqual(subjects, ["/app/a.ts"], "确认框要指向被关闭的那个文件，不是当前激活的");
  assert.equal(store.getSnapshot().tabs.length, 2);
  assert.equal(store.getSnapshot().tabs.find((tab) => tab.path === "/app/a.ts")?.dirty, true, "取消后草稿还在");

  decide = true;
  assert.equal(await controller.execute({ type: "close", path: "/app/a.ts" }), true);
  assert.deepEqual(store.getSnapshot().tabs.map((tab) => tab.path), ["/app/b.ts"]);
  assert.equal(store.getSnapshot().activePath, "/app/b.ts", "关掉非激活标签不该抢走当前编辑焦点");
});

test("closeAll asks once with the dirty summary and keeps every tab on cancel", async () => {
  const repo = new MemoryCodeEditorRepository([
    textFile("/app/a.ts", "a"),
    textFile("/app/b.ts", "b"),
  ]);
  const subjects: string[] = [];
  let decide = false;
  const module_ = createCodeEditorModule({
    repository: repo,
    runtime: {
      ...noopRuntime,
      async confirmDiscard(_reason, subject) {
        subjects.push(subject);
        return decide;
      },
    },
  });
  const { controller, store } = module_;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  await controller.open("/app/a.ts");
  await controller.execute({ type: "change", value: "dirty-a" });
  await controller.open("/app/b.ts");
  await controller.execute({ type: "change", value: "dirty-b" });

  controller.closeAll();
  await settle();
  assert.equal(subjects.length, 1, "整批关闭只弹一次汇总确认");
  assert.match(subjects[0]!, /2 个未保存文件/, "汇总要给出脏文件数量");
  assert.match(subjects[0]!, /a\.ts、b\.ts/, "并列出名字，用户知道会丢掉哪些");
  assert.equal(store.getSnapshot().tabs.length, 2, "取消则整体不关");
  assert.equal(store.getSnapshot().file?.draft, "dirty-b");

  decide = true;
  controller.closeAll();
  await settle();
  assert.equal(store.getSnapshot().open, false);
  assert.equal(store.getSnapshot().tabs.length, 0);
  assert.equal(subjects.length, 2);
});

test("closeAll without dirty tabs closes straight away without a prompt", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "a")]);
  let confirmCalls = 0;
  const module_ = createCodeEditorModule({
    repository: repo,
    runtime: {
      ...noopRuntime,
      async confirmDiscard() {
        confirmCalls += 1;
        return true;
      },
    },
  });
  const { controller, store } = module_;

  await controller.open("/app/a.ts");
  controller.closeAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(confirmCalls, 0, "没有未保存内容时不该拦人");
  assert.equal(store.getSnapshot().open, false);
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


test("code editor find locates matches with line numbers", () => {
  const text = "alpha\nbeta ALPHA\ngamma";
  const matches = codeEditorFindMatches(text, "alpha");
  assert.deepEqual(matches, [
    { start: 0, end: 5, line: 1 },
    { start: 11, end: 16, line: 2 },
  ]);
  assert.deepEqual(codeEditorFindMatches(text, "alpha", { caseSensitive: true }), [
    { start: 0, end: 5, line: 1 },
  ]);
  assert.deepEqual(codeEditorFindMatches(text, ""), []);
  assert.deepEqual(codeEditorFindMatches(text, "zzz"), []);
});

test("code editor find does not overlap matches or lose offsets to case folding", () => {
  // "aaaa" holds two non-overlapping "aa" hits, and the İ fold must not shift
  // the offsets of the hits that follow it.
  assert.deepEqual(codeEditorFindMatches("aaaa", "aa").map((match) => match.start), [0, 2]);
  const folded = "İİ note";
  const note = codeEditorFindMatches(folded, "note");
  assert.equal(note.length, 1);
  assert.equal(folded.slice(note[0].start, note[0].end), "note");
});

test("code editor find steps wrap in both directions", () => {
  assert.equal(stepCodeEditorFindIndex(0, 3, 1), 1);
  assert.equal(stepCodeEditorFindIndex(2, 3, 1), 0);
  assert.equal(stepCodeEditorFindIndex(0, 3, -1), 2);
  assert.equal(stepCodeEditorFindIndex(0, 0, 1), 0);
  assert.equal(stepCodeEditorFindIndex(9, 3, 1), 1);
});

test("find.open, find.set, and find.step navigate the active file", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/a.ts", "one two one")]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  assert.equal(store.getSnapshot().findOpen, false);

  await controller.execute({ type: "find.open" });
  assert.equal(store.getSnapshot().findOpen, true);
  assert.equal(store.getSnapshot().findQuery, "");

  await controller.execute({ type: "find.set", query: "one" });
  assert.equal(store.getSnapshot().findIndex, 0);
  assert.equal(await controller.execute({ type: "find.step", delta: 1 }), true);
  assert.equal(store.getSnapshot().findIndex, 1);
  assert.equal(await controller.execute({ type: "find.step", delta: 1 }), true);
  assert.equal(store.getSnapshot().findIndex, 0);
  assert.equal(await controller.execute({ type: "find.step", delta: -1 }), true);
  assert.equal(store.getSnapshot().findIndex, 1);

  await controller.execute({ type: "find.set", query: "one" });
  assert.equal(store.getSnapshot().findIndex, 1);

  await controller.execute({ type: "find.set", query: "absent" });
  assert.equal(await controller.execute({ type: "find.step", delta: 1 }), false);
  assert.equal(store.getSnapshot().findOpen, true);

  await controller.execute({ type: "find.close" });
  assert.equal(store.getSnapshot().findOpen, false);
  // The query survives closing the bar, so ⌘F reopens where the user left off.
  assert.equal(store.getSnapshot().findQuery, "absent");
});

test("find case toggle restarts navigation and switching tabs resets the position", async () => {
  const repo = new MemoryCodeEditorRepository([
    textFile("/app/a.ts", "Note note NOTE"),
    textFile("/app/b.ts", "note"),
  ]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;
  await controller.open("/app/a.ts");
  await controller.execute({ type: "find.set", query: "note" });
  await controller.execute({ type: "find.step", delta: 1 });
  assert.equal(store.getSnapshot().findIndex, 1);

  await controller.execute({ type: "find.case.toggle" });
  assert.equal(store.getSnapshot().findCaseSensitive, true);
  assert.equal(store.getSnapshot().findIndex, 0);
  assert.equal(store.getSnapshot().findQuery, "note");

  await controller.open("/app/b.ts");
  assert.equal(store.getSnapshot().findIndex, 0);
  assert.equal(store.getSnapshot().findQuery, "note");
  assert.equal(store.getSnapshot().findCaseSensitive, true);
});

test("Markdown files open rendered and can toggle back to source", async () => {
  const repo = new MemoryCodeEditorRepository([
    textFile("/app/README.md", "# 标题\n\n正文", "README.md"),
    textFile("/app/notes.MARKDOWN", "note", "notes.MARKDOWN"),
    textFile("/app/a.ts", "const x = 1;"),
  ]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;

  await controller.open("/app/README.md");
  assert.equal(store.getSnapshot().preview, true);
  assert.equal(await controller.execute({ type: "preview.toggle" }), true);
  assert.equal(store.getSnapshot().preview, false);
  await controller.execute({ type: "preview.toggle" });
  assert.equal(store.getSnapshot().preview, true);

  // .markdown counts too, and each tab keeps its own mode.
  await controller.open("/app/notes.MARKDOWN");
  assert.equal(store.getSnapshot().preview, true);
  await controller.execute({ type: "preview.toggle" });
  await controller.execute({ type: "activate", path: "/app/README.md" });
  assert.equal(store.getSnapshot().preview, true);

  // Source files never enter the rendered mode.
  await controller.open("/app/a.ts");
  assert.equal(store.getSnapshot().preview, false);
  assert.equal(await controller.execute({ type: "preview.toggle" }), false);
  assert.equal(store.getSnapshot().preview, false);

  // Reopening a Markdown tab resets it to rendered, like a fresh open.
  await controller.execute({ type: "activate", path: "/app/notes.MARKDOWN" });
  await controller.execute({ type: "close", path: "/app/notes.MARKDOWN" });
  await controller.open("/app/notes.MARKDOWN");
  assert.equal(store.getSnapshot().preview, true);
});

test("entering the rendered Markdown mode closes the find bar", async () => {
  const repo = new MemoryCodeEditorRepository([textFile("/app/README.md", "# 标题", "README.md")]);
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;
  await controller.open("/app/README.md");
  await controller.execute({ type: "preview.toggle" });
  assert.equal(store.getSnapshot().preview, false);
  await controller.execute({ type: "find.set", query: "标题" });
  assert.equal(store.getSnapshot().findOpen, true);

  await controller.execute({ type: "preview.toggle" });
  assert.equal(store.getSnapshot().preview, true);
  assert.equal(store.getSnapshot().findOpen, false);
  // Leaving the preview keeps a closed find bar closed.
  assert.equal(await controller.execute({ type: "preview.toggle" }), true);
  assert.equal(store.getSnapshot().findOpen, false);
  assert.equal(store.getSnapshot().findQuery, "标题");
});

test("discard 确认文案点名到具体文件，非激活脏标签也拦", () => {
  const source = readFileSync(
    new URL("../src/web-ui/react/code-editor/controller.ts", import.meta.url),
    "utf8",
  );
  // 文案里带文件标识，用户才知道放弃的是哪一个标签。
  assert.match(source, /discardCopy\(reason, discardSubjectOf\(path\.split\("\/"\)\.pop\(\) \|\| path\)\)/);
  assert.match(source, /message: `\$\{subject\}有未保存的改动，关闭后会丢失。`/);
  // 关闭路径不再区分激活 / 非激活：脏就要确认。
  assert.match(source, /if \(target\?\.dirty && !await confirmDiscard\("close", target\)\) return false;/);
  assert.doesNotMatch(source, /wasActive && !await confirmDiscard/);
});

test("编辑器的 Tab 缩进在输入法组字期不写进正文", () => {
  const hostSource = readFileSync(
    new URL("../src/web-ui/react/code-editor/host.tsx", import.meta.url),
    "utf8",
  );
  assert.match(hostSource, /isComposing/);
  // 查找框回车 + 正文 Tab 两处都要挡组字，且都在 preventDefault 之前。
  const guards = hostSource.match(/if \(event\.nativeEvent\.isComposing\) return;/g) ?? [];
  assert.equal(guards.length, 3, `查找回车、正文Tab及Shell Escape/查找快捷键都应挡组字，实际 ${guards.length} 处`);
  assert.match(hostSource, /if \(event\.key === "Tab"\) \{\n\s*\/\/ [^\n]*\n\s*if \(event\.nativeEvent\.isComposing\) return;\n\s*event\.preventDefault\(\);/);
  // 保存的 Ctrl/Cmd+S 分支在 Tab 之前，不受组字守卫影响。
  assert.match(hostSource, /\(event\.ctrlKey \|\| event\.metaKey\) && event\.key\.toLowerCase\(\) === "s"[\s\S]{0,160}if \(event\.key === "Tab"\)/);
});

test("编辑器打开失败：原位给出重新加载，且 open(同一路径) 真的重读磁盘", async () => {
  const hostSource = readFileSync(
    new URL("../src/web-ui/react/code-editor/host.tsx", import.meta.url),
    "utf8",
  );
  // id 是批H 给标签页 aria-controls 用的面板身份，不影响这段失败态本身。
  assert.match(hostSource, /<Flex id=\{CODE_EDITOR_PANEL_ID\}[^>]*className="wand-code-editor-state error" role="alert">[\s\S]{0,400}\{snapshot\.activePath \? <WandButton/);
  assert.match(hostSource, /void codeEditorController\.open\(snapshot\.activePath!\)/);
  assert.match(hostSource, />重新加载<\/WandButton>/);
  // 不用 activate：activate 的「已激活同一路径」分支只 return true，不读盘。
  assert.doesNotMatch(hostSource, /execute\(\{ type: "activate", path: snapshot\.activePath/);

  const repo = new MemoryCodeEditorRepository();
  const module_ = createCodeEditorModule({ repository: repo, runtime: noopRuntime });
  const { controller, store } = module_;
  await controller.open("/app/late.ts");
  assert.equal(store.getSnapshot().status, "error");
  assert.equal(store.getSnapshot().activePath, "/app/late.ts", "失败态留着路径，重试按钮才有目标");
  repo.disk.set("/app/late.ts", { content: "ok", mtime: "t1", size: 2 });
  const reloaded = await controller.open(store.getSnapshot().activePath!);
  assert.equal(reloaded, true);
  assert.equal(store.getSnapshot().status, "ready");
  assert.equal(store.getSnapshot().file?.baseline, "ok");
  assert.equal(repo.calls.filter((call) => call.op === "load" && call.path === "/app/late.ts").length, 2);
});

test("Ant Tabs承担标签焦点与关闭控件，源码canvas保持唯一面板", () => {
  const host = readFileSync(new URL("../src/web-ui/react/code-editor/host.tsx", import.meta.url), "utf8");
  assert.match(host, /<Tabs/);
  assert.match(host, /type="editable-card"/);
  assert.match(host, /activeKey=\{snapshot.activePath/);
  assert.match(host, /onChange=\{path => run\(\{ type: "activate", path \}\)\}/);
  assert.match(host, /action === "remove"[\s\S]{0,100}closeFile\(path\)/);
  assert.match(host, /"aria-controls": CODE_EDITOR_PANEL_ID/);
  assert.match(host, /"aria-label": tab\?\.dirty \? `\$\{tab.name\}，未保存`/);
  assert.match(host, /"aria-label": `关闭 \$\{tab\?\.name/);
  assert.match(host, /<Badge dot=\{tab.dirty\}/);
  assert.match(host, /<span role="status" aria-label=\{`字号 \$\{snapshot.fontSize\}`\}/);
});

test("库标签的方向键焦点继续激活对应文件，不被编辑区抢回", () => {
  const host = readFileSync(new URL("../src/web-ui/react/code-editor/host.tsx", import.meta.url), "utf8");
  assert.match(host, /onFocus: event => \{[\s\S]{0,150}run\(\{ type: "activate", path: tab.path \}\)/);
  assert.match(host, /document.activeElement\?\.getAttribute\("role"\) !== "tab"/);
  assert.equal((host.match(/id=\{CODE_EDITOR_PANEL_ID\}/g) ?? []).length, 5);
  assert.match(host, /renderTabBar=/);
  assert.doesNotMatch(host, /tabRefs|const step = event.key/);
});
