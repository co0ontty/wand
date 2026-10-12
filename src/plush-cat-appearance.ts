import type { PlushCatAvatarConfig } from "./plush-avatar.js";

/** Hand-sculpted proportions and coat markings observed across the seven references.
 * No image samples, UV photograph, raster data, or background colours live here.
 * The legacy "orange" code is an identity, not a command to recolour 初二 orange.
 */
export const PLUSH_CAT_APPEARANCES = {
  silver: {
    breed: "sculpted-huniu", pattern: "silver-tabby", coat: "#bdc2c0", dark: "#535d5b", pale: "#ece9e1",
    iris: "#819374", innerEar: "#c8b3ad", nose: "#a27667",
    head: [0.90, 0.85, 0.58], ear: [0.26, 0.34, 0.32], earX: 0.58, earY: 0.65,
    eyeX: 0.335, eyeY: 0.11, eyeWidth: 0.204, eyeUpper: 0.152, eyeLower: 0.139,
    pupilWidth: 0.086, pupilHeight: 0.120, cheekDepth: 0.036,
    noseY: -0.205, noseWidth: 0.101, noseHeight: 0.074, muzzleY: -0.315, mouthY: -0.375,
    chinY: -0.535, chinDepth: 0.065, chinWidth: 0.265, chinHeight: 0.16, jawDepth: 0.018, muzzleDepth: 0.089,
    furLength: 0.67,
  },
  orange: {
    breed: "sculpted-chuer", pattern: "brown-tabby-white", coat: "#81735c", dark: "#37382e", pale: "#e9e3d5",
    iris: "#929d6d", innerEar: "#b6a18e", nose: "#a77f76",
    head: [0.96, 0.78, 0.455], ear: [0.245, 0.21, 0.31], earX: 0.62, earY: 0.62,
    eyeX: 0.365, eyeY: 0.075, eyeWidth: 0.193, eyeUpper: 0.105, eyeLower: 0.128,
    pupilWidth: 0.065, pupilHeight: 0.104, cheekDepth: 0.069,
    noseY: -0.055, noseWidth: 0.081, noseHeight: 0.052, muzzleY: -0.18, mouthY: -0.277,
    chinY: -0.445, chinDepth: 0.115, chinWidth: 0.29, chinHeight: 0.17, jawDepth: 0.025, muzzleDepth: 0.086,
    furLength: 1.62,
  },
} as const;

export type CatSculpt = (typeof PLUSH_CAT_APPEARANCES)[keyof typeof PLUSH_CAT_APPEARANCES];
export type CatMarking = { points: ReadonlyArray<readonly [number, number]>; width: number; opacity: number };

/** Brush-free polylines define the individual M/crown/cheek markings on the fur itself.
 * Zero-width tapered ends prevent badge-like stripes. Shared by 3D fur and SVG fallback.
 */
export const CAT_MARKINGS: Record<PlushCatAvatarConfig["coat"], readonly CatMarking[]> = {
  silver: [
    { points: [[-0.04, 0.75], [-0.10, 0.61], [-0.07, 0.43], [-0.045, 0.28]], width: 0.035, opacity: 0.82 },
    { points: [[0.06, 0.74], [0.105, 0.59], [0.07, 0.41], [0.04, 0.27]], width: 0.032, opacity: 0.76 },
    { points: [[-0.37, 0.67], [-0.32, 0.54], [-0.25, 0.43], [-0.205, 0.32]], width: 0.035, opacity: 0.58 },
    { points: [[0.36, 0.67], [0.31, 0.52], [0.24, 0.43], [0.20, 0.32]], width: 0.034, opacity: 0.57 },
    { points: [[-0.30, 0.55], [-0.19, 0.575], [-0.10, 0.50]], width: 0.026, opacity: 0.51 },
    { points: [[0.30, 0.55], [0.19, 0.56], [0.10, 0.49]], width: 0.025, opacity: 0.49 },
    { points: [[-0.49, 0.04], [-0.65, -0.015], [-0.80, 0.02], [-0.90, 0.095]], width: 0.040, opacity: 0.67 },
    { points: [[0.49, 0.04], [0.66, -0.02], [0.80, 0.02], [0.90, 0.09]], width: 0.040, opacity: 0.67 },
    { points: [[-0.57, -0.16], [-0.72, -0.19], [-0.90, -0.12]], width: 0.035, opacity: 0.50 },
    { points: [[0.57, -0.16], [0.73, -0.19], [0.90, -0.12]], width: 0.035, opacity: 0.50 },
  ],
  orange: [
    { points: [[-0.035, 0.71], [-0.09, 0.55], [-0.045, 0.37], [-0.075, 0.22]], width: 0.067, opacity: 0.90 },
    { points: [[0.04, 0.72], [0.105, 0.55], [0.065, 0.35], [0.09, 0.19]], width: 0.067, opacity: 0.90 },
    { points: [[-0.38, 0.68], [-0.34, 0.53], [-0.26, 0.40], [-0.20, 0.29]], width: 0.062, opacity: 0.75 },
    { points: [[0.37, 0.68], [0.33, 0.52], [0.27, 0.39], [0.21, 0.29]], width: 0.060, opacity: 0.74 },
    { points: [[-0.33, 0.54], [-0.20, 0.565], [-0.11, 0.46]], width: 0.048, opacity: 0.62 },
    { points: [[0.32, 0.535], [0.19, 0.545], [0.12, 0.46]], width: 0.045, opacity: 0.61 },
    { points: [[-0.55, 0.33], [-0.70, 0.23], [-0.93, 0.27]], width: 0.065, opacity: 0.64 },
    { points: [[0.55, 0.33], [0.71, 0.23], [0.94, 0.27]], width: 0.065, opacity: 0.64 },
    { points: [[-0.53, -0.04], [-0.71, -0.12], [-0.97, -0.065]], width: 0.068, opacity: 0.69 },
    { points: [[0.53, -0.04], [0.72, -0.10], [0.97, -0.045]], width: 0.062, opacity: 0.64 },
  ],
};

