import * as THREE from "three";
import { createFileProps } from "./file-props.js";
import { chuerWhiskerPoints } from "../../../plush-cat-whiskers.js";
import { plushCatAppearance, catHeadWidthAt, catFaceDepth, catCoatWeights } from "../../../plush-cat-appearance.js";
import { PLUSH_COLORS, isPlushCatAvatar, isPlushDogAvatar, type PlushAvatarConfig, type PlushRenderConfig, type PlushCatAvatarConfig, type PlushDogAvatarConfig, type PlushShape } from "../../../plush-avatar.js";
import type { PlushAvatarRuntime, PlushGlobals, PlushRenderOptions } from "./runtime-contract.js";

// One GPU context for the entire application. Individual identity canvases only
// receive copied frames; scrolling through hundreds of employees cannot exhaust
// browser context limits. Preview is 24fps, at most four small identities 8fps.
const MODEL_LIMIT = 8;
const FRAME_LIMIT = 80;
const MODEL_BYTES_LIMIT = 48 * 1024 * 1024;
const FRAME_BYTES_LIMIT = 16 * 1024 * 1024;
const ANIMATED_LIST_LIMIT = 4;
const ANIMATED_PREVIEW_LIMIT = 2;
const FRAME_BUDGET_MS = 12;
const MAX_PIXELS = 480;

interface Model {
  root: THREE.Group;
  fileProps?: ReturnType<typeof createFileProps>;
  eyes: THREE.Object3D[];
  smile: THREE.Mesh;
  mouth: THREE.Mesh;
  ready: boolean;
  preparing: boolean;
}
interface Registration {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  options: PlushRenderOptions;
  visible: boolean;
  dirty: boolean;
  lastFrame: number;
  phase: number;
  fileActivityStartedAt: number;
  frames: number;
  activity: string;
  tiltX: number;
  tiltY: number;
  state: Parameters<PlushAvatarRuntime["attach"]>[2];
}

function randomSource(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}
function configSeed(config: PlushRenderConfig): number {
  let hash = 2166136261;
  for (const char of JSON.stringify(config)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function contour(shape: PlushShape): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  if (shape === "triangle") {
    const path = new THREE.Shape();
    path.moveTo(-0.18, 0.93);
    path.quadraticCurveTo(0, 1.22, 0.18, 0.93);
    path.lineTo(0.87, -0.48);
    path.quadraticCurveTo(1.03, -0.8, 0.66, -0.83);
    path.quadraticCurveTo(0, -0.92, -0.66, -0.83);
    path.quadraticCurveTo(-1.03, -0.8, -0.87, -0.48);
    path.lineTo(-0.18, 0.93);
    return path.getSpacedPoints(128).slice(0, -1);
  }
  for (let step = 0; step < 128; step++) {
    const angle = step / 128 * Math.PI * 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    let x: number, y: number;
    if (shape === "heart") {
      x = 16 * Math.pow(sin, 3) / 17;
      y = (13 * cos - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle) + 2) / 17;
    } else if (shape === "square" || shape === "diamond" || shape === "capsule") {
      const exponent = shape === "capsule" ? 0.82 : shape === "diamond" ? 0.72 : 0.5;
      x = Math.sign(cos) * Math.pow(Math.abs(cos), exponent);
      y = Math.sign(sin) * Math.pow(Math.abs(sin), exponent);
      if (shape === "diamond") [x, y] = [(x - y) * 0.68, (x + y) * 0.68];
      if (shape === "square") { x *= 0.85; y *= 0.87; }
      if (shape === "capsule") { x *= 0.7; y *= 1.02; }
    } else { x = cos * 0.93; y = sin * 0.96; }
    points.push(new THREE.Vector2(x, y));
  }
  return points;
}

/** A closed, softly inflated volume, not an extruded flat icon. */
function pillowGeometry(shape: PlushShape): THREE.BufferGeometry {
  const outline = contour(shape);
  const rings = 48, segments = outline.length;
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const latitude = -Math.PI / 2 + (ring / rings) * Math.PI;
    const scale = Math.max(0.0001, Math.cos(latitude));
    for (let segment = 0; segment <= segments; segment++) {
      const point = outline[segment % segments];
      positions.push(point.x * scale, point.y * scale, Math.sin(latitude) * 0.60);
      uv.push(segment / segments, ring / rings);
      if (ring < rings && segment < segments) {
        const a = ring * (segments + 1) + segment;
        const b = a + segments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Heart/triangle contours use the opposite winding to superellipses.
  const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
  let outward = 0;
  for (let i = 0; i < position.count; i++) outward += position.getZ(i) * normal.getZ(i);
  if (outward < 0) {
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    geometry.setIndex(indices); geometry.computeVertexNormals();
  }
  return geometry;
}

function woolTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const random = randomSource(8447);
  context.fillStyle = "#a6a6a6"; context.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 22_000; i++) {
    const x = random() * 256, y = random() * 256;
    const shade = Math.round(90 + random() * 130);
    context.strokeStyle = `rgb(${shade},${shade},${shade})`;
    context.lineWidth = 0.5;
    context.beginPath(); context.moveTo(x, y); context.lineTo(x + random() * 3 - 1.5, y + random() * 5); context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2); return texture;
}

