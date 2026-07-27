import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  MemoryUiAdapter,
  UiStoreProvider,
  createUiStoreExternalSource,
  useUiDispatch,
  useUiStoreSnapshot,
  type UiAction,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/index.js";

function fixture(title: string): UiSnapshotData {
  return {
    auth: { phase: "authenticated" },
    viewport: { mobile: false, online: true, embedTerminal: false, nativeInput: false },
    capabilities: { backToNative: false, switchServer: false },
    layout: {
      sessionsDrawerOpen: false,
      sidebarPinned: true,
      sidebarCollapsed: false,
      sidebarAnchored: true,
      sessionsBackdropVisible: false,
      filePanelOpen: false,
      filePanelBackdropVisible: false,
      topbarMoreOpen: false,
      currentView: "terminal",
    },
    selected: null,
    sidebar: {
      interactiveCount: 0,
      totalCount: 0,
      manageMode: false,
      selectedCount: 0,
      groups: [],
    },
    topbar: {
      title,
      description: "",
      statusLabel: "",
      statusTone: "",
      cwd: "/tmp",
      currentTask: "",
      git: null,
    },
    legacyVisibility: { terminal: false, chat: false, blank: true, composer: false },
  };
}

test("UiStoreProvider exposes the server snapshot and dispatch hook", () => {
  const store = new MemoryUiAdapter(fixture("React shell"));
  let capturedRevision = -1;
  let dispatch: ((action: UiAction) => void | Promise<unknown>) | null = null;

  function Probe() {
    const snapshot = useUiStoreSnapshot();
    dispatch = useUiDispatch();
    capturedRevision = snapshot.revision;
    return createElement("span", null, snapshot.topbar.title);
  }

  const html = renderToString(createElement(
    UiStoreProvider,
    { store },
    createElement(Probe),
  ));

  assert.match(html, /React shell/);
  assert.equal(capturedRevision, 0);
  dispatch?.({ type: "nav.home" });
  assert.deepEqual(store.actionLog, [{ type: "nav.home" }]);
  store.dispose();
});

test("React external source forwards stable snapshots, subscription, and unsubscription", () => {
  const store = new MemoryUiAdapter(fixture("Before"));
  const source = createUiStoreExternalSource(store);
  const initial = source.getSnapshot();
  const revisions: number[] = [];
  const unsubscribe = source.subscribe(() => revisions.push(source.getSnapshot().revision));

  assert.strictEqual(source.getSnapshot(), initial);
  store.setSnapshot(fixture("After"), { sync: true });
  assert.equal(source.getSnapshot().topbar.title, "After");
  assert.deepEqual(revisions, [1]);

  unsubscribe();
  store.setSnapshot(fixture("Ignored"), { sync: true });
  assert.deepEqual(revisions, [1]);
  store.dispose();
});

test("React store hooks fail clearly when the provider boundary is missing", () => {
  function Probe() {
    useUiStoreSnapshot();
    return null;
  }

  assert.throws(
    () => renderToString(createElement(Probe)),
    /useUiStore must be used inside UiStoreProvider/,
  );
});
