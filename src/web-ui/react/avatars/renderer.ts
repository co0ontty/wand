import * as THREE from "three";
import { PLUSH_COLORS, isPlushCatAvatar, type PlushAvatarConfig, type PlushRenderConfig, type PlushCatAvatarConfig, type PlushShape } from "../../../plush-avatar.js";
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
  eyes: THREE.Mesh[];
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
  pigment?: (point: THREE.Vector3) => THREE.Color): THREE.BufferGeometry {
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
    const length = 0.030 + Math.pow(random(), 1.7) * 0.047;
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

/** Source-derived plush cat exceptions: actual inflated head, ears, eye sockets and embroidery. */
function createCatModel(config: PlushCatAvatarConfig, texture: THREE.Texture, preview: boolean): Model {
  const root = new THREE.Group();
  const silver = config.coat === "silver";
  const coat = new THREE.Color(silver ? "#9dabb8" : "#f49335");
  const dark = new THREE.Color(silver ? "#657789" : "#b85d18");
  const pale = new THREE.Color(silver ? "#ced6dc" : "#ffd29a");
  const pigment = new THREE.Color();
  const colorAt = (point: THREE.Vector3) => {
    const forehead = THREE.MathUtils.clamp((point.y - 0.15) * 0.55, 0, 0.3);
    const chin = THREE.MathUtils.clamp((-point.y - 0.1) * 0.45, 0, 0.35);
    return pigment.copy(coat).lerp(dark, forehead).lerp(pale, chin);
  };
  const surface = pillowGeometry("square");
  const position = surface.getAttribute("position");
  const colors: number[] = [];
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    position.setXYZ(i, position.getX(i) * 1.08, position.getY(i) * 0.86 - 0.10, position.getZ(i));
    const color = colorAt(point.fromBufferAttribute(position, i)); colors.push(color.r, color.g, color.b);
  }
  surface.computeVertexNormals(); surface.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  root.add(new THREE.Mesh(surface, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, bumpMap: texture, bumpScale: 0.023 })));
  root.add(new THREE.Mesh(fiberGeometry(surface, coat, configSeed(config), preview ? 28_000 : 4_500, colorAt),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
  const wool = (geometry: THREE.BufferGeometry, color: THREE.Color, count: number) => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 1, bumpMap: texture, bumpScale: 0.024 })));
    group.add(new THREE.Mesh(fiberGeometry(geometry, color, configSeed(config) + count, count),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
    return group;
  };
  for (const direction of [-1, 1]) {
    const ear = wool(pillowGeometry("triangle"), dark, preview ? 4_000 : 650);
    ear.scale.set(0.30, 0.38, 0.40); ear.position.set(direction * 0.64, 0.69, -0.015); ear.rotation.z = direction * -0.12;
    root.add(ear);
    const inner = wool(pillowGeometry("triangle"), coat.clone().lerp(pale, 0.12), preview ? 1_800 : 300);
    inner.scale.set(0.19, 0.27, 0.11); inner.position.set(direction * 0.64, 0.69, 0.25); inner.rotation.z = direction * -0.12;
    root.add(inner);
  }
  const eyes: THREE.Mesh[] = [];
  const sphere = () => new THREE.SphereGeometry(1, 28, 20);
  for (const x of [-0.32, 0.32]) {
    const white = new THREE.Mesh(sphere(), new THREE.MeshStandardMaterial({ color: "#faf8ee", roughness: 0.56 }));
    white.position.set(x, 0.12, 0.635); white.scale.set(0.18, 0.145, 0.045); white.userData.restY = 0.145; root.add(white); eyes.push(white);
    const pupil = new THREE.Mesh(sphere(), new THREE.MeshPhysicalMaterial({ color: silver ? "#3e8b59" : "#25211d", roughness: 0.28, clearcoat: 0.35 }));
    pupil.position.set(x + Math.sign(x) * -0.027, 0.13, 0.679); pupil.scale.set(0.094, 0.108, 0.024); pupil.userData.restY = 0.108; root.add(pupil); eyes.push(pupil);
    if (silver) {
      const slit = new THREE.Mesh(sphere(), new THREE.MeshStandardMaterial({ color: "#1f3e2b", roughness: 0.5 }));
      slit.position.set(pupil.position.x, 0.13, 0.700); slit.scale.set(0.019, 0.088, 0.009); slit.userData.restY = 0.088; root.add(slit); eyes.push(slit);
    }
    const shine = new THREE.Mesh(sphere(), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    shine.position.set(pupil.position.x - 0.024, 0.174, 0.707); shine.scale.set(0.017, 0.025, 0.005); shine.userData.restY = 0.025;
    root.add(shine); eyes.push(shine);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 16), new THREE.MeshStandardMaterial({ color: "#ee889a", roughness: 0.68 }));
  nose.position.set(0, -0.145, 0.660); nose.scale.set(0.112, 0.063, 0.035); root.add(nose);
  const embroidery = new THREE.MeshStandardMaterial({ color: silver ? "#607183" : "#b16a29", roughness: 1 });
  root.add(tube([new THREE.Vector3(0, -0.18, 0.679), new THREE.Vector3(0, -0.255, 0.681)], 0.013, embroidery));
  const smile = tube([new THREE.Vector3(-0.15, -0.27, 0.672), new THREE.Vector3(-0.08, -0.31, 0.675),
    new THREE.Vector3(0, -0.255, 0.681), new THREE.Vector3(0.08, -0.31, 0.675), new THREE.Vector3(0.15, -0.27, 0.672)], 0.013, embroidery);
  root.add(smile);
  const mouth = new THREE.Mesh(sphere(), new THREE.MeshStandardMaterial({ color: "#492c2b", roughness: 0.9 }));
  mouth.position.set(0, -0.30, 0.677); mouth.scale.set(0.085, 0.032, 0.021); mouth.visible = false; root.add(mouth);
  for (const direction of [-1, 1]) {
    for (let stripe = 0; stripe < 2; stripe++) {
      const marking = wool(new THREE.SphereGeometry(1, 20, 14), dark, preview ? 700 : 160);
      marking.scale.set(0.055, 0.11, 0.020); marking.rotation.z = direction * -0.36;
      marking.position.set(direction * (0.68 + stripe * 0.12), -0.24 + stripe * 0.075, 0.49 - stripe * 0.10); root.add(marking);
    }
  }
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
      lastFrame: 0, phase: configSeed(options.config) % 1000 / 100, frames: 0, activity: "", tiltX: 0, tiltY: 0 };
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
      update: next => { registration.options = next; registration.dirty = true; this.schedule(); },
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
    const frameKey = `${key}:${pixels}`;
    if (item.canvas.width !== pixels) { item.canvas.width = pixels; item.canvas.height = pixels; }
    const cached = time === 0 ? this.frames.get(frameKey) : undefined;
    if (cached) { item.context.clearRect(0, 0, pixels, pixels); item.context.drawImage(cached, 0, 0); }
    else {
      let model = this.models.get(key);
      if (!model) {
        model = isPlushCatAvatar(config) ? createCatModel(config, this.texture!, item.options.interactive || size >= 96)
          : createModel(config, this.texture!, item.options.interactive || size >= 96); this.models.set(key, model);
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
      model.root.position.y = isPlushCatAvatar(config) ? -0.03 : config.hat === "none" ? 0 : -0.13;
      const blinkPhase = (phase + item.phase) % 5.4;
      const blink = time && !reducedMotion && blinkPhase < 0.16 ? Math.max(0.12, Math.abs(blinkPhase - 0.08) / 0.08) : 1;
      for (const eye of model.eyes) eye.scale.y = (eye.userData.restY ?? 0.086) * blink;
      const talking = speaking && !reducedMotion && time !== 0;
      model.mouth.visible = talking; model.smile.visible = !talking;
      model.mouth.scale.y = 0.032 + (talking ? (Math.sin(phase * 13) * 0.5 + 0.5) * 0.053 : 0);
      if (talking) model.root.rotation.x += Math.sin(phase * 8) * 0.025;
      this.scene.add(model.root);
      this.renderer!.setSize(pixels, pixels, false); this.renderer!.render(this.scene, this.camera);
      this.scene.remove(model.root);
      item.context.clearRect(0, 0, pixels, pixels); item.context.drawImage(this.renderer!.domElement, 0, 0, pixels, pixels);
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