export function plushCatAppearance(config: Pick<PlushCatAvatarConfig, "coat">): CatSculpt {
  return PLUSH_CAT_APPEARANCES[config.coat];
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const soft = (lo: number, hi: number, value: number) => {
  const x = clamp((value - lo) / (hi - lo));
  return x * x * (3 - 2 * x);
};
const bump = (x: number, y: number, cx: number, cy: number, sx: number, sy: number) =>
  Math.exp(-(((x - cx) / sx) ** 2) - ((y - cy) / sy) ** 2);

/** One broad, shallow cheek curve continues into a rounded chin.
 * A local cheek bulge followed by a separate taper creates a diamond-shaped
 * jaw; keep the lower oval intact instead. Mesh, sockets and SVG share this curve.
 */
export function catHeadWidthAt(profile: CatSculpt, y: number): number {
  const yn = (y + 0.045) / profile.head[1];
  // The middle inset has zero slope and curvature at both ends, leaving
  // the forehead/chin untouched without introducing a cheek notch.
  const middle = Math.max(0, 1 - (yn / 0.80) ** 2) ** 3;
  return profile.head[0] * (1 + 0.025 * Math.exp(-(((yn + 0.12) / 0.82) ** 2)) - 0.038 * middle);
}

/** Sculpted front surface: recessed eye sockets, brows, nose bridge and joined muzzle. */
export function catFaceDepth(profile: CatSculpt, x: number, y: number): number {
  const ellipse = 1 - (x / catHeadWidthAt(profile, y)) ** 2 - ((y + 0.045) / profile.head[1]) ** 2;
  const base = profile.head[2] * Math.sqrt(Math.max(0, ellipse));
  if (ellipse <= 0) return 0;
  const mask = soft(0, 0.19, base);
  const eyes = bump(Math.abs(x), y, profile.eyeX, profile.eyeY, 0.205, 0.15);
  const brows = bump(Math.abs(x), y, profile.eyeX, profile.eyeY + 0.17, 0.255, 0.09);
  const muzzle = bump(Math.abs(x), y, 0.115, profile.muzzleY, 0.195, 0.16);
  const bridge = bump(x, y, 0, (profile.eyeY + profile.noseY) / 2, 0.115, 0.19);
  // A joined lower lip, chin pad and lateral jaw, rather than a separate ball.
  // The existing ellipse and boundary mask still own the overall head bounds.
  const chin = bump(x, y, 0, profile.chinY, profile.chinWidth, profile.chinHeight);
  const jaw = bump(Math.abs(x), y, 0.32, profile.chinY + 0.025, 0.23, 0.21);
  const lowerLip = bump(x, y, 0, profile.mouthY - 0.025, 0.15, 0.035);
  const cheeks = bump(Math.abs(x), y, 0.57, -0.17, 0.31, 0.28);
  return base + mask * (-0.082 * eyes + 0.034 * brows + profile.muzzleDepth * muzzle
    + (profile.breed === "sculpted-huniu" ? 0.080 : 0.026) * bridge + profile.cheekDepth * cheeks
    + profile.chinDepth * chin + profile.jawDepth * jaw - 0.024 * lowerLip);
}

export function catCoatWeights(coat: PlushCatAvatarConfig["coat"], x: number, y: number, z: number) {
  const profile = PLUSH_CAT_APPEARANCES[coat], front = soft(-0.04, 0.35, z);
  let marking = 0;
  for (const stroke of CAT_MARKINGS[coat]) {
    for (let i = 1; i < stroke.points.length; i++) {
      const [ax, ay] = stroke.points[i - 1], [bx, by] = stroke.points[i];
      const dx = bx - ax, dy = by - ay, t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
      const progress = (i - 1 + t) / (stroke.points.length - 1);
      const taper = 0.32 + 0.68 * Math.sin(Math.PI * progress);
      const distance = Math.hypot(x - ax - dx * t, y - ay - dy * t);
      marking = Math.max(marking, (1 - soft(stroke.width * taper * 0.3, stroke.width * taper, distance)) * stroke.opacity);
    }
  }
  const muzzle = bump(x, y, 0, profile.muzzleY - 0.065, coat === "orange" ? 0.43 : 0.40, 0.23);
  const chin = 1 - soft(-0.48, -0.25, y);
  const blaze = coat === "orange" ? bump(x - 0.025, y, 0, -0.008, 0.075, 0.20) * 0.90 : 0;
  const white = clamp(Math.max(chin * (coat === "orange" ? 1 : 0.72), muzzle * 0.94, blaze)) * front;
  const eyeMask = bump(Math.abs(x), y, profile.eyeX, profile.eyeY - 0.015, 0.25, 0.20);
  const browShade = soft(0.15, 0.80, y) * (coat === "orange" ? 0.17 : 0.09);
  const dark = clamp(Math.max(marking, eyeMask * (coat === "orange" ? 0.51 : 0.16)) + browShade) * front * (1 - white * 0.84);
  return { white, dark };
}
