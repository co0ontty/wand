import assert from "node:assert/strict";
import test from "node:test";
import {
  configureFolderPickerRuntime,
  folderPickerController,
  folderPickerStore,
} from "../src/web-ui/react/folder-picker/controller.ts";
import { MemoryFolderPickerRepository } from "../src/web-ui/react/folder-picker/memory-repository.ts";
import { nextFolderPickerIndex } from "../src/web-ui/react/folder-picker/model.ts";
import { HttpFolderPickerRepository } from "../src/web-ui/react/folder-picker/repository.ts";

test("folder navigation wraps through suggestions and supports Home/End", () => {
  assert.equal(nextFolderPickerIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(nextFolderPickerIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(nextFolderPickerIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextFolderPickerIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextFolderPickerIndex(1, 3, "Home"), 0);
  assert.equal(nextFolderPickerIndex(1, 3, "End"), 2);
  assert.equal(nextFolderPickerIndex(0, 0, "ArrowDown"), -1);
});

test("memory repository is isolated and records observable calls", async () => {
  const repository = new MemoryFolderPickerRepository([
    {
      currentPath: "/tmp",
      items: [
        { path: "/", name: "..", type: "parent" },
        { path: "/tmp/project", name: "project", type: "dir" },
      ],
    },
  ]);

  const first = await repository.list("/tmp");
  assert.deepEqual(first.items.map((item) => item.path), ["/", "/tmp/project"]);
  assert.deepEqual(repository.calls, ["/tmp"]);

  (first.items as Array<{ path: string }>)[0].path = "/mutated";
  assert.equal((await repository.list("/tmp")).items[0].path, "/");

  repository.setError("/denied", "权限不足");
  await assert.rejects(repository.list("/denied"), /权限不足/);
});

test("HTTP repository encodes paths, normalizes entries, and surfaces server errors", async () => {
  const calls: string[] = [];
  const repository = new HttpFolderPickerRepository(async (input) => {
    calls.push(String(input));
    if (String(input).includes("denied")) {
      return new Response(JSON.stringify({ error: "访问被拒绝" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      currentPath: "/tmp/a b",
      items: [
        { path: "/tmp", name: "..", type: "parent" },
        { path: "/tmp/a b/child", name: "child", type: "dir" },
        { path: "/tmp/a b/file", name: "file", type: "file" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const listing = await repository.list("/tmp/a b");
  assert.equal(calls[0], "/api/folders?q=%2Ftmp%2Fa%20b");
  assert.deepEqual(listing.items.map((item) => item.type), ["parent", "dir"]);
  await assert.rejects(repository.list("/denied"), /访问被拒绝/);
  await assert.rejects(repository.list("   "), /请输入工作目录/);
});

test("controller owns open, choose, close, and runtime synchronization", async () => {
  const lifecycle: string[] = [];
  const selected: string[] = [];
  const uninstall = configureFolderPickerRuntime({
    getInitialPath: () => "/workspace",
    onOpen: () => lifecycle.push("open"),
    onClose: () => lifecycle.push("close"),
    applySelection: async (path) => { selected.push(path); },
  });

  assert.equal(folderPickerController.open(), true);
  assert.equal(folderPickerStore.getSnapshot().initialPath, "/workspace");
  assert.equal(folderPickerController.isOpen(), true);
  folderPickerController.setDismissable(false);
  assert.equal(folderPickerController.closeIfOpen(), false);
  assert.equal(folderPickerController.closeTopmost(), true);
  assert.equal(folderPickerController.isOpen(), true);
  folderPickerController.setDismissable(true);
  assert.equal(await folderPickerController.choose(" /workspace/project "), true);
  assert.deepEqual(selected, ["/workspace/project"]);
  assert.deepEqual(lifecycle, ["open", "close"]);
  assert.equal(folderPickerController.isOpen(), false);
  assert.equal(folderPickerController.closeTopmost(), false);

  uninstall();
  assert.equal(folderPickerController.open(), false);
});