/** Thousands of actual tapered, bent 3D strands create a soft irregular silhouette. */
function fiberGeometry(surface: THREE.BufferGeometry, color: THREE.Color, seed: number, count: number,
  pigment?: (point: THREE.Vector3) => THREE.Color,
  lengthScale: number | ((point: THREE.Vector3) => number) = 1): THREE.BufferGeometry {
  const random = randomSource(seed);
  const positions = surface.getAttribute("position"), normals = surface.getAttribute("normal");
  const index = surface.getIndex()!;
  const cumulative: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(positions, index.getX(i)); b.fromBufferAttribute(positions, index.getX(i + 1)); c.fromBufferAttribute(positions, index.getX(i + 2));
    area += b.clone().sub(a).cross(c.clone().sub(a)).length() * 0.5;
    cumulative.push(area);
  }
  const vertices: number[] = [], shades: number[] = [], strandNormals: number[] = [];
  const normal = new THREE.Vector3(), n2 = new THREE.Vector3(), n3 = new THREE.Vector3();
  const tangent = new THREE.Vector3(), side = new THREE.Vector3();
  for (let strand = 0; strand < count; strand++) {
    const sample = random() * area;
    let low = 0, high = cumulative.length - 1;
    while (low < high) { const middle = (low + high) >>> 1; if (cumulative[middle] < sample) low = middle + 1; else high = middle; }
    const i = low * 3, ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2);
    let u = random(), v = random(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    a.fromBufferAttribute(positions, ia); b.fromBufferAttribute(positions, ib); c.fromBufferAttribute(positions, ic);
    const root = a.multiplyScalar(1 - u - v).addScaledVector(b, u).addScaledVector(c, v);
    normal.fromBufferAttribute(normals, ia).multiplyScalar(1 - u - v);
    n2.fromBufferAttribute(normals, ib); n3.fromBufferAttribute(normals, ic);
    normal.addScaledVector(n2, u).addScaledVector(n3, v).normalize();
    tangent.set(random() * 0.5 - 0.25, -1, random() * 0.5 - 0.25);
    tangent.addScaledVector(normal, -tangent.dot(normal)).normalize();
    side.crossVectors(normal, tangent).normalize();
    const length = (0.030 + Math.pow(random(), 1.7) * 0.047) * (typeof lengthScale === "number" ? lengthScale : lengthScale(root));
    const width = 0.0017 + random() * 0.0018;
    const middle = root.clone().addScaledVector(normal, length * 0.6).addScaledVector(tangent, length * 0.30);
    const tip = root.clone().addScaledVector(normal, length * 0.85).addScaledVector(tangent, length * 0.70);
    const left = root.clone().addScaledVector(side, width);
    const right = root.clone().addScaledVector(side, -width);
    const midLeft = middle.clone().addScaledVector(side, width * 0.65);
    const midRight = middle.clone().addScaledVector(side, -width * 0.65);
    const variation = 0.70 + random() * 0.38;
    const strandColor = pigment?.(root) ?? color;
    [left, right, midLeft, right, midRight, midLeft, midLeft, midRight, tip].forEach((point, vertex) => {
      vertices.push(point.x, point.y, point.z);
      strandNormals.push(normal.x, normal.y, normal.z);
      // Dark roots / softly lit tips give the pile depth, rather than a smooth
      // sphere with monochrome surface noise. The taper remains real geometry.
      const brightness = variation * (vertex === 8 ? 1.24 : vertex < 2 || vertex === 3 ? 0.78 : 1.08);
      shades.push(strandColor.r * brightness, strandColor.g * brightness, strandColor.b * brightness);
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(strandNormals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(shades, 3));
  geometry.computeBoundingSphere(); return geometry;
}

function tube(points: THREE.Vector3[], radius: number, material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, radius, 6, false), material);
}

