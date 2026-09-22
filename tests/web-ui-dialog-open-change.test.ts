import assert from "node:assert/strict";
import test from "node:test";

import {
  DIALOG_OUTSIDE_PRESS_GRACE_MS,
  handleDialogOpenChange,
} from "../src/web-ui/react/ui/dialog-open-change.js";

function details(reason: string): { readonly value: { reason: string; cancel(): void }; cancelled(): boolean } {
  let cancelled = false;
  return {
    value: { reason, cancel: () => { cancelled = true; } },
    cancelled: () => cancelled,
  };
}

test("a trailing outside press cannot close a dialog immediately after it opens", () => {
  const attempt = details("outside-press");
  const changes: boolean[] = [];

  handleDialogOpenChange(
    false,
    attempt.value,
    true,
    1_000,
    1_000 + DIALOG_OUTSIDE_PRESS_GRACE_MS - 1,
    (open) => changes.push(open),
  );

  assert.equal(attempt.cancelled(), true);
  assert.deepEqual(changes, []);
});

test("an intentional outside press remains dismissable after the grace window", () => {
  const attempt = details("outside-press");
  const changes: boolean[] = [];

  handleDialogOpenChange(
    false,
    attempt.value,
    true,
    1_000,
    1_000 + DIALOG_OUTSIDE_PRESS_GRACE_MS,
    (open) => changes.push(open),
  );

  assert.equal(attempt.cancelled(), false);
  assert.deepEqual(changes, [false]);
});

test("a locked dialog still rejects escape and later outside presses", () => {
  for (const reason of ["escape-key", "outside-press"]) {
    const attempt = details(reason);
    let changed = false;
    handleDialogOpenChange(false, attempt.value, false, 1_000, 10_000, () => { changed = true; });
    assert.equal(attempt.cancelled(), true, reason);
    assert.equal(changed, false, reason);
  }
});

test("programmatic close requests are not delayed", () => {
  const attempt = details("imperative-action");
  const changes: boolean[] = [];
  handleDialogOpenChange(false, attempt.value, true, 1_000, 1_001, (open) => changes.push(open));
  assert.equal(attempt.cancelled(), false);
  assert.deepEqual(changes, [false]);
});
