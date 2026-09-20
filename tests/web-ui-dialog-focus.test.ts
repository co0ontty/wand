import assert from "node:assert/strict";
import test from "node:test";

import { watchDialogAutofocus } from "../src/web-ui/react/ui/dialog-focus.js";

function fixture() {
  let notify = () => {};
  let disconnected = false;
  const owner = Object.assign(new EventTarget(), {
    activeElement: null as HTMLElement | null,
    defaultView: {
      MutationObserver: class {
        constructor(callback: () => void) { notify = callback; }
        observe() {}
        disconnect() { disconnected = true; }
      },
    },
  });
  const targets: HTMLElement[] = [];
  const container = {
    ownerDocument: owner,
    querySelectorAll: () => targets,
  } as unknown as HTMLElement;
  function node({ disabled = false, visible = true } = {}): HTMLElement {
    const element = {
      matches: () => disabled,
      getClientRects: () => visible ? [{}] : [],
      focus() { owner.activeElement = element as unknown as HTMLElement; },
    };
    return element as unknown as HTMLElement;
  }
  const fallback = node();
  owner.activeElement = fallback;
  return {
    owner, container, fallback, targets, node,
    notify: () => notify(),
    disconnected: () => disconnected,
  };
}

test("a loaded form receives focus once after the initial loading surface", () => {
  const state = fixture();
  watchDialogAutofocus(state.container, state.fallback);
  state.notify();
  assert.equal(state.owner.activeElement, state.fallback);

  const input = state.node();
  state.targets.push(input);
  state.notify();
  assert.equal(state.owner.activeElement, input);
  assert.equal(state.disconnected(), true);

  state.owner.activeElement = state.fallback;
  state.notify();
  assert.equal(state.owner.activeElement, state.fallback, "later mutations must not refocus the form");
});

for (const eventName of ["pointerdown", "keydown"]) {
  test(`a ${eventName} cancels deferred autofocus even if focus returns to its original position`, () => {
    const state = fixture();
    watchDialogAutofocus(state.container, state.fallback);
    state.owner.dispatchEvent(new Event(eventName));
    state.targets.push(state.node());
    state.notify();

    assert.equal(state.owner.activeElement, state.fallback);
    assert.equal(state.disconnected(), true);
  });
}

test("loading completion respects focus moved to another control", () => {
  const state = fixture();
  watchDialogAutofocus(state.container, state.fallback);
  const chosen = state.node();
  state.owner.activeElement = chosen;
  state.targets.push(state.node());
  state.notify();

  assert.equal(state.owner.activeElement, chosen);
  assert.equal(state.disconnected(), true);
});

test("closing a loading dialog cancels its pending focus transfer", () => {
  const state = fixture();
  const stop = watchDialogAutofocus(state.container, state.fallback);
  stop();
  state.targets.push(state.node());
  state.notify();

  assert.equal(state.owner.activeElement, state.fallback);
  assert.equal(state.disconnected(), true);
});

test("deferred focus skips unavailable targets and waits for a usable field", () => {
  const state = fixture();
  watchDialogAutofocus(state.container, state.fallback);
  state.targets.push(state.node({ disabled: true }), state.node({ visible: false }));
  state.notify();
  assert.equal(state.owner.activeElement, state.fallback);
  assert.equal(state.disconnected(), false);

  const input = state.node();
  state.targets.push(input);
  state.notify();
  assert.equal(state.owner.activeElement, input);
});

test("a dialog without an initial control can transfer focus from its popup", () => {
  const state = fixture();
  state.owner.activeElement = state.container;
  watchDialogAutofocus(state.container, null);
  const input = state.node();
  state.targets.push(input);
  state.notify();

  assert.equal(state.owner.activeElement, input);
});