/** Sculpted individual cats. Photographs are references, never render inputs. */
function createCatModel(config: PlushCatAvatarConfig, texture: THREE.Texture, preview: boolean): Model {
  const root = new THREE.Group(), profile = plushCatAppearance(config), silver = config.coat === "silver";
  const coat = new THREE.Color(profile.coat), dark = new THREE.Color(profile.dark), pale = new THREE.Color(profile.pale);
  const pigment = new THREE.Color();
  const colorAt = (point: THREE.Vector3) => {
    const weights = catCoatWeights(config.coat, point.x, point.y, point.z);
    return pigment.copy(coat).lerp(dark, weights.dark).lerp(pale, weights.white);
  };
  const groom = (point: THREE.Vector3) => {
    const eyeDistance = Math.hypot((Math.abs(point.x) - profile.eyeX) / (profile.eyeWidth + 0.025), (point.y - profile.eyeY) / (profile.eyeUpper + 0.025));
    if (point.z > 0.30 && eyeDistance < 1.3) return 0.13;
    if (point.z > 0.25 && Math.abs(point.x) < 0.42 && point.y < profile.mouthY + 0.06 && point.y > profile.chinY - 0.19) {
      return profile.furLength * (silver ? 0.46 : 0.40);
    }
    if (point.z > 0.37 && Math.abs(point.x) < 0.30 && point.y > -0.34) return 0.32;
    return profile.furLength * (point.y < -0.35 ? 1.34 : Math.abs(point.x) > 0.65 ? 1.36 : 0.70);
  };
  // A single continuous anatomical head carries the brow, recessed sockets,
  // cheek pads, nose bridge and chin. No overlaid circular "cheek stickers".
  const surface = new THREE.SphereGeometry(1, 96, 72), positions = surface.getAttribute("position");
  const colors: number[] = [], point = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i) * profile.head[1] - 0.045;
    const x = positions.getX(i) * catHeadWidthAt(profile, y);
    const z = positions.getZ(i) >= 0 ? catFaceDepth(profile, x, y) : positions.getZ(i) * profile.head[2];
    positions.setXYZ(i, x, y, z);
    const color = colorAt(point.fromBufferAttribute(positions, i)); colors.push(color.r, color.g, color.b);
  }
  surface.computeVertexNormals(); surface.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  root.add(new THREE.Mesh(surface, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, bumpMap: texture, bumpScale: 0.014 })));
  root.add(new THREE.Mesh(fiberGeometry(surface, coat, configSeed(config), preview ? 29_000 : 4_700, colorAt, groom),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));

  const wool = (geometry: THREE.BufferGeometry, color: THREE.Color, count: number, length: number) => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 1, bumpMap: texture, bumpScale: 0.018 })));
    group.add(new THREE.Mesh(fiberGeometry(geometry, color, configSeed(config) + count, count, undefined, length),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
    return group;
  };
  for (const side of [-1, 1]) {
    const earGeometry = pillowGeometry("triangle"), earPositions = earGeometry.getAttribute("position");
    for (let i = 0; i < earPositions.count; i++) {
      const z = earPositions.getZ(i);
      if (z > 0) earPositions.setZ(i, z - 0.14 * Math.exp(-((earPositions.getX(i) / 0.63) ** 2) - ((earPositions.getY(i) + 0.08) / 0.73) ** 2) * (z / 0.60));
    }
    earGeometry.computeVertexNormals();
    const ear = wool(earGeometry, coat.clone().lerp(dark, silver ? 0.08 : 0.20), preview ? 2_300 : 430, profile.furLength);
    ear.scale.set(profile.ear[0], profile.ear[1], profile.ear[2]);
    ear.position.set(side * profile.earX, profile.earY, -0.035); ear.rotation.z = side * -0.28; root.add(ear);
    const inner = wool(pillowGeometry("triangle"), new THREE.Color(profile.innerEar), preview ? 850 : 160, silver ? 0.7 : 1.5);
    inner.scale.set(profile.ear[0] * 0.59, profile.ear[1] * 0.64, 0.08);
    inner.position.set(side * profile.earX, profile.earY - 0.02, 0.10); inner.rotation.z = side * -0.28; root.add(inner);
  }

  const eyes: THREE.Object3D[] = [];
  const irisBase = new THREE.Color(profile.iris), irisEdge = new THREE.Color(silver ? "#52674e" : "#687247");
  const black = new THREE.Color("#152018");
  for (const side of [-1, 1]) {
    const group = new THREE.Group();
    const x = side * profile.eyeX, y = profile.eyeY;
    group.position.set(x, y, 0); group.userData.restY = 1;
    const vertices: number[] = [], indices: number[] = [], shades: number[] = [], workShades: number[] = [];
    const segments = 64, rings = 20;
    const eyeColor = new THREE.Color();
    const boundary = (theta: number, ratio: number) => {
      const cosine = Math.cos(theta), sine = Math.sin(theta);
      const localX = profile.eyeWidth * cosine * ratio;
      const localY = Math.sign(sine) * Math.pow(Math.abs(sine), 0.82)
        * (sine >= 0 ? profile.eyeUpper : profile.eyeLower) * ratio + side * cosine * 0.018 * ratio;
      // The almond rim follows the sculpted socket, so lids cannot bury the
      // visible iris inside the surrounding brow or float as a separate sphere.
      const rimX = profile.eyeWidth * cosine;
      const rimY = Math.sign(sine) * Math.pow(Math.abs(sine), 0.82)
        * (sine >= 0 ? profile.eyeUpper : profile.eyeLower) + side * cosine * 0.018;
      const rimDepth = catFaceDepth(profile, x + rimX, y + rimY) + 0.012;
      const centreDepth = catFaceDepth(profile, x, y) + 0.115;
      return new THREE.Vector3(localX, localY, THREE.MathUtils.lerp(centreDepth, rimDepth, ratio * ratio));
    };
    for (let ring = 0; ring <= rings; ring++) {
      const radius = Math.max(0.0001, ring / rings);
      for (let segment = 0; segment <= segments; segment++) {
        const angle = segment / segments * Math.PI * 2, p = boundary(angle, radius);
        vertices.push(p.x, p.y, p.z);
        const pupilDistance = Math.hypot((p.x + side * 0.008) / profile.pupilWidth, p.y / profile.pupilHeight);
        const pupilBlend = THREE.MathUtils.smoothstep(pupilDistance, 0.96, 1.10);
        const radialVariation = (Math.sin(angle * 31) + Math.sin(angle * 47)) * 0.025;
        eyeColor.copy(irisBase).lerp(irisEdge, Math.min(1, radius * radius * 0.75 + 0.05 + radialVariation));
        eyeColor.lerp(black, 1 - pupilBlend);
        if (radius > 0.93) eyeColor.lerp(black, THREE.MathUtils.smoothstep(radius, 0.93, 1));
        shades.push(eyeColor.r, eyeColor.g, eyeColor.b);
        const downward = Math.hypot((p.x + side * 0.008) / profile.pupilWidth, (p.y + 0.038) / profile.pupilHeight);
        eyeColor.copy(irisBase).lerp(irisEdge, Math.min(1, radius * radius * 0.75 + 0.05 + radialVariation));
        eyeColor.lerp(black, 1 - THREE.MathUtils.smoothstep(downward, 0.96, 1.10));
        if (radius > 0.93) eyeColor.lerp(black, THREE.MathUtils.smoothstep(radius, 0.93, 1));
        workShades.push(eyeColor.r, eyeColor.g, eyeColor.b);
        if (ring < rings && segment < segments) {
          const a = ring * (segments + 1) + segment, b = a + segments + 1;
          indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(shades, 3));
    group.userData.eyeGeometry = geometry;
    group.userData.restColors = geometry.getAttribute("color");
    group.userData.workColors = new THREE.Float32BufferAttribute(workShades, 3);
    geometry.setIndex(indices); geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.40, clearcoat: 0.18, side: THREE.DoubleSide })));
    const shine = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: "#f5f2df" }));
    shine.position.set(-0.041, 0.048, catFaceDepth(profile, x, y) + 0.117); shine.scale.set(0.011, 0.017, 0.004); group.add(shine);
    const lid = new THREE.MeshStandardMaterial({ color: silver ? "#8d9588" : "#7f7460", roughness: 1 });
    const upper: THREE.Vector3[] = [], lower: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      upper.push(boundary(i / 16 * Math.PI, 1));
      lower.push(boundary(Math.PI + i / 16 * Math.PI, 1));
    }
    group.add(tube(upper, silver ? 0.009 : 0.015, lid));
    group.add(tube(lower, 0.008, new THREE.MeshStandardMaterial({ color: silver ? "#dadcd1" : "#b7aa8b", roughness: 1 })));
    root.add(group); eyes.push(group);
  }

  const noseZ = catFaceDepth(profile, 0, profile.noseY) + 0.022;
  const noseShape = new THREE.Shape(), w = profile.noseWidth, h = profile.noseHeight;
  noseShape.moveTo(-w, h * 0.4); noseShape.quadraticCurveTo(0, h * 0.65, w, h * 0.4);
  noseShape.quadraticCurveTo(w * 0.9, -h * 0.06, 0, -h * 0.7);
  noseShape.quadraticCurveTo(-w * 0.9, -h * 0.06, -w, h * 0.4);
  // A convex rounded nose needs only a small bevel ring, not the general
  // extrusion/triangulation machinery in the optional avatar download.
  const rim = noseShape.getSpacedPoints(32).slice(0, -1), noseVertices = [0, 0, 0.021, 0, 0, -0.012], noseIndices: number[] = [];
  for (const point of rim) noseVertices.push(point.x, point.y, 0, point.x * 0.84, point.y * 0.84, 0.016);
  for (let i = 0; i < rim.length; i++) {
    const outer = 2 + i * 2, inner = outer + 1, next = 2 + ((i + 1) % rim.length) * 2;
    noseIndices.push(0, next + 1, inner, 1, outer, next, outer, inner, next + 1, outer, next + 1, next);
  }
  const noseGeometry = new THREE.BufferGeometry();
  noseGeometry.setAttribute("position", new THREE.Float32BufferAttribute(noseVertices, 3));
  noseGeometry.setIndex(noseIndices); noseGeometry.computeVertexNormals();
  const nose = new THREE.Mesh(noseGeometry, new THREE.MeshStandardMaterial({ color: profile.nose, roughness: 0.60 }));
  nose.position.set(0, profile.noseY, noseZ); root.add(nose);
  const thread = new THREE.MeshStandardMaterial({ color: silver ? "#53443c" : "#665344", roughness: 1 });
  for (const side of [-1, 1]) {
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), thread);
    nostril.position.set(side * w * 0.67, profile.noseY + 0.004, noseZ + 0.031);
    nostril.scale.set(w * 0.20, h * 0.11, 0.006); root.add(nostril);
  }
  const facePoint = (x: number, y: number) => new THREE.Vector3(x, y, catFaceDepth(profile, x, y) + 0.026);
  root.add(tube([new THREE.Vector3(0, profile.noseY - h * 0.6, noseZ + 0.02), facePoint(0, profile.mouthY + 0.035)], 0.008, thread));
  const smile = tube([facePoint(-0.11, profile.mouthY), facePoint(-0.06, profile.mouthY + 0.01),
    facePoint(0, profile.mouthY + 0.035), facePoint(0.06, profile.mouthY + 0.01), facePoint(0.11, profile.mouthY)], 0.008, thread); root.add(smile);
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshStandardMaterial({ color: "#3e302c", roughness: 0.9 }));
  mouth.position.copy(facePoint(0, profile.mouthY)); mouth.scale.set(0.067, 0.032, 0.014); mouth.visible = false; root.add(mouth);
  const whisker = new THREE.MeshStandardMaterial({ color: "#eae5d8", roughness: 0.9 });
  for (const side of [-1, 1]) for (let n = 0; n < 4; n++) {
    const startY = profile.muzzleY - 0.013 * n;
    const point = facePoint(side * (0.17 + 0.025 * (n % 2)), startY);
    if (silver) {
      root.add(tube([point, new THREE.Vector3(side * 0.63, startY + 0.115 - n * 0.061, point.z - 0.035),
        new THREE.Vector3(side * (0.97 + (n % 2) * 0.09), startY + 0.19 - n * 0.13, point.z - 0.18)], 0.0025, whisker));
    } else {
      const points = chuerWhiskerPoints(n, side).map(([x, y, z]) => new THREE.Vector3(x, profile.muzzleY + y, point.z + z));
      const curl = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
      root.add(new THREE.Mesh(new THREE.TubeGeometry(curl, 64, 0.0032, 6, false), whisker));
    }
    if (n < 3) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), thread);
      dot.position.copy(facePoint(side * (0.16 + n * 0.043), profile.muzzleY + 0.005 - n * 0.018)); root.add(dot);
    }
  }
  return { root, eyes, smile, mouth, ready: false, preparing: false };
}

