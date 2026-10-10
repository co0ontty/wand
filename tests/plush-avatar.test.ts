import test from "node:test";
import assert from "node:assert/strict";
import {
  PLUSH_COLORS, PLUSH_GLASSES, PLUSH_HATS, PLUSH_SHAPES,
  defaultPlushAvatar, encodePlushAvatar, parsePlushAvatar, resolvePlushAvatar,
  type PlushAvatarConfig,
} from "../src/plush-avatar.js";

test("plush defaults bind to stable employee identity without mutating the source", () => {
  const identity = Object.freeze({ id: "e_stable", name: "员工", avatar: "" });
  const original = defaultPlushAvatar(identity);
  assert.equal(encodePlushAvatar(original), "plush:v1:diamond:cream:ink:beanie", "v1 seed mapping is a cross-client contract");
  assert.deepEqual(defaultPlushAvatar({ ...identity, name: "改名" }), original);
  assert.deepEqual(resolvePlushAvatar(identity), original);
  assert.deepEqual(defaultPlushAvatar({ id: " e_stable ", name: "another" }), original);
  assert.equal(identity.avatar, "", "a derived default must never become a saved selection");
  assert.deepEqual(defaultPlushAvatar({ name: "新员工" }), defaultPlushAvatar({ id: null, name: " 新员工 " }));
  assert.deepEqual(defaultPlushAvatar({}), defaultPlushAvatar({ id: "", name: " " }));
});

test("v1 combinations round-trip and the option space is bounded", () => {
  let count = 0;
  for (const shape of PLUSH_SHAPES) for (const color of PLUSH_COLORS)
    for (const glasses of PLUSH_GLASSES) for (const hat of PLUSH_HATS) {
      const config: PlushAvatarConfig = {
        version: 1, shape: shape.id, color: color.id, glasses: glasses.id, hat: hat.id,
      };
      const encoded = encodePlushAvatar(config);
      assert.ok(encoded.length < 64);
      assert.deepEqual(parsePlushAvatar(encoded), config);
      assert.deepEqual(resolvePlushAvatar({ id: "other_employee", avatar: encoded }), config);
      count += 1;
    }
  assert.equal(count, 324);
  for (const option of PLUSH_COLORS) assert.match(option.color, /^#[0-9A-F]{6}$/);
});

test("the deterministic v1 seed produces varied valid shapes, colors and accessories", () => {
  const combinations = new Set<string>();
  const values = { shape: new Set<string>(), color: new Set<string>(), glasses: new Set<string>(), hat: new Set<string>() };
  for (let at = 0; at < 2048; at += 1) {
    const config = defaultPlushAvatar({ id: `e_${at}` });
    combinations.add(encodePlushAvatar(config));
    for (const field of ["shape", "color", "glasses", "hat"] as const) values[field].add(config[field]);
  }
  assert.ok(combinations.size > 300, `${combinations.size} distinct combinations`);
  assert.equal(values.shape.size, 6);
  assert.equal(values.color.size, 6);
  assert.equal(values.glasses.size, 3);
  assert.equal(values.hat.size, 3);
});

test("explicit configuration rejects unknown versions, unknown options and incomplete or extended strings", () => {
  for (const malformed of [
    "", "plush:v2:heart:coral:none:none", "plush:v01:heart:coral:none:none",
    "plush:v1:cat:coral:none:none", "plush:v1:heart:red:none:none",
    "plush:v1:heart:coral:round:none", "plush:v1:heart:coral:none:cap",
    "plush:v1:heart:coral:none", "plush:v1:heart:coral:none:none:extra",
    "plush:v1:heart:coral:none:none\n", " plush:v1:heart:coral:none:none",
    "https://example.com/face.png", "data:image/png;base64,AAA", "cat:1",
  ]) assert.equal(parsePlushAvatar(malformed), null, malformed);
  assert.throws(() => encodePlushAvatar({ version: 2, shape: "heart", color: "coral", glasses: "none", hat: "none" } as unknown as PlushAvatarConfig));
});

test("resolution preserves photos and explicit legacy cats, with a stable fallback for persisted corruption", () => {
  const identity = { id: "e_saved", name: "员工" };
  for (const avatar of ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB", "cat:0", "cat:99"]) {
    assert.equal(resolvePlushAvatar({ ...identity, avatar }), null, avatar);
  }
  for (const avatar of ["", "plush:v8:heart:coral:none:none", "plush:v1:broken", "unknown-old-value"]) {
    assert.deepEqual(resolvePlushAvatar({ ...identity, avatar }), defaultPlushAvatar(identity));
  }
});
