import assert from "node:assert/strict";
import test from "node:test";

import { createFileExplorerModule } from "../src/web-ui/react/file-explorer/controller.ts";
import type {
  FileExplorerEntry,
  FileExplorerListResult,
  FileExplorerMutationResult,
  FileExplorerRepository,
  FileExplorerRuntimeAdapter,
  FileExplorerSearchResult,
} from "../src/web-ui/react/file-explorer/types.ts";

function entry(path: string, type: "file" | "dir", name?: string): FileExplorerEntry {
  return { path, name: name ?? path.split("/").pop() ?? path, type };
}

class MemoryFileExplorerRepository implements FileExplorerRepository {
  readonly listCalls: string[] = [];
  readonly mutationCalls: Array<{ kind: string; payload: Record<string, string> }> = [];
  private readonly listings = new Map<string, FileExplorerEntry[]>();

  constructor(seeds: Record<string, FileExplorerEntry[]> = {}) {
    for (const [dir, entries] of Object.entries(seeds)) this.listings.set(dir, entries);
  }

  async list(dirPath: string): Promise<FileExplorerListResult> {
    this.listCalls.push(dirPath);
    return { ok: true, entries: this.listings.get(dirPath) ?? [], truncated: false, total: this.listings.get(dirPath)?.length ?? 0 };
  }

  async search(query: string): Promise<FileExplorerSearchResult> {
    void query;
    return { ok: true, results: [] };
  }

  createFile(path: string): Promise<FileExplorerMutationResult> {
    this.mutationCalls.push({ kind: "createFile", payload: { path } });
    return Promise.resolve({ ok: true, affectedPath: path });
  }

  createDir(path: string): Promise<FileExplorerMutationResult> {
    this.mutationCalls.push({ kind: "createDir", payload: { path } });
    return Promise.resolve({ ok: true, affectedPath: path });
  }

  rename(from: string, to: string): Promise<FileExplorerMutationResult> {
    this.mutationCalls.push({ kind: "rename", payload: { from, to } });
    return Promise.resolve({ ok: true, affectedPath: to });
  }

  delete(path: string): Promise<FileExplorerMutationResult> {
    this.mutationCalls.push({ kind: "delete", payload: { path } });
    return Promise.resolve({ ok: true, affectedPath: path });
  }
}

const alwaysConfirmRuntime: FileExplorerRuntimeAdapter = {
  openFile() { /* no-op */ },
  notify() { /* no-op */ },
  async copyText() { return true; },
  async confirmDelete() { return true; },
  async promptForName() { return null; },
};

function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for predicate"));
      setTimeout(check, 5);
    };
    check();
  });
}

test("file explorer loads the root listing when setRoot is called", async () => {
  const repo = new MemoryFileExplorerRepository({
    "/app": [entry("/app/a.ts", "file"), entry("/app/sub", "dir")],
  });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;

  controller.setRoot("/app");
  assert.equal(store.getSnapshot().root, "/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");
  const node = store.getSnapshot().expanded.get("/app");
  assert.equal(node?.entries.length, 2);
  assert.equal(node?.entries[0]?.name, "a.ts");
});

test("toggling a directory expands and collapses it", async () => {
  const repo = new MemoryFileExplorerRepository({
    "/app": [entry("/app/sub", "dir")],
    "/app/sub": [entry("/app/sub/child.ts", "file")],
  });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;

  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  await controller.execute({ type: "toggle", dir: "/app/sub" });
  await waitFor(() => store.getSnapshot().expanded.get("/app/sub")?.status === "loaded");
  assert.equal(store.getSnapshot().expanded.get("/app/sub")?.entries.length, 1);

  await controller.execute({ type: "toggle", dir: "/app/sub" });
  assert.equal(store.getSnapshot().expanded.has("/app/sub"), false);
});

test("create.file delegates to the repository and refreshes the parent", async () => {
  const repo = new MemoryFileExplorerRepository({
    "/app": [entry("/app/sub", "dir")],
  });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "create.file", dir: "/app", name: "new.ts" });
  assert.equal(ok, true);
  assert.equal(repo.mutationCalls.some((call) => call.kind === "createFile" && call.payload.path === "/app/new.ts"), true);
});

test("create.dir delegates to the repository", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [] });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "create.dir", dir: "/app", name: "folder" });
  assert.equal(ok, true);
  assert.equal(repo.mutationCalls.some((call) => call.kind === "createDir" && call.payload.path === "/app/folder"), true);
});

test("rename delegates from/to through the repository", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/old.ts", "file")] });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "rename", from: "/app/old.ts", to: "/app/new.ts" });
  assert.equal(ok, true);
  const renameCall = repo.mutationCalls.find((call) => call.kind === "rename");
  assert.deepEqual(renameCall?.payload, { from: "/app/old.ts", to: "/app/new.ts" });
});

test("delete respects confirmDelete veto", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/gone.ts", "file")] });
  let confirmCalls = 0;
  const runtime: FileExplorerRuntimeAdapter = {
    ...alwaysConfirmRuntime,
    async confirmDelete() {
      confirmCalls += 1;
      return false;
    },
  };
  const module_ = createFileExplorerModule({ repository: repo, runtime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "delete", path: "/app/gone.ts" });
  assert.equal(ok, false);
  assert.equal(confirmCalls, 1);
  assert.equal(repo.mutationCalls.some((call) => call.kind === "delete"), false);
});

test("delete proceeds after confirmation and calls the repository", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/gone.ts", "file")] });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "delete", path: "/app/gone.ts" });
  assert.equal(ok, true);
  assert.equal(repo.mutationCalls.some((call) => call.kind === "delete" && call.payload.path === "/app/gone.ts"), true);
});

test("search.clear resets search state", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [] });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  await controller.execute({ type: "search.start", query: "abc" });
  assert.equal(store.getSnapshot().searchQuery, "abc");

  await controller.execute({ type: "search.clear" });
  assert.equal(store.getSnapshot().searchQuery, "");
  assert.equal(store.getSnapshot().searchResults, null);
});