/** Shiba identity: upright ears, cream muzzle, black nose and a knitted red scarf. */
function createDogModel(config: PlushDogAvatarConfig, texture: THREE.Texture, preview: boolean): Model {
  const root = new THREE.Group(), eyes: THREE.Mesh[] = [];
  const coat = new THREE.Color("#cb803f"), cream = new THREE.Color("#fff0da");
  const wool = (geometry: THREE.BufferGeometry, color: THREE.Color, count: number) => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 1, bumpMap: texture, bumpScale: 0.025 })));
    group.add(new THREE.Mesh(fiberGeometry(geometry, color, configSeed(config) + count, count),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
    return group;
  };
  const head = wool(pillowGeometry("square"), coat, preview ? 28_000 : 4_500);
  head.scale.set(1.03, 0.81, 1); head.position.y = 0.02; root.add(head);
  for (const side of [-1, 1]) {
    const ear = wool(pillowGeometry("triangle"), coat, preview ? 3_000 : 500);
    ear.scale.set(0.27, 0.36, 0.35); ear.position.set(side * 0.61, 0.74, 0); ear.rotation.z = side * -0.12; root.add(ear);
    const inner = wool(pillowGeometry("triangle"), cream.clone().lerp(coat, 0.35), preview ? 900 : 180);
    inner.scale.set(0.15, 0.23, 0.08); inner.position.set(side * 0.61, 0.76, 0.23); inner.rotation.z = side * -0.12; root.add(inner);
    const cheek = wool(new THREE.SphereGeometry(1, 32, 20), cream, preview ? 2_500 : 450);
    cheek.scale.set(0.47, 0.34, 0.18); cheek.position.set(side * 0.36, -0.32, 0.51); root.add(cheek);
    const brow = wool(new THREE.SphereGeometry(1, 20, 12), cream, preview ? 600 : 120);
    brow.scale.set(0.095, 0.045, 0.025); brow.position.set(side * 0.31, 0.34, 0.60); root.add(brow);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshPhysicalMaterial({ color: "#29201b", roughness: 0.25, clearcoat: 0.4 }));
    eye.scale.set(0.065, 0.085, 0.035); eye.position.set(side * 0.32, 0.18, 0.63); eye.userData.restY = 0.085; root.add(eye); eyes.push(eye);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 8), new THREE.MeshBasicMaterial({ color: "#fffdfa" }));
    shine.position.set(side * 0.32 - 0.018, 0.21, 0.659); root.add(shine);
  }
  const muzzle = wool(new THREE.SphereGeometry(1, 32, 20), cream, preview ? 3_000 : 500);
  muzzle.scale.set(0.35, 0.27, 0.22); muzzle.position.set(0, -0.23, 0.61); root.add(muzzle);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshPhysicalMaterial({ color: "#29201b", roughness: 0.45 }));
  nose.scale.set(0.11, 0.074, 0.06); nose.position.set(0, -0.12, 0.82); root.add(nose);
  const thread = new THREE.MeshStandardMaterial({ color: "#66402b", roughness: 1 });
  root.add(tube([new THREE.Vector3(0, -0.18, 0.84), new THREE.Vector3(0, -0.29, 0.85)], 0.012, thread));
  const smile = tube([new THREE.Vector3(-0.16, -0.30, 0.81), new THREE.Vector3(0, -0.36, 0.85), new THREE.Vector3(0.16, -0.30, 0.81)], 0.013, thread); root.add(smile);
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: "#492c2b" }));
  mouth.position.set(0, -0.33, 0.84); mouth.scale.set(0.09, 0.034, 0.02); mouth.visible = false; root.add(mouth);
  const scarfMaterial = new THREE.MeshStandardMaterial({ color: "#c43f3b", roughness: 1, bumpMap: texture, bumpScale: 0.035 });
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.63, 0.105, 16, 64), scarfMaterial);
  scarf.rotation.x = Math.PI / 2; scarf.scale.set(1, 0.68, 1); scarf.position.y = -0.66; root.add(scarf);
  const end = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.25, 8, 16), scarfMaterial);
  end.position.set(0.46, -0.84, 0.38); end.rotation.z = -0.25; end.scale.z = 0.30; root.add(end);
  return { root, eyes, smile, mouth, ready: false, preparing: false };
}

