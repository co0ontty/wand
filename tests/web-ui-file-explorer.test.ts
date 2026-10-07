import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createFileExplorerModule } from "../src/web-ui/react/file-explorer/controller.ts";
import {
  countFileExplorerSearchResults,
  fileExplorerEntrySizeLabel,
  fileExplorerRelativeDir,
  fileExplorerSearchMatches,
  fileExplorerSearchSegments,
  filterFileExplorerSearchResults,
  formatFileExplorerTimestamp,
  groupFileExplorerSearchResults,
} from "../src/web-ui/react/file-explorer/model.ts";
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

test("file search coalesces typing and clear cancels pending work", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [] });
  const queries: string[] = [];
  repo.search = async (query) => { queries.push(query); return { ok: true, results: [] }; };
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  const first = controller.execute({ type: "search.start", query: "a" });
  const second = controller.execute({ type: "search.start", query: "ab" });
  await Promise.all([first, second]);
  assert.deepEqual(queries, ["ab"]);
  const pending = controller.execute({ type: "search.start", query: "abc" });
  await controller.execute({ type: "search.clear" });
  await pending;
  assert.deepEqual(queries, ["ab"]);
  assert.equal(store.getSnapshot().searching, false);
  assert.equal(store.getSnapshot().searchResults, null);
});

test("file search failure stays distinct from a successful empty result", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [] });
  repo.search = async () => { throw new TypeError("Failed to fetch"); };
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await controller.execute({ type: "search.start", query: "note" });
  assert.match(store.getSnapshot().searchError ?? "", /搜索文件失败.*重试/);
  assert.doesNotMatch(store.getSnapshot().searchError ?? "", /Failed to fetch/);
  assert.equal(store.getSnapshot().searching, false);
  repo.search = async () => ({ ok: true, results: [] });
  await controller.execute({ type: "search.start", query: "note" });
  assert.equal(store.getSnapshot().searchError, "");
  assert.deepEqual(store.getSnapshot().searchResults, []);
});

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

test("move routes through the rename endpoint and refreshes both sides", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/a.ts", "file")] });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "move", from: "/app/a.ts", to: "/app/sub/a.ts" });
  assert.equal(ok, true);
  const moveCall = repo.mutationCalls.find((call) => call.kind === "rename");
  assert.deepEqual(moveCall?.payload, { from: "/app/a.ts", to: "/app/sub/a.ts" });
  assert.equal(repo.listCalls.includes("/app"), true);
});

test("move surfaces a target-exists failure without refreshing", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/a.ts", "file")] });
  repo.rename = () => Promise.resolve({ ok: false, failure: { message: "目标路径已存在。", status: 409 } });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "move", from: "/app/a.ts", to: "/app/b.ts" });
  assert.equal(ok, false);
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

test("reveal expands only the missing ancestors and targets the file", async () => {
  const repo = new MemoryFileExplorerRepository({
    "/app": [entry("/app/src", "dir")],
    "/app/src": [entry("/app/src/ui", "dir")],
    "/app/src/ui": [entry("/app/src/ui/button.tsx", "file")],
  });
  const module_ = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  const { controller, store } = module_;
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  const ok = await controller.execute({ type: "reveal", path: "/app/src/ui/button.tsx" });
  assert.equal(ok, true);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.expanded.get("/app/src")?.status, "loaded");
  assert.equal(snapshot.expanded.get("/app/src/ui")?.status, "loaded");
  assert.equal(snapshot.revealPath, "/app/src/ui/button.tsx");
  assert.equal(snapshot.activeDir, "/app/src/ui");

  const rootListings = repo.listCalls.filter((call) => call === "/app").length;
  await controller.execute({ type: "reveal", path: "/app/src/ui/button.tsx" });
  assert.equal(repo.listCalls.filter((call) => call === "/app").length, rootListings);
});

test("reveal refuses paths outside the current root", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [] });
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  assert.equal(await controller.execute({ type: "reveal", path: "/elsewhere/notes.md" }), false);
  assert.equal(store.getSnapshot().revealPath, null);
});

