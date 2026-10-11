export type CatWhiskerPoint = readonly [number, number, number];

/** Chuer's natural curls, hand-shaped from the reference: loose hooks and loops,
 * not identical spring coils. Coordinates are relative to the muzzle centre;
 * z offsets give the tips genuine depth rather than drawing a flat decoration.
 */
const CHUER_CURLS: readonly (readonly CatWhiskerPoint[])[] = [
  [[0.17, 0, 0], [0.47, 0.06, -0.02], [0.78, 0.22, -0.065], [1.035, 0.27, -0.10],
    [1.13, 0.19, -0.12], [1.07, 0.075, -0.132], [0.93, 0.11, -0.105], [0.96, 0.21, -0.078]],
  [[0.195, -0.013, 0], [0.50, -0.025, -0.03], [0.79, -0.09, -0.06], [1.04, -0.14, -0.105],
    [1.11, -0.27, -0.12], [1.03, -0.36, -0.10], [0.91, -0.32, -0.072], [0.94, -0.23, -0.062]],
  [[0.17, -0.026, 0], [0.39, -0.07, -0.015], [0.56, -0.18, -0.04], [0.73, -0.31, -0.08],
    [0.78, -0.44, -0.11], [0.68, -0.48, -0.097], [0.60, -0.39, -0.075]],
  [[0.195, -0.039, 0], [0.46, 0.06, -0.03], [0.66, 0.11, -0.04], [0.80, 0.035, -0.05],
    [0.78, -0.06, -0.06], [0.69, -0.09, -0.065]],
];

export function chuerWhiskerPoints(index: number, side: number): CatWhiskerPoint[] {
  const strand = CHUER_CURLS[index];
  if (!strand) throw new RangeError("Unknown Chuer whisker");
  const root = strand[0], right = side > 0;
  return strand.map(([x, y, z]) => [
    side * (root[0] + (x - root[0]) * (right ? 0.94 : 1)),
    root[1] + (y - root[1]) * (right ? index % 2 ? 0.85 : 1.08 : 1),
    z * (right ? 0.92 : 1),
  ]);
}

/** Uniform Catmull–Rom -> cubic Bezier: same curve as the 3D whisker, without
 * importing the GPU library into the static fallback's cold bundle.
 */
export function chuerWhiskerPath(index: number, side: number, muzzleY: number): string {
  const points = chuerWhiskerPoints(index, side);
  const xy = (p: CatWhiskerPoint) => `${50 + p[0] * 36} ${50 - (muzzleY + p[1]) * 36}`;
  let path = `M${xy(points[0])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const before = points[i - 1] ?? [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    const after = points[i + 2] ?? [2 * b[0] - a[0], 2 * b[1] - a[1], 2 * b[2] - a[2]];
    const c1: CatWhiskerPoint = [a[0] + (b[0] - before[0]) / 6, a[1] + (b[1] - before[1]) / 6, 0];
    const c2: CatWhiskerPoint = [b[0] - (after[0] - a[0]) / 6, b[1] - (after[1] - a[1]) / 6, 0];
    path += `C${xy(c1)} ${xy(c2)} ${xy(b)}`;
  }
  return path;
}