function createModel(config: PlushAvatarConfig, texture: THREE.Texture, preview: boolean): Model {
  const root = new THREE.Group();
  const color = new THREE.Color(PLUSH_COLORS.find(option => option.id === config.color)!.color);
  const surface = pillowGeometry(config.shape);
  root.add(new THREE.Mesh(surface, new THREE.MeshStandardMaterial({ color, roughness: 1, bumpMap: texture, bumpScale: 0.022 })));
  root.add(new THREE.Mesh(fiberGeometry(surface, color, configSeed(config), preview ? 28_000 : 4_500), new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, side: THREE.DoubleSide,
  })));
  const black = new THREE.MeshPhysicalMaterial({ color: "#161413", roughness: 0.29, clearcoat: 0.3 });
  const eyes = [-0.30, 0.30].map(x => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), black);
    eye.position.set(x, 0.035, 0.645); eye.scale.set(0.056, 0.086, 0.042); root.add(eye); return eye;
  });
  const smile = tube([
    new THREE.Vector3(-0.105, -0.22, 0.665), new THREE.Vector3(0, -0.277, 0.675), new THREE.Vector3(0.105, -0.22, 0.665),
  ], 0.017, new THREE.MeshStandardMaterial({ color: "#221a18", roughness: 0.65 }));
  root.add(smile);
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: "#39201d", roughness: 0.8 }));
  mouth.position.set(0, -0.23, 0.672); mouth.scale.set(0.089, 0.048, 0.019); mouth.visible = false; root.add(mouth);
  if (config.glasses !== "none") {
    const material = new THREE.MeshStandardMaterial({ color: config.glasses === "gold" ? "#bd985c" : "#2b2622",
      metalness: config.glasses === "gold" ? 0.78 : 0.12, roughness: 0.32 });
    const radius = config.glasses === "gold" ? 0.013 : 0.028;
    for (const x of [-0.30, 0.30]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.232, radius, 10, 56), material);
      rim.position.set(x, 0.045, 0.733); root.add(rim);
      root.add(tube([new THREE.Vector3(x + Math.sign(x) * 0.232, 0.065, 0.733),
        new THREE.Vector3(Math.sign(x) * 0.73, 0.08, 0.53), new THREE.Vector3(Math.sign(x) * 0.80, 0.06, 0.20)], radius, material));
    }
    root.add(tube([new THREE.Vector3(-0.066, 0.06, 0.733), new THREE.Vector3(0, 0.10, 0.748), new THREE.Vector3(0.066, 0.06, 0.733)], radius, material));
  }
  if (config.hat !== "none") {
    const hat = new THREE.Group();
    const top = config.shape === "heart" ? 0.79 : config.shape === "triangle" ? 0.94 : config.shape === "diamond" ? 1.05 : 0.91;
    const material = new THREE.MeshStandardMaterial({ color: config.hat === "beanie" ? "#bd6844" : "#e4d9bd",
      roughness: 1, bumpMap: texture, bumpScale: 0.045 });
    const fibers = (mesh: THREE.Mesh, count: number) => {
      const pile = new THREE.Mesh(fiberGeometry(mesh.geometry, new THREE.Color(material.color), configSeed(config) + 41, count),
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
      pile.position.copy(mesh.position); pile.scale.copy(mesh.scale); pile.rotation.copy(mesh.rotation); hat.add(pile);
    };
    if (config.hat === "beanie") {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), material);
      dome.scale.set(0.79, 0.53, 0.64); dome.position.y = top - 0.18; hat.add(dome);
      if (preview) fibers(dome, 5_000);
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.73, 0.095, 12, 64), material);
      cuff.rotation.x = Math.PI / 2; cuff.scale.y = 0.83; cuff.position.y = top - 0.17; hat.add(cuff);
      for (let i = 0; i < 40; i++) {
        const angle = i / 40 * Math.PI * 2;
        const points: THREE.Vector3[] = [];
        for (let n = 0; n <= 10; n++) {
          const latitude = n / 10 * Math.PI * 0.46;
          points.push(new THREE.Vector3(Math.cos(angle) * Math.cos(latitude) * 0.798,
            top - 0.18 + Math.sin(latitude) * 0.54, Math.sin(angle) * Math.cos(latitude) * 0.65));
        }
        hat.add(tube(points, 0.012, material));
      }
      const pomGeometry = new THREE.SphereGeometry(0.145, 24, 16);
      const pom = new THREE.Mesh(pomGeometry, material); pom.position.set(0, top + 0.43, 0); hat.add(pom);
      fibers(pom, preview ? 1_400 : 350);
    } else {
      const beret = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
      beret.scale.set(0.87, 0.22, 0.70); beret.position.set(0.04, top - 0.015, 0); hat.add(beret);
      if (preview) fibers(beret, 5_000);
      const trim = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.04, 10, 56), material);
      trim.rotation.x = Math.PI / 2; trim.scale.y = 0.83; trim.position.y = top - 0.13; hat.add(trim);
      hat.add(tube([new THREE.Vector3(0.14, top + 0.16, 0), new THREE.Vector3(0.14, top + 0.27, 0),
        new THREE.Vector3(0.19, top + 0.30, 0)], 0.031, material));
    }
    hat.rotation.z = config.hat === "beret" ? -0.17 : 0.10; root.add(hat);
  }
  return { root, eyes, smile, mouth, ready: false, preparing: false };
}