test("reveal drops an active search so the tree is visible again", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/src", "dir")], "/app/src": [] });
  repo.search = async () => ({ ok: true, results: [entry("/app/src/note.md", "file")] });
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  await controller.execute({ type: "search.start", query: "note" });
  assert.equal(store.getSnapshot().searchQuery, "note");

  await controller.execute({ type: "reveal", path: "/app/src/note.md" });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.searchQuery, "");
  assert.equal(snapshot.searchResults, null);
  assert.equal(snapshot.searchDurationMs, null);
  assert.equal(snapshot.revealPath, "/app/src/note.md");
});

test("revealing a directory opens it and makes it the active directory", async () => {
  const repo = new MemoryFileExplorerRepository({
    "/app": [entry("/app/src", "dir")],
    "/app/src": [entry("/app/src/ui", "dir")],
    "/app/src/ui": [entry("/app/src/ui/button.tsx", "file")],
  });
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  await controller.execute({ type: "reveal", path: "/app/src/ui" });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.revealPath, "/app/src/ui");
  assert.equal(snapshot.expanded.get("/app/src/ui")?.status, "loaded");
  assert.equal(snapshot.activeDir, "/app/src/ui");

  const listingCalls = repo.listCalls.filter((call) => call === "/app/src/ui").length;
  await controller.execute({ type: "reveal", path: "/app/src/ui" });
  assert.equal(repo.listCalls.filter((call) => call === "/app/src/ui").length, listingCalls);
});

test("reveal.done clears the one-shot target", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/a.ts", "file")] });
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");

  await controller.execute({ type: "reveal", path: "/app/a.ts" });
  assert.equal(store.getSnapshot().revealPath, "/app/a.ts");
  const revision = store.getSnapshot().revision;
  await controller.execute({ type: "reveal.done" });
  assert.equal(store.getSnapshot().revealPath, null);
  const settled = store.getSnapshot().revision;
  await controller.execute({ type: "reveal.done" });
  assert.equal(store.getSnapshot().revision, settled);
  assert.ok(settled > revision);
});

test("search records a duration and reports it only for successful calls", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [] });
  repo.search = async () => ({ ok: true, results: [entry("/app/a.ts", "file")] });
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await controller.execute({ type: "search.start", query: "a" });
  assert.equal(typeof store.getSnapshot().searchDurationMs, "number");
  assert.ok((store.getSnapshot().searchDurationMs ?? -1) >= 0);

  repo.search = async () => ({ ok: false, failure: { message: "搜索失败。" } });
  await controller.execute({ type: "search.start", query: "b" });
  assert.equal(store.getSnapshot().searchDurationMs, null);
});

test("the search filter is presentational state only", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [] });
  let searchCalls = 0;
  repo.search = async () => { searchCalls += 1; return { ok: true, results: [] }; };
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await controller.execute({ type: "search.start", query: "a" });
  assert.equal(searchCalls, 1);
  assert.equal(store.getSnapshot().searchFilter, "all");

  await controller.execute({ type: "search.filter", filter: "dir" });
  assert.equal(store.getSnapshot().searchFilter, "dir");
  assert.equal(searchCalls, 1);
});

test("switching the root clears results and reveal targets from the old tree", async () => {
  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/a.ts", "file")], "/other": [] });
  repo.search = async () => ({ ok: true, results: [entry("/app/a.ts", "file")] });
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  controller.setRoot("/app");
  await waitFor(() => store.getSnapshot().expanded.get("/app")?.status === "loaded");
  await controller.execute({ type: "search.start", query: "a" });
  await controller.execute({ type: "reveal", path: "/app/a.ts" });

  controller.setRoot("/other");
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.root, "/other");
  assert.equal(snapshot.searchQuery, "");
  assert.equal(snapshot.searchResults, null);
  assert.equal(snapshot.revealPath, null);
});

