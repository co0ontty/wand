import * as THREE from "three";
import { plushCatAppearance } from "../../../plush-cat-appearance.js";
import { PLUSH_COLORS, isPlushCatAvatar, type PlushRenderConfig } from "../../../plush-avatar.js";
import type { AvatarFileActivity } from "../../composer-avatar-activity.js";

const PAGE_WIDTH = 0.55;
const PAGE_HEIGHT = 0.45;
const PAGE_COLUMNS = 24;
const PAGE_ROWS = 10;
const PAGE_THICKNESS = 0.007;
const TURN_PERIOD = 3.2;
const smooth = (value: number) => { const n = THREE.MathUtils.clamp(value, 0, 1); return n * n * (3 - 2 * n); };

/** The sheet stays attached to x=0 (the spine), with a curved, closed volume. */
export function filePagePoint(u: number, v: number, angle: number, side = 1): THREE.Vector3 {
  const curl = Math.sin(angle) * Math.sin(Math.PI * u);
  return new THREE.Vector3(PAGE_WIDTH * u * Math.cos(angle) + curl * 0.095,
    PAGE_HEIGHT * (v - 0.5), 0.12 + PAGE_WIDTH * u * Math.sin(angle) + curl * 0.10 + side * PAGE_THICKNESS / 2);
}

function turningPageGeometry(): THREE.BufferGeometry {
  const count = (PAGE_COLUMNS + 1) * (PAGE_ROWS + 1), indices: number[] = [];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 2 * 3), 3));
  for (let side = 0; side < 2; side++) for (let row = 0; row < PAGE_ROWS; row++) for (let column = 0; column < PAGE_COLUMNS; column++) {
    const a = side * count + row * (PAGE_COLUMNS + 1) + column, b = a + PAGE_COLUMNS + 1;
    if (side === 0) indices.push(a, a + 1, b, a + 1, b + 1, b);
    else indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const rim: number[] = [];
  for (let col = 0; col <= PAGE_COLUMNS; col++) rim.push(col);
  for (let row = 1; row <= PAGE_ROWS; row++) rim.push(row * (PAGE_COLUMNS + 1) + PAGE_COLUMNS);
  for (let col = PAGE_COLUMNS - 1; col >= 0; col--) rim.push(PAGE_ROWS * (PAGE_COLUMNS + 1) + col);
  for (let row = PAGE_ROWS - 1; row > 0; row--) rim.push(row * (PAGE_COLUMNS + 1));
  for (let i = 0; i < rim.length; i++) { const a = rim[i], b = rim[(i + 1) % rim.length]; indices.push(a, a + count, b, b, a + count, b + count); }
  geometry.setIndex(indices);
  return geometry;
}

