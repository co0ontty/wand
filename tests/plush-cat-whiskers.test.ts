import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatmullRomCurve3, Vector3 } from "three";
import { chuerWhiskerPath, chuerWhiskerPoints } from "../src/plush-cat-whiskers.js";
import { plushCatAppearance } from "../src/plush-cat-appearance.js";
import { parsePlushCatAvatar } from "../src/plush-avatar.js";
import { PlushAvatar } from "../src/web-ui/react/avatars/plush-avatar.js";

test("Chuer whiskers turn back into loose individual curls without moving their roots", () => {
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const points = chuerWhiskerPoints(i, side);
    assert.deepEqual(points[0], [side * (0.17 + 0.025 * (i % 2)), i ? -0.013 * i : 0, 0]);
    assert.ok(points.some((p, at) => at > 0 && Math.abs(p[0]) < Math.abs(points[at - 1][0])), "tips curl inward, not just fan outward");
    assert.ok(points.some(p => p[2] < -0.05), "real out-of-plane depth");
    assert.ok(points.every(p => p.every(Number.isFinite) && Math.abs(p[0]) < 1.2 && Math.abs(p[1]) < 0.55));
    assert.deepEqual(chuerWhiskerPoints(i, side), points, "stable shape, no render-time randomness");
  }
  assert.notDeepEqual(chuerWhiskerPoints(0, 1), chuerWhiskerPoints(0, -1).map(([x, y, z]) => [-x, y, z]), "not identical mirrored coils");
});

test("SVG curl is mathematically the same curve as its real 3D whisker", () => {
  const muzzle = plushCatAppearance({ coat: "orange" }).muzzleY;
  const cubic = (a: number, b: number, c: number, d: number, t: number) => (1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d;
  for (const side of [-1, 1]) for (let index = 0; index < 4; index++) {
    const points = chuerWhiskerPoints(index, side), curve = new CatmullRomCurve3(points.map(p => new Vector3(...p)), false, "catmullrom", 0.5);
    const parts = [...chuerWhiskerPath(index, side, muzzle).matchAll(/[MC]([^MC]+)/g)].map(match => match[1].trim().split(/\s+/).map(Number));
    assert.equal(parts.length, points.length);
    let start = parts[0];
    for (let segment = 0; segment < points.length - 1; segment++) {
      const [cx, cy, dx, dy, ex, ey] = parts[segment + 1];
      for (const t of [0.2, 0.5, 0.8]) {
        const p = curve.getPoint((segment + t) / (points.length - 1));
        assert.ok(Math.abs(cubic(start[0], cx, dx, ex, t) - (50 + p.x * 36)) < 1e-8);
        assert.ok(Math.abs(cubic(start[1], cy, dy, ey, t) - (50 - (muzzle + p.y) * 36)) < 1e-8);
      }
      start = [ex, ey];
    }
  }
});

test("only Chuer gets curly whiskers; Huniu retains her straight static whiskers", () => {
  const markup = (coat: string) => renderToStaticMarkup(React.createElement(PlushAvatar, {
    config: parsePlushCatAvatar(`plush-cat:v1:${coat}`)!, size: 72,
  }));
  const chuer = markup("orange"), huniu = markup("silver");
  assert.equal((chuer.match(/data-whisker="curly"/g) ?? []).length, 8);
  assert.doesNotMatch(chuer, /data-whisker="straight"/);
  assert.equal((huniu.match(/data-whisker="straight"/g) ?? []).length, 6);
  assert.doesNotMatch(huniu, /data-whisker="curly"/);
  assert.doesNotMatch(chuer + huniu, /<image|<img|data:image/);
});