test("search highlights and grouping present the server's result set", () => {
  const results = [
    entry("/app/src/session-tree.ts", "file"),
    entry("/app/src/other.ts", "file"),
    entry("/app/tests/session-tree.test.ts", "file"),
    entry("/app/src/session", "dir"),
  ];
  assert.deepEqual(fileExplorerSearchMatches("session-tree.ts", "SESSION"), [{ start: 0, end: 7 }]);
  assert.deepEqual(fileExplorerSearchSegments("a-session-b-session", "session"), [
    { value: "a-", match: false },
    { value: "session", match: true },
    { value: "-b-", match: false },
    { value: "session", match: true },
  ]);
  assert.deepEqual(fileExplorerSearchSegments("plain.ts", "session"), [{ value: "plain.ts", match: false }]);

  const groups = groupFileExplorerSearchResults(results, "/app");
  assert.deepEqual(groups.map((group) => group.label), ["src", "tests"]);
  assert.deepEqual(groups.map((group) => group.entries.length), [3, 1]);
  // A directory result sits under its own parent, not under itself.
  assert.equal(groups[0]?.entries[2]?.path, "/app/src/session");

  const counts = countFileExplorerSearchResults(results);
  assert.deepEqual(counts, { all: 4, file: 3, dir: 1 });
  assert.deepEqual(
    filterFileExplorerSearchResults(results, "dir").map((item) => item.path),
    ["/app/src/session"],
  );
  assert.equal(filterFileExplorerSearchResults(results, "all").length, 4);
});

test("relative directory labels fall back to the absolute path outside the root", () => {
  assert.equal(fileExplorerRelativeDir("/app/src/ui", "/app"), "src/ui");
  assert.equal(fileExplorerRelativeDir("/app", "/app"), "");
  assert.equal(fileExplorerRelativeDir("/elsewhere", "/app"), "/elsewhere");
  // A result sitting in the root is labelled with the root's own name.
  assert.deepEqual(
    groupFileExplorerSearchResults([entry("/app/readme.md", "file")], "/app").map((group) => group.label),
    ["app"],
  );
});

test("entry size and timestamp labels stay empty when the API omits them", () => {
  assert.equal(fileExplorerEntrySizeLabel(entry("/app/a.ts", "file")), "");
  assert.equal(fileExplorerEntrySizeLabel({ ...entry("/app/a.ts", "file"), size: 1536 }), "1.5 KB");
  assert.equal(fileExplorerEntrySizeLabel({ ...entry("/app/dir", "dir"), size: 1536 }), "");
  assert.equal(formatFileExplorerTimestamp("not-a-date"), "");
  assert.match(formatFileExplorerTimestamp("2026-09-19T02:38:54.893Z"), /^2026-09-19 \d{2}:\d{2}$/);
});

