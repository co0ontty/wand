import assert from "node:assert/strict";
import test from "node:test";
import { studyClusters, studyDisplay, type StudyTime } from "./overlap-layout.js";

test("same-time triggers use different columns but do not invent end times", () => {
  const items = ["a", "b"].map(key => ({ key, start: 540 })), before = structuredClone(items);
  const [group] = studyClusters(items), display = studyDisplay(group, 184);
  assert.equal(group.lanes, 2); assert.equal(display.visible.length, 2); assert.equal(display.hidden.length, 0);
  assert.deepEqual(display.visible.map(item => [item.lane, item.top, item.height]), [[0, 576, 44], [1, 576, 44]]);
  assert.deepEqual(items, before); assert.ok(display.visible.every(position => !("end" in position.item)));
});
test("partial overlap uses maximum concurrency, reuses an ended lane and restores later full width", () => {
  const groups = studyClusters([{ key: "a", start: 540, end: 600 }, { key: "b", start: 570, end: 630 }, { key: "c", start: 600, end: 660 }, { key: "later", start: 690, end: 750 }]);
  assert.equal(groups.length, 2); assert.equal(groups[0].lanes, 2);
  assert.deepEqual(groups[0].positions.map(position => [position.item.key, position.lane]), [["a", 0], ["b", 1], ["c", 0]]);
  assert.equal(studyDisplay(groups[1], 184).columns, 1);
});
test("nearby point markers avoid visual collision without claiming concurrent execution", () => {
  const [group] = studyClusters([{ key: "a", start: 540 }, { key: "b", start: 555 }]);
  assert.equal(group.lanes, 2); assert.ok(group.positions.every(position => !("end" in position.item)));
  assert.equal(group.positions[1].top - group.positions[0].top, 16);
});
test("dense groups reserve a readable +N column and every hidden event remains reachable", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ key: `task-${index}`, start: 540 }));
  const [group] = studyClusters(items), normal = studyDisplay(group, 184), wide = studyDisplay(group, 280), narrow = studyDisplay(group, 84);
  assert.equal(normal.columns, 2); assert.equal(normal.visible.length, 1); assert.equal(normal.hidden.length, 7);
  assert.equal(wide.columns, 3); assert.equal(wide.visible.length, 2); assert.equal(wide.hidden.length, 6);
  assert.equal(narrow.columns, 1); assert.equal(narrow.visible.length, 0); assert.equal(narrow.hidden.length, 8);
  assert.deepEqual([...normal.visible, ...normal.hidden].map(position => position.item.key).sort(), items.map(item => item.key));
});
test("stable tie order is independent of API array order and no rectangles collide", () => {
  const items = [{ key: "c", start: 540, end: 600 }, { key: "b", start: 540, end: 660 }, { key: "a", start: 540, end: 660 }, { key: "d", start: 600, end: 690 }];
  const original = studyClusters(items), reversed = studyClusters([...items].reverse());
  assert.deepEqual(original, reversed);
  for (const group of original) for (const a of group.positions) for (const b of group.positions) if (a.item.key !== b.item.key && a.lane === b.lane) assert.ok(a.top + a.height <= b.top || b.top + b.height <= a.top);
});
test("invalid and unbounded geometry is rejected rather than silently fabricated", () => {
  for (const items of [[{ key: "bad", start: NaN }], [{ key: "bad", start: 540, end: 500 }], [{ key: "bad", start: 1440 }], [{ key: "same", start: 540 }, { key: "same", start: 600 }]]) assert.throws(() => studyClusters(items));
  assert.throws(() => studyClusters(Array.from({ length: 1001 }, (_, i) => ({ key: String(i), start: 540 }))));
});
