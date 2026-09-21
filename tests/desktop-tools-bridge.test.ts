import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopToolsNavigation } from "../src/web-ui/browser/desktop-tools-bridge.js";
import { createCodeEditorModule } from "../src/web-ui/react/code-editor/controller.js";
import { createFilePreviewModule } from "../src/web-ui/react/file-preview/controller.js";
import { MemoryFilePreviewRepository } from "../src/web-ui/react/file-preview/memory-repository.js";

test("desktop file navigation waits for the authenticated shell", () => {
  let ready = false;
  const writes: boolean[] = [];
  const bridge = createDesktopToolsNavigation({
    isReady: () => ready,
    setFilePanelOpen: (open) => writes.push(open),
    hasUnsavedFiles: () => false,
    isSavingFile: () => false,
    getSelectedSessionId: () => "",
  });

  assert.equal(bridge.openFiles(), false);
  assert.deepEqual(writes, []);
  ready = true;
  assert.equal(bridge.openFiles(), true);
  assert.deepEqual(writes, [true]);
});

test("reopening desktop files does not toggle the panel closed", () => {
  let open = false;
  const bridge = createDesktopToolsNavigation({
    isReady: () => true,
    setFilePanelOpen: (next) => { open = next; },
    hasUnsavedFiles: () => false,
    isSavingFile: () => false,
    getSelectedSessionId: () => "",
  });

  bridge.openFiles();
  bridge.openFiles();
  assert.equal(open, true);
});

test("desktop close state protects draft edits and in-flight saves without changing files", () => {
  let dirty = false;
  let saving = false;
  const bridge = createDesktopToolsNavigation({
    isReady: () => true,
    setFilePanelOpen: () => { assert.fail("A close-state query must not navigate"); },
    hasUnsavedFiles: () => dirty,
    isSavingFile: () => saving,
    getSelectedSessionId: () => "",
  });
  assert.equal(bridge.getCloseState(), "ready");
  dirty = true;
  assert.equal(bridge.getCloseState(), "unsaved");
  saving = true;
  assert.equal(bridge.getCloseState(), "busy");
  dirty = false;
  assert.equal(bridge.getCloseState(), "busy");
  saving = false;
  assert.equal(bridge.getCloseState(), "ready");
});

test("desktop close protection reads actual editor tabs and preview state", async () => {
  let finishSave: () => void = () => {};
  const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
  const editor = createCodeEditorModule({
    repository: {
      async load(path) {
        return { ok: true, file: {
          path, name: path, ext: ".txt", size: 5,
          baseline: "saved", draft: "saved", dirty: false,
        } };
      },
      async save(path, content) {
        await saveGate;
        return { ok: true, result: { path, size: content.length } };
      },
    },
    runtime: { confirmDiscard: async () => false, notify() {} },
  });
  const preview = createFilePreviewModule({
    repository: new MemoryFilePreviewRepository({ files: [{
      kind: "text", path: "/preview.txt", name: "preview.txt", ext: ".txt",
      content: "saved", size: 5, rawUrl: "/raw", url: "/download",
    }] }),
  });
  const bridge = createDesktopToolsNavigation({
    isReady: () => true,
    setFilePanelOpen() {},
    hasUnsavedFiles: () => editor.controller.hasDirty() || preview.store.getSnapshot().dirty,
    isSavingFile: () => editor.store.getSnapshot().saving || preview.store.getSnapshot().saving,
    getSelectedSessionId: () => "",
  });

  await editor.controller.open("/draft.txt");
  await editor.controller.execute({ type: "change", value: "unsaved draft" });
  await editor.controller.open("/clean.txt");
  assert.equal(editor.store.getSnapshot().file?.dirty, false);
  assert.equal(bridge.getCloseState(), "unsaved", "An inactive editor tab still needs protection");
  await editor.controller.execute({ type: "activate", path: "/draft.txt" });
  const saving = editor.controller.execute({ type: "save" });
  assert.equal(bridge.getCloseState(), "busy");
  finishSave();
  await saving;
  assert.equal(bridge.getCloseState(), "ready");

  await preview.controller.open("/preview.txt");
  await preview.controller.execute({ type: "edit.enter" });
  await preview.controller.execute({ type: "edit.change", value: "preview draft" });
  assert.equal(bridge.getCloseState(), "unsaved");
  await preview.controller.execute({ type: "edit.save" });
  assert.equal(bridge.getCloseState(), "ready");
});

test("desktop issue context follows live selection instead of the initial deep-link session", () => {
  let ready = false;
  let selectedId = "initial-session";
  const bridge = createDesktopToolsNavigation({
    isReady: () => ready,
    setFilePanelOpen() {},
    hasUnsavedFiles: () => false,
    isSavingFile: () => false,
    getSelectedSessionId: () => selectedId,
  });
  assert.equal(bridge.getSelectedSessionId(), "");
  ready = true;
  assert.equal(bridge.getSelectedSessionId(), "initial-session");
  selectedId = "newly-selected-session";
  assert.equal(bridge.getSelectedSessionId(), "newly-selected-session");
  selectedId = "";
  assert.equal(bridge.getSelectedSessionId(), "", "Returning home must not reuse the initial URL session");
});