/** Independent plush mittens and desk props, with no arms, torso or landing. */
export function createFileProps(config: PlushRenderConfig, texture: THREE.Texture,
  fur: (surface: THREE.BufferGeometry, color: THREE.Color) => THREE.BufferGeometry): {
    root: THREE.Group; pose(activity: AvatarFileActivity, time: number): void;
  } {
  const root = new THREE.Group(), book = new THREE.Group(), notebook = new THREE.Group();
  const paper = new THREE.MeshStandardMaterial({ color: "#fff3d5", roughness: 0.9 });
  const paperEdge = new THREE.MeshStandardMaterial({ color: "#decda9", roughness: 1 });
  const cover = new THREE.MeshStandardMaterial({ color: "#426a70", roughness: 0.85 });
  const ink = new THREE.MeshStandardMaterial({ color: "#626c78", roughness: 0.9 });
  const gold = new THREE.MeshStandardMaterial({ color: "#dba758", roughness: 0.55 });
  const pawColor = new THREE.Color(isPlushCatAvatar(config) ? plushCatAppearance(config).coat
    : PLUSH_COLORS.find(option => option.id === config.color)?.color ?? "#ecb6a3");
  const box = (parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  };
  const paw = () => {
    const group = new THREE.Group();
    const surface = new THREE.SphereGeometry(1, 24, 16); surface.scale(0.115, 0.12, 0.095);
    group.add(new THREE.Mesh(surface, new THREE.MeshStandardMaterial({ color: pawColor, roughness: 1, bumpMap: texture, bumpScale: 0.008 })));
    group.add(new THREE.Mesh(fur(surface, pawColor), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide })));
    return group;
  };
  // +Z is the printed/readable side. Aim it up and back at the head's eyes,
  // so the camera at +Z sees the outside covers rather than the text spread.
  // The fixed cats have a lower chin pad. Keep the page-turn mitten below
  // that pad without changing the head scale or readable-side direction.
  const catBook = isPlushCatAvatar(config);
  // Leave bottom-edge clearance for the moving covers at the actual 72px size.
  book.position.set(0, catBook ? -1.03 : -0.98, 1.15); book.rotation.x = -2.28; book.scale.setScalar(catBook ? 0.64 : 0.85);
  box(book, 0.10, 0.53, 0.075, 0, 0, -0.035, cover);
  box(book, 0.016, 0.40, 0.004, 0, 0, -0.075, gold); // spine volume
  for (const side of [-1, 1]) {
    const leaf = new THREE.Group(); leaf.rotation.y = -side * 0.12;
    box(leaf, 0.58, 0.53, 0.035, side * 0.29, 0, 0, cover);
    box(leaf, 0.014, 0.39, 0.004, side * 0.50, 0, -0.021, gold);
    box(leaf, 0.55, 0.48, 0.062, side * 0.278, 0.01, 0.052, paperEdge);
    for (let layer = 0; layer < 4; layer++) box(leaf, 0.55, 0.48, 0.009, side * 0.278, 0.01, 0.025 + layer * 0.016, paper);
    for (let row = 0; row < 5; row++) box(leaf, 0.36 - row % 2 * 0.055, 0.007, 0.002, side * 0.29, 0.155 - row * 0.068, 0.09, ink);
    book.add(leaf);
  }
  const pageGeometry = turningPageGeometry(), page = new THREE.Mesh(pageGeometry, new THREE.MeshStandardMaterial({ color: "#fff9eb", roughness: 0.92 })); book.add(page);
  const pageInk = Array.from({ length: 4 }, () => {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(13 * 3), 3));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: "#626c78" })); book.add(line); return line;
  });
  const readLeft = paw(), readRight = paw(); book.add(readLeft, readRight);
  readLeft.position.set(-0.61, -0.07, 0.035);
  notebook.position.set(0, -0.93, 1.10); notebook.rotation.set(-2.15, -0.08, -0.05); notebook.scale.setScalar(0.95);
  box(notebook, 0.97, 0.48, 0.045, 0, 0, -0.018, cover);
  box(notebook, 0.90, 0.43, 0.055, 0.008, 0.008, 0.032, paperEdge);
  for (let layer = 0; layer < 3; layer++) box(notebook, 0.90, 0.43, 0.008, 0.008, 0.008, 0.018 + layer * 0.016, paper);
  box(notebook, 0.90, 0.43, 0.008, 0.008, 0.008, 0.064, paper);
  for (let row = 0; row < 4; row++) box(notebook, 0.70, 0.005, 0.002, 0.03, 0.135 - row * 0.080, 0.069, ink);
  for (let ring = 0; ring < 5; ring++) {
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.031, 0.008, 6, 12), gold);
    loop.position.set(-0.40, 0.15 - ring * 0.075, 0.074); notebook.add(loop);
  }
  // Pen local origin is its nib. Rotation preserves exact paper contact.
  const pen = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.43, 12), gold);
  shaft.position.y = 0.28; pen.add(shaft);
  const nib = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.065, 12), ink);
  nib.rotation.z = Math.PI; nib.position.y = 0.0325; pen.add(nib);
  const grip = paw(); grip.position.set(0.012, 0.205, 0.055); grip.scale.set(0.82, 0.85, 0.85); pen.add(grip);
  pen.rotation.set(1.20, 0, -0.40); notebook.add(pen);
  const writeLeft = paw(); writeLeft.position.set(-0.48, -0.045, 0.035); notebook.add(writeLeft);
  const strokeGeometry = new THREE.BufferGeometry();
  const strokePoints = 60;
  strokeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(strokePoints * 3), 3));
  const stroke = new THREE.Line(strokeGeometry, new THREE.LineBasicMaterial({ color: "#52606b" })); notebook.add(stroke);
  root.add(book, notebook);
  return { root, pose(activity, time) {
    root.visible = activity !== "idle";
    if (activity === "idle") { root.userData.pageAngle = 0; root.userData.pageTurn = 0; return; }
    book.visible = activity === "reading"; notebook.visible = activity === "writing";
    const cycle = time % TURN_PERIOD;
    const progress = smooth((cycle - 0.65) / 1.55), angle = 0.12 + progress * (Math.PI - 0.24);
    const turning = time > 0 && cycle >= 0.65 && cycle <= 2.45;
    page.visible = turning; pageInk.forEach(line => { line.visible = turning; });
    const positions = pageGeometry.getAttribute("position"), count = (PAGE_COLUMNS + 1) * (PAGE_ROWS + 1);
    for (let side = 0; side < 2; side++) for (let row = 0; row <= PAGE_ROWS; row++) for (let col = 0; col <= PAGE_COLUMNS; col++) {
      const point = filePagePoint(col / PAGE_COLUMNS, row / PAGE_ROWS, angle, side === 0 ? 1 : -1);
      positions.setXYZ(side * count + row * (PAGE_COLUMNS + 1) + col, point.x, point.y, point.z);
    }
    positions.needsUpdate = true; pageGeometry.computeVertexNormals();
    pageGeometry.computeBoundingSphere();
    for (const [row, line] of pageInk.entries()) {
      const inkPositions = line.geometry.getAttribute("position");
      for (let at = 0; at <= 12; at++) {
        const point = filePagePoint(0.18 + at / 12 * 0.62, 0.78 - row * 0.15, angle);
        inkPositions.setXYZ(at, point.x, point.y, point.z + 0.002);
      }
      inkPositions.needsUpdate = true; line.geometry.computeBoundingSphere();
    }
    if (turning) {
      const edge = filePagePoint(1, 0.25, angle);
      readRight.position.copy(edge).add(new THREE.Vector3(Math.cos(angle) * 0.035, -0.02, 0.025));
    } else if (cycle > 2.45 && time > 0) {
      const returning = smooth((cycle - 2.45) / 0.60);
      readRight.position.set(-0.55 + returning * 1.16, -0.14 - Math.sin(returning * Math.PI) * 0.22, -0.07);
    } else readRight.position.set(0.61, -0.07, 0.035);
    readRight.rotation.z = turning ? -Math.sin(angle) * 0.30 : 0;
    const writingCycle = time % 3.8, writingProgress = writingCycle / 3.8;
    const nibX = -0.12 + writingProgress * 0.40, nibY = 0.05 + Math.sin(writingCycle * 12) * 0.027;
    pen.position.set(nibX, nibY, 0.068);
    pen.rotation.z = -0.40 + (time ? Math.sin(writingCycle * 12) * 0.018 : 0);
    const trace = strokeGeometry.getAttribute("position"), visiblePoints = Math.max(2, Math.floor(writingProgress * strokePoints));
    for (let at = 0; at < strokePoints; at++) {
      const p = at / (strokePoints - 1), t = p * 3.8;
      trace.setXYZ(at, -0.12 + p * 0.40, 0.05 + Math.sin(t * 12) * 0.027, 0.071);
    }
    trace.needsUpdate = true; strokeGeometry.setDrawRange(0, visiblePoints); strokeGeometry.computeBoundingSphere();
    root.userData.pageAngle = turning ? angle : 0;
    root.userData.pageTurn = Math.floor(time / TURN_PERIOD);
    root.userData.nibContact = pen.position.z - 0.068;
  } };
}
