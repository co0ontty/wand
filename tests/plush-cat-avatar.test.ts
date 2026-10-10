import assert from "node:assert/strict";
import test from "node:test";
import { encodePlushCatAvatar, parsePlushCatAvatar, resolveEmployeeAvatar, resolvePlushAvatar } from "../src/plush-avatar.js";

test("only the two explicit versioned cat coats parse and round-trip", () => {
  for (const coat of ["silver", "orange"] as const) {
    const value = `plush-cat:v1:${coat}`;
    const config = parsePlushCatAvatar(value);
    assert.deepEqual(config, { version: 1, kind: "cat", coat });
    assert.equal(encodePlushCatAvatar(config!), value);
  }
  for (const value of ["plush-cat:v2:silver", "plush-cat:v1:black", "plush-cat:v1:silver:hat", "plush-cat:v1:orange ", "cat:0", "data:image/png;base64,AA=="]) {
    assert.equal(parsePlushCatAvatar(value), null);
  }
});

test("cat exceptions do not convert source legacy pixels, photos or ordinary geometric defaults", () => {
  assert.equal(resolveEmployeeAvatar({ id: "huajie", avatar: "cat:1" }), null);
  assert.equal(resolveEmployeeAvatar({ id: "shiyi", avatar: "cat:0" }), null);
  assert.equal(resolveEmployeeAvatar({ id: "photo", avatar: "data:image/png;base64,AA==" }), null);
  assert.deepEqual(resolveEmployeeAvatar({ id: "ordinary" }), resolvePlushAvatar({ id: "ordinary" }));
  assert.deepEqual(resolveEmployeeAvatar({ id: "explicit", avatar: "plush-cat:v1:silver" }), { version: 1, kind: "cat", coat: "silver" });
  assert.notEqual(resolvePlushAvatar({ id: "existing-picker", avatar: "plush-cat:v1:silver" }), null);
});