test("空目录里的「新建文件 / 新建文件夹」不是死点击，且输入框挡输入法回车", () => {
  const host = readFileSync(new URL("../src/web-ui/react/file-explorer/host.tsx", import.meta.url), "utf8");
  // 根目录的创建输入框提成两分支共用，目录为空时也会出现。
  assert.match(host, /const rootCreateInput = pendingCreate && snapshot\.root && pendingCreate\.dir === snapshot\.root/);
  assert.match(host, /\{rootNode\?\.status === "loaded" && \(\n\s*<>\n\s*\{rootCreateInput\}/);
  // 空态文案仍在，但和创建入口同屏（三元 else 分支），不再各管一半。
  assert.match(host, /rootNode\.entries\.length > 0 \? rootNode\.entries\.map/);
  assert.match(host, /: <Empty className="wand-file-explorer-empty" description=\{null\}>这个目录是空的。<\/Empty>}/);
  assert.doesNotMatch(host, /rootNode\.entries\.length === 0 && \(\n\s*<div className="wand-file-explorer-empty">这个目录是空的/);
  // 改名 / 新建 / 搜索三处 Enter 都要先挡输入法组字。
  const guards = host.match(/if \(event\.nativeEvent\.isComposing\) return;/g) ?? [];
  assert.ok(guards.length >= 3, `IME 守卫应覆盖三处输入回车，实际 ${guards.length} 处`);
});

test("移动对话框的路径输入在输入法组字期不进入目录、也不提交", () => {
  const source = readFileSync(
    new URL("../src/web-ui/react/file-explorer/move-dialog.tsx", import.meta.url),
    "utf8",
  );
  // Enter 会 activateItem（进目录）或 commit(targetDir)（真的移动文件），半截拼音必须先挡住。
  assert.match(source, /function handleInputKeyDown\(event: KeyboardEvent<HTMLInputElement>\): void \{\n\s*\/\/ [^\n]*\n\s*if \(event\.nativeEvent\.isComposing\) return;\n\s*if \(NAVIGATION_KEYS\.has/);
  assert.match(source, /void commit\(targetDir\);/);
  // 文件面板的路径框同理：Enter 走 commitCwd + blur，半截拼音会被写成当前目录。
  const panel = readFileSync(
    new URL("../src/web-ui/react/shell/shell-file-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panel, /onKeyDown=\{\(event\) => \{\n\s*\/\/ [^\n]*\n\s*if \(event\.nativeEvent\.isComposing\) return;/);
  // 关闭按钮不抢删除的红色（全站关闭语义是 ghost，danger 只留给删除）。
  assert.doesNotMatch(panel, /id="file-side-panel-close"[\s\S]{0,200}kind="danger"/);
});

test("目录读取失败：原位给出重新加载，且该命令真的能把节点拉回 loaded", async () => {
  const host = readFileSync(new URL("../src/web-ui/react/file-explorer/host.tsx", import.meta.url), "utf8");
  // 错误块升成 role=alert，并在同一位置给出重试；命令沿用既有的 refresh（缺省目录就是 root）。
  assert.match(host, /rootNode\?\.status === "error" && \(\n\s*<Alert className="wand-file-explorer-empty" type="error"/);
  assert.match(host, /dispatch\.execute\(\{ type: "refresh", dir: snapshot\.root \}\)/);
  assert.match(host, />重新加载<\/WandButton>/);

  const repo = new MemoryFileExplorerRepository({ "/app": [entry("/app/a.ts", "file")] });
  const list = repo.list.bind(repo);
  let fail = true;
  repo.list = async (dir: string) => {
    if (!fail) return list(dir);
    fail = false;
    return { ok: false, failure: { message: "读不了这个目录。" } };
  };
  const { controller, store } = createFileExplorerModule({ repository: repo, runtime: alwaysConfirmRuntime });
  await controller.execute({ type: "setRoot", root: "/app" });
  const rootNode = () => store.getSnapshot().expanded.get("/app");
  assert.equal(rootNode()?.status, "error", "首次读取失败要落在树节点上");
  await controller.execute({ type: "refresh", dir: "/app" });
  assert.equal(rootNode()?.status, "loaded", "重试按钮的命令就是既有的 refresh，能真的重读");
  assert.equal(rootNode()?.entries.length, 1);
});

test("git 状态徽章两处都带 role=img，aria-label 不再是哑的", () => {
  const host = readFileSync(new URL("../src/web-ui/react/file-explorer/host.tsx", import.meta.url), "utf8");
  // 无 role 的 span 上 aria-label 会被屏幕阅读器忽略，徽章字母是树行里唯一的 git 线索。
  // 关键是 role/aria-label 必须落在**包着可见字形的那个 span**上：挂在父级或被
  // role=treeitem 的行名覆盖，读屏就只念条目名，M / ? 变成看不懂的哑符号。
  assert.equal((host.match(
    /<Tag className=\{`wand-explorer-git \$\{badge\.className\}\`\} color=\{gitColor\(badge\)\} role="img" title=\{badge\.label\} aria-label=\{badge\.label\}>\s*\{badge\.text\}\s*<\/Tag>/g,
  ) ?? []).length, 2, "树行与搜索结果行两处徽章都必须是 role+label+字形同节点");
});

test("移动失败的兜底文案说的是移动，不再借用读目录那句", () => {
  const dialog = readFileSync(new URL("../src/web-ui/react/file-explorer/move-dialog.tsx", import.meta.url), "utf8");
  // commit() 的 catch 里写「无法读取该目录。」，用户会以为只是列表没刷出来，实际文件还在原地。
  assert.doesNotMatch(dialog, /catch \(submitError\) \{[\s\S]{0,200}无法读取该目录/);
  assert.match(dialog, /setError\(failureMessage\(submitError, "移动失败，请检查目标目录或权限后重试。"\)\)/);
  // 读目录那句还留在真正读目录的 catch 上（listing 加载），两处不再共用一条兜底。
  assert.equal((dialog.match(/无法读取该目录。/g) ?? []).length, 1);
});
