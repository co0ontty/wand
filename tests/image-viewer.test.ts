import assert from "node:assert/strict";
import test from "node:test";
import { imageViewerController as viewer } from "../src/web-ui/react/image-viewer/controller.js";

test("image groups preserve the clicked occurrence, normalize labels and reject unsafe sources", () => {
  viewer.close();
  const items = [{ src: "javascript:alert(1)" }, { src: " /one.png ", label: " first " },
    { src: "/one.png", label: "second occurrence" }, { src: "/three.png" }];
  assert.equal(viewer.openGroup(items, 2), true);
  items[2].src = "/changed.png";
  assert.deepEqual(viewer.getSnapshot(), { open: true, src: "/one.png", label: "second occurrence", current: 1,
    items: [{ src: "/one.png", label: "first" }, { src: "/one.png", label: "second occurrence" }, { src: "/three.png", label: "图片" }] });
  const before = viewer.getSnapshot();
  for (const current of [-1, 3, 0.5]) viewer.select(current);
  assert.equal(viewer.getSnapshot(), before);
  assert.equal(viewer.openGroup([{ src: "javascript:alert(1)" }]), false);
  assert.equal(viewer.getSnapshot(), before, "invalid open does not replace the active gallery");
  viewer.select(2);
  assert.equal(viewer.getSnapshot().src, "/three.png");
  assert.equal(viewer.closeIfOpen(), true);
  assert.deepEqual(viewer.getSnapshot().items, []);
  viewer.select(0);
  assert.equal(viewer.isOpen(), false);
});

test("single-image callers retain the same controller and close protocol", () => {
  assert.equal(viewer.open("data:image/png;base64,AAAA", "single"), true);
  assert.equal(viewer.getSnapshot().items.length, 1);
  assert.equal(viewer.getSnapshot().label, "single");
  viewer.close();
  assert.equal(viewer.closeIfOpen(), false);
});

test("a delayed gallery close cannot return focus after another gallery opens", () => {
  let returned = 0;
  try {
    viewer.openGroup([{ src: "/first.png" }], 0, () => { returned++; });
    viewer.close();
    assert.equal(returned, 0, "focus waits for the preview leave animation");
    viewer.openGroup([{ src: "/second.png" }], 0, () => { returned++; });
    viewer.afterClosed();
    assert.equal(returned, 0, "the first leave completion cannot interrupt the new gallery");
    viewer.close();
    viewer.afterClosed();
    assert.equal(returned, 1);
    viewer.afterClosed();
    assert.equal(returned, 1, "the return lease settles only once");
  } finally { viewer.close(); }
});