function disposeModel(model: Model): void {
  const materials = new Set<THREE.Material>();
  model.root.traverse(object => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
}

function modelBytes(model: Model): number {
  let bytes = 0;
  model.root.traverse(object => {
    if (object instanceof THREE.Mesh) {
      for (const name of Object.keys(object.geometry.attributes)) {
        const attribute = object.geometry.getAttribute(name);
        bytes += attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array.byteLength : attribute.array.byteLength;
      }
      bytes += object.geometry.getIndex()?.array.byteLength ?? 0;
    }
  });
  return bytes;
}

class PlushEngine implements PlushAvatarRuntime {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1.40, 1.40, 1.48, -1.32, 0.1, 20);
  private texture: THREE.CanvasTexture | null = null;
  private registrations = new Set<Registration>();
  private models = new Map<string, Model>();
  private frames = new Map<string, HTMLCanvasElement>();
  private timer = 0;
  private observer: IntersectionObserver;
  private lost = false;
  private blocked = false;
  private totalFrames = 0;
  private maxRenderMs = 0;
  private renderMs = 0;
  private createdContexts = 0;
  private contextGeneration = 0;
  private maxCompileWaitMs = 0;
  private releaseTimer = 0;

  constructor() {
    this.camera.position.set(0.12, 0.14, 5); this.camera.lookAt(0, 0.05, 0);
    this.scene.add(new THREE.HemisphereLight(0xfff7ea, 0xb1a99f, 1.7));
    this.scene.add(new THREE.AmbientLight(0xfff9f1, 0.72));
    const lights: [number, number, number, number, number][] = [
      [0xfff3df, 2.7, -3, 4, 4], [0xeaf2ff, 1.5, 3, 1, 2], [0xffffff, 2.2, 0, 3, -3],
    ];
    for (const [color, intensity, x, y, z] of lights) { const light = new THREE.DirectionalLight(color, intensity); light.position.set(x, y, z); this.scene.add(light); }
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) for (const registration of this.registrations) {
        if (registration.canvas === entry.target) { registration.visible = entry.isIntersecting; registration.dirty = true; }
      }
      this.schedule();
    });
    document.addEventListener("visibilitychange", () => {
      window.clearTimeout(this.timer); this.timer = 0;
      if (document.hidden) { for (const item of this.registrations) this.setState(item, "paused"); }
      else { for (const item of this.registrations) item.dirty = true; this.schedule(); }
    });
    (globalThis as PlushGlobals).__wandPlushDiagnostics = () => ({
      webglBlocked: this.blocked, contexts: this.renderer ? 1 : 0, createdContexts: this.createdContexts, registrations: this.registrations.size,
      visible: [...this.registrations].filter(item => item.visible).length,
      animated: [...this.registrations].filter(item => item.activity === "active").length,
      frames: this.totalFrames, renderMs: this.renderMs, maxRenderMs: this.maxRenderMs,
      models: this.models.size, cachedFrames: this.frames.size, hidden: document.hidden, contextLost: this.lost,
      geometryBytes: [...this.models.values()].reduce((sum, model) => sum + modelBytes(model), 0),
      cachedFrameBytes: [...this.frames.values()].reduce((sum, frame) => sum + frame.width * frame.height * 4, 0),
      maxCompileWaitMs: this.maxCompileWaitMs,
      reducedMotion: [...this.registrations].every(item => item.options.reducedMotion),
    });
  }

  private init(): boolean {
    if (this.blocked) return false;
    if (this.renderer) return !this.lost;
    try {
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true,
        powerPreference: "low-power" });
      renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.domElement.addEventListener("webglcontextlost", event => {
        if (this.renderer !== renderer) return;
        event.preventDefault(); this.lost = true; this.contextGeneration++;
        for (const model of this.models.values()) { model.ready = false; model.preparing = false; }
        window.clearTimeout(this.timer); this.timer = 0;
        for (const item of this.registrations) item.state("fallback", "fallback", "context-lost");
      });
      renderer.domElement.addEventListener("webglcontextrestored", () => {
        if (this.renderer !== renderer) return;
        this.lost = false; this.frames.clear();
        for (const item of this.registrations) { item.dirty = true; item.activity = ""; }
        this.schedule();
      });
      this.renderer = renderer; this.lost = false; this.createdContexts++; this.contextGeneration++; this.texture = woolTexture(); return true;
    } catch { this.blocked = true; return false; }
  }

  attach(canvas: HTMLCanvasElement, options: PlushRenderOptions, state: Registration["state"]): ReturnType<PlushAvatarRuntime["attach"]> {
    window.clearTimeout(this.releaseTimer);
    const context = canvas.getContext("2d", { alpha: true });
    if (!context || !this.init()) { state("fallback", "fallback", !context ? "canvas-unavailable" : this.lost ? "context-lost" : "webgl-unavailable"); return { update() {}, dispose() {} }; }
    const registration: Registration = { canvas, context, options, state, visible: false, dirty: true,
      lastFrame: 0, phase: configSeed(options.config) % 1000 / 100, frames: 0, activity: "", fileActivityStartedAt: performance.now() / 1000, tiltX: 0, tiltY: 0 };
    this.registrations.add(registration); this.observer.observe(canvas);
    const pointer = (event: PointerEvent) => {
      if (!registration.options.interactive || registration.options.reducedMotion) return;
      const rect = canvas.getBoundingClientRect();
      registration.tiltX = ((event.clientX - rect.left) / rect.width - 0.5) * 0.30;
      registration.tiltY = ((event.clientY - rect.top) / rect.height - 0.5) * 0.16;
      registration.dirty = true; this.schedule();
    };
    const reset = () => { registration.tiltX = registration.tiltY = 0; registration.dirty = true; this.schedule(); };
    // Listen on the stable wrapper; visual canvases themselves do not intercept product buttons.
    const parent = canvas.parentElement;
    parent?.addEventListener("pointermove", pointer); parent?.addEventListener("pointerleave", reset);
    return {
      update: next => {
        if (next.fileActivity !== registration.options.fileActivity) registration.fileActivityStartedAt = performance.now() / 1000;
        registration.options = next; registration.dirty = true; this.schedule(); },
      dispose: () => {
        this.registrations.delete(registration); this.observer.unobserve(canvas);
        parent?.removeEventListener("pointermove", pointer); parent?.removeEventListener("pointerleave", reset);
        if (!this.registrations.size) {
          window.clearTimeout(this.timer); this.timer = 0;
          this.releaseTimer = window.setTimeout(() => {
            if (this.registrations.size) return;
            for (const model of this.models.values()) disposeModel(model); this.models.clear(); this.frames.clear();
            this.texture?.dispose(); this.texture = null;
            this.renderer?.dispose(); this.renderer?.forceContextLoss(); this.renderer = null; this.lost = false;
          }, 5000);
        }
      },
    };
  }

  private setState(item: Registration, state: "active" | "static" | "paused"): void {
    if (item.activity === state) return;
    item.activity = state;
    if (item.frames) item.state("webgl", state);
  }
  private schedule(): void {
    if (this.timer || document.hidden || this.lost || !this.registrations.size) return;
    this.timer = window.setTimeout(() => { this.timer = 0; this.tick(); }, 16);
  }
  private tick(): void {
    if (document.hidden || this.lost || !this.renderer) return;
    const start = performance.now();
    let listAnimations = 0, previews = 0, more = false;
    const items = [...this.registrations].sort((a, b) => Number(b.options.interactive) - Number(a.options.interactive)
      || Number(b.options.fileActivity !== undefined && b.options.fileActivity !== "idle") - Number(a.options.fileActivity !== undefined && a.options.fileActivity !== "idle")
      || Number(b.options.thinking) - Number(a.options.thinking)
      || Number(b.options.speaking) - Number(a.options.speaking));
    for (const item of items) {
      if (!item.visible || !item.canvas.isConnected) { this.setState(item, "paused"); continue; }
      const animate = !item.options.reducedMotion && (item.options.interactive
        ? previews++ < ANIMATED_PREVIEW_LIMIT : listAnimations++ < ANIMATED_LIST_LIMIT);
      this.setState(item, animate ? "active" : "static");
      if (!item.dirty && (!animate || start - item.lastFrame < (item.options.interactive ? 1000 / 24 : 125))) {
        more ||= animate; continue;
      }
      if (performance.now() - start > FRAME_BUDGET_MS) { more = true; continue; }
      try { this.render(item, animate ? start / 1000 : 0); }
      catch { item.state("fallback", "fallback", "render-failed"); item.dirty = false; item.visible = false; }
      more ||= animate;
    }
    if (more) this.schedule();
  }

  private render(item: Registration, time: number): void {
    const start = performance.now();
    try { this.paint(item, time); }
    finally {
      this.renderMs = performance.now() - start; this.maxRenderMs = Math.max(this.maxRenderMs, this.renderMs);
    }
  }

  private paint(item: Registration, time: number): void {
    const { config, size, reducedMotion, speaking } = item.options;
    const pixels = Math.min(MAX_PIXELS, Math.max(24, Math.round(size * Math.min(window.devicePixelRatio || 1, 2))));
    const key = `${JSON.stringify(config)}:${item.options.interactive || size >= 96 ? "preview" : "list"}`;
    const fileActivity = item.options.fileActivity ?? "idle";
    const frameKey = `${key}:${pixels}:${fileActivity}`;
    if (item.canvas.width !== pixels) { item.canvas.width = pixels; item.canvas.height = pixels; }
    const cached = time === 0 ? this.frames.get(frameKey) : undefined;
    if (cached) { item.context.clearRect(0, 0, pixels, pixels); item.context.drawImage(cached, 0, 0); }
    else {
      let model = this.models.get(key);
      if (!model) {
        model = isPlushDogAvatar(config) ? createDogModel(config, this.texture!, item.options.interactive || size >= 96)
          : isPlushCatAvatar(config) ? createCatModel(config, this.texture!, item.options.interactive || size >= 96)
          : createModel(config, this.texture!, item.options.interactive || size >= 96); model.fileProps = createFileProps(config, this.texture!, (surface, color) =>
            fiberGeometry(surface, color, configSeed(config) + 47, size >= 96 ? 1400 : 360, undefined, 0.18)); model.root.add(model.fileProps.root); this.models.set(key, model);
        while (this.models.size > MODEL_LIMIT || (this.models.size > 1
          && [...this.models.values()].reduce((sum, entry) => sum + modelBytes(entry), 0) > MODEL_BYTES_LIMIT)) {
          const oldest = this.models.entries().next().value!;
          this.scene.remove(oldest[1].root); disposeModel(oldest[1]); this.models.delete(oldest[0]);
        }
      } else { this.models.delete(key); this.models.set(key, model); }
      if (!model.ready) {
        if (!model.preparing) {
          model.preparing = true;
          const renderer = this.renderer!;
          const generation = this.contextGeneration;
          const compileStart = performance.now();
          // Give supported GPUs parallel shader compilation instead of forcing
          // synchronous driver compilation into the first visible animation frame.
          void renderer.compileAsync(model.root, this.camera, this.scene).then(() => {
            if (this.renderer !== renderer || generation !== this.contextGeneration || this.models.get(key) !== model) return;
            model.ready = true; model.preparing = false;
            this.maxCompileWaitMs = Math.max(this.maxCompileWaitMs, performance.now() - compileStart);
            this.schedule();
          }, () => {
            if (this.models.get(key) === model) { model.preparing = false; item.visible = false; item.state("fallback", "fallback", "shader-compile-failed"); }
          });
        }
        return;
      }
      const phase = time ? time + item.phase : 0;
      model.root.rotation.set(time ? Math.sin(phase * 0.57) * 0.035 + item.tiltY : 0,
        -0.085 + (time ? Math.sin(phase * 0.65) * 0.10 + item.tiltX : 0), time ? Math.sin(phase * 0.47) * 0.025 : 0);
      model.root.position.y = isPlushDogAvatar(config) ? 0.03 : isPlushCatAvatar(config) ? -0.03 : config.hat === "none" ? 0 : -0.13;
      model.fileProps?.pose(fileActivity, time ? Math.max(0, time - item.fileActivityStartedAt) : 0);
      if (fileActivity !== "idle") {
        model.root.rotation.x = 0.14 + (time ? Math.sin(phase * 1.9) * 0.012 : 0);
        model.root.rotation.y = -0.045 + (time ? Math.sin(phase * 1.9) * 0.018 : 0);
        model.root.rotation.z = time ? Math.sin(phase * 1.9) * 0.008 : 0;
      }
      const blinkPhase = (phase + item.phase) % 5.4;
      const blink = time && !reducedMotion && blinkPhase < 0.16 ? Math.max(0.12, Math.abs(blinkPhase - 0.08) / 0.08) : 1;
      for (const eye of model.eyes) {
        eye.scale.y = (eye.userData.restY ?? 0.086) * blink;
        if (eye.userData.eyeGeometry) {
          eye.userData.eyeGeometry.setAttribute("color", fileActivity === "idle" ? eye.userData.restColors : eye.userData.workColors);
        } else {
          eye.userData.restPositionY ??= eye.position.y;
          eye.position.y = eye.userData.restPositionY - (fileActivity === "idle" ? 0 : 0.025);
        }
      }
      const talking = speaking && !reducedMotion && time !== 0;
      model.mouth.visible = talking; model.smile.visible = !talking;
      model.mouth.scale.y = 0.032 + (talking ? (Math.sin(phase * 13) * 0.5 + 0.5) * 0.053 : 0);
      if (talking) model.root.rotation.x += Math.sin(phase * 8) * 0.025;
      // Hands and held objects keep their own pose while the head looks down.
      // Cancelling the parent turn avoids tilting the book toward the camera
      // or pushing its lower edge outside the identity canvas.
      model.fileProps?.root.quaternion.copy(model.root.quaternion).invert();
      this.scene.add(model.root);
      this.renderer!.setSize(pixels, pixels, false); this.renderer!.render(this.scene, this.camera);
      if (item.options.thinking && item.canvas.parentElement) {
        // Project the thought mark from the head's local upper-left anchor so it
        // follows the very same yaw, tilt and bob as the 3D face, without a RAF owner.
        const anchor = new THREE.Vector3(-0.83, 1.0, 0.1).applyMatrix4(model.root.matrixWorld).project(this.camera);
        item.canvas.parentElement.style.setProperty("--plush-thinking-x", `${(anchor.x + 1) * size / 2}px`);
        item.canvas.parentElement.style.setProperty("--plush-thinking-y", `${(1 - anchor.y) * size / 2}px`);
      }
      this.scene.remove(model.root);
      item.context.clearRect(0, 0, pixels, pixels); item.context.drawImage(this.renderer!.domElement, 0, 0, pixels, pixels);
      item.canvas.dataset.fileActivity = fileActivity;
      item.canvas.dataset.filePropPose = phase.toFixed(3);
      item.canvas.dataset.pageAngle = String(model.fileProps?.root.userData.pageAngle ?? 0);
      item.canvas.dataset.pageTurn = String(model.fileProps?.root.userData.pageTurn ?? 0);
      item.canvas.dataset.nibContact = String(model.fileProps?.root.userData.nibContact ?? 0);
      item.canvas.dataset.sceneRotation = model.root.rotation.y.toFixed(4);
      item.canvas.dataset.mouthScale = model.mouth.scale.y.toFixed(4);
      item.canvas.dataset.blink = blink.toFixed(3);
      if (time === 0) {
        const saved = document.createElement("canvas"); saved.width = saved.height = pixels;
        saved.getContext("2d")!.drawImage(item.canvas, 0, 0); this.frames.set(frameKey, saved);
        while (this.frames.size > FRAME_LIMIT || (this.frames.size > 1
          && [...this.frames.values()].reduce((sum, frame) => sum + frame.width * frame.height * 4, 0) > FRAME_BYTES_LIMIT)) {
          this.frames.delete(this.frames.keys().next().value!);
        }
      }
    }
    item.canvas.dataset.frame = String(++item.frames); this.totalFrames++;
    item.state("webgl", item.activity as "active" | "static" | "paused");
    item.dirty = false; item.lastFrame = performance.now();
  }
}

// Timed-out script requests can still execute late. Preserve the engine and its live handles.
(globalThis as PlushGlobals).__wandPlushRuntime ??= new PlushEngine();
