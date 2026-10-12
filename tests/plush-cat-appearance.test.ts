import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { plushCatAppearance, catHeadWidthAt, catFaceDepth, catCoatWeights, CAT_MARKINGS } from "../src/plush-cat-appearance.js";
import { parsePlushCatAvatar, encodePlushCatAvatar, resolveEmployeeAvatar } from "../src/plush-avatar.js";
import { PlushAvatar } from "../src/web-ui/react/avatars/plush-avatar.js";

test("stable cat identities carry hand-sculpted individual proportions, not generic recolours", () => {
  const huniu = plushCatAppearance({ coat: "silver" }), chuer = plushCatAppearance({ coat: "orange" });
  assert.equal(huniu.breed, "sculpted-huniu"); assert.equal(chuer.breed, "sculpted-chuer");
  assert.equal(huniu.pattern, "silver-tabby"); assert.equal(chuer.pattern, "brown-tabby-white");
  assert.ok(chuer.furLength > huniu.furLength);
  assert.ok(chuer.head[0] > huniu.head[0]); assert.ok(chuer.head[2] < huniu.head[2]);
  assert.ok(chuer.ear[1] < huniu.ear[1]); assert.ok(chuer.cheekDepth > huniu.cheekDepth);
  assert.ok(chuer.eyeY - chuer.noseY < huniu.eyeY - huniu.noseY);
  assert.ok(chuer.eyeUpper < chuer.eyeLower, "Chuer has a hooded gaze, not round toy eyes");
  for (const coat of ["silver", "orange"] as const) {
    const value = `plush-cat:v1:${coat}`, config = parsePlushCatAvatar(value)!;
    assert.equal(encodePlushCatAvatar(config), value);
  }
  assert.equal((resolveEmployeeAvatar({ id: "e_wand_default", systemKey: "wand-default", avatar: "cat:1" }) as { coat: string }).coat, "silver");
  assert.equal((resolveEmployeeAvatar({ id: "e_wand_ops", systemKey: "wand-ops", avatar: "cat:0" }) as { coat: string }).coat, "orange");
});

test("narrower faces retain a broad chin cap and a smooth cheek-to-jaw curve", () => {
  const huniu = plushCatAppearance({ coat: "silver" }), chuer = plushCatAppearance({ coat: "orange" });
  assert.ok(huniu.head[0] <= 0.92); assert.ok(chuer.head[0] <= 0.98);
  for (const profile of [huniu, chuer]) {
    const cheekY = -0.25 * profile.head[1] - 0.045;
    const lowerY = -0.82 * profile.head[1] - 0.045;
    assert.ok(catHeadWidthAt(profile, lowerY) / catHeadWidthAt(profile, cheekY) > 0.97,
      "lower contour must not abruptly taper under a wider cheek bulge");
    const theta = Math.PI - 0.015;
    const y = Math.cos(theta) * profile.head[1] - 0.045;
    const x = Math.sin(theta) * catHeadWidthAt(profile, y);
    const capRadius = x * x / (2 * (y + profile.head[1] + 0.045));
    assert.ok(capRadius > 0.95, "the chin needs a rounded cap, not a V-shaped tip");
    for (let normalized = -0.9; normalized <= 0.8; normalized += 0.04) {
      const at = normalized * profile.head[1] - 0.045, step = 0.002;
      const outline = (y: number) => catHeadWidthAt(profile, y) * Math.sqrt(1 - ((y + 0.045) / profile.head[1]) ** 2);
      const curvature = (outline(at + step) - 2 * outline(at) + outline(at - step)) / (step * step);
      assert.ok(Number.isFinite(curvature) && curvature < 0, "actual cheek/chin silhouette stays convex without an inward notch");
    }
  }
});

test("middle-only narrowing preserves the forehead and rounded chin", () => {
  for (const coat of ["silver", "orange"] as const) {
    const profile = plushCatAppearance({ coat });
    const priorWidth = (yn: number) => profile.head[0] * (1 + 0.025 * Math.exp(-(((yn + 0.12) / 0.82) ** 2)));
    const middle = catHeadWidthAt(profile, -0.045) / priorWidth(0);
    assert.ok(middle > 0.95 && middle < 0.97, "midface changes by a small, visible amount only");
    for (const yn of [-1, -0.90, -0.80, 0.80, 0.90, 1]) {
      assert.ok(Math.abs(catHeadWidthAt(profile, yn * profile.head[1] - 0.045) - priorWidth(yn)) < 1e-12,
        "upper and lower contours remain exactly unchanged");
    }
  }
});

test("continuous head sculpt recesses sockets and joins cheeks and muzzle to the same surface", () => {
  for (const coat of ["silver", "orange"] as const) {
    const profile = plushCatAppearance({ coat });
    const sphere = (x: number, y: number) => profile.head[2] * Math.sqrt(Math.max(0,
      1 - (x / catHeadWidthAt(profile, y)) ** 2 - ((y + 0.045) / profile.head[1]) ** 2));
    assert.ok(catFaceDepth(profile, profile.eyeX, profile.eyeY) < sphere(profile.eyeX, profile.eyeY));
    assert.ok(catFaceDepth(profile, 0.13, profile.muzzleY) > sphere(0.13, profile.muzzleY));
    for (let x = -1.2; x < 1.2; x += 0.04) for (let y = -1; y < 1; y += 0.04) {
      assert.ok(Number.isFinite(catFaceDepth(profile, x, y)));
    }
    assert.equal(catFaceDepth(profile, 2, 2), 0);
  }
});

test("authored coat markings colour fur without photographs or raster sampling", () => {
  for (const coat of ["silver", "orange"] as const) {
    assert.ok(CAT_MARKINGS[coat].length >= 6);
    for (const [x, y, z] of [[0, 0.6, 0.5], [0.8, 0, 0.5], [0, -0.55, 0.5], [2, 2, -1]]) {
      const weights = catCoatWeights(coat, x, y, z);
      assert.ok(Object.values(weights).every(v => Number.isFinite(v) && v >= 0 && v <= 1));
      assert.deepEqual(catCoatWeights(coat, x, y, z), weights);
    }
    assert.deepEqual(catCoatWeights(coat, 0, 0.4, -0.5), { white: 0, dark: 0 }, "unseen rear is neutral fur, not a wrapped photograph");
  }
  assert.ok(catCoatWeights("orange", 0, -0.6, 0.5).white > 0.9, "Chuer's lower jaw is white");
  assert.ok(catCoatWeights("orange", 0, 0.6, 0.5).white < 0.1, "Chuer's crown stays brown tabby");
  assert.ok(catCoatWeights("silver", -0.07, 0.43, 0.5).dark > 0.45, "Huniu's M mark is authored on her forehead");
  const renderer = readFileSync(new URL("../src/web-ui/react/avatars/renderer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /sampleCatPhoto|CAT_PHOTO|photo-field|data:image|TextureLoader/);
  assert.match(renderer, /catFaceDepth/); assert.match(renderer, /catCoatWeights/);
});

test("static cat fallback is vector-only and shares anatomical proportions and markings", () => {
  for (const coat of ["silver", "orange"] as const) {
    const config = parsePlushCatAvatar(`plush-cat:v1:${coat}`)!, profile = plushCatAppearance(config);
    const html = renderToStaticMarkup(React.createElement(PlushAvatar, { config, size: 72 }));
    assert.ok(html.includes(`data-avatar-breed="${profile.breed}"`));
    for (const color of [profile.coat, profile.pale, profile.iris, profile.nose]) assert.ok(html.includes(color), color);
    assert.doesNotMatch(html, /<image|<img|data:image|base64|\.jpg|\.png/);
    assert.match(html, /clipPath/); assert.match(html, /stroke-linecap="round"/);
  }
});

test("joined chin pads add side-profile volume below the lips without resizing either head", () => {
  for (const coat of ["silver", "orange"] as const) {
    const p = plushCatAppearance({ coat });
    assert.ok(p.chinY < p.mouthY - 0.12 && p.chinY > -p.head[1] + 0.15);
    const base = p.head[2] * Math.sqrt(1 - ((p.chinY + 0.045) / p.head[1]) ** 2);
    assert.ok(catFaceDepth(p, 0, p.chinY) - base > (coat === "orange" ? 0.10 : 0.06), "chin projects from the original head surface");
    const step = 0.0005;
    for (let y = p.mouthY; y >= p.chinY - 0.12; y -= 0.005) {
      const a = catFaceDepth(p, 0, y - step), b = catFaceDepth(p, 0, y + step);
      assert.ok(Math.abs(a - b) < 0.008, "mouth, chin and jaw share a continuous surface");
    }
    assert.equal(catFaceDepth(p, 0, -p.head[1] - 0.045), 0, "original chin boundary is retained");
  }
});
