/**
 * Random avatar (identicon) generation for PWA icons.
 * Each installation gets a unique GitHub-style symmetric pattern.
 */

import { existsSync } from "node:fs";
import { mkdir as mkdirAsync, readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";
import path from "node:path";

const SEED_FILE = "avatar-seed.txt";

/**
 * Ensure a random seed exists for this installation.
 * Reads existing seed from config dir, or generates and saves a new one.
 */
export async function ensureAvatarSeed(configDir: string): Promise<string> {
  const seedPath = path.join(configDir, SEED_FILE);
  try {
    if (existsSync(seedPath)) {
      const seed = (await readFileAsync(seedPath, "utf8")).trim();
      if (seed.length > 0) return seed;
    }
  } catch {
    // Fall through to generate
  }
  const seed = generateRandomSeed();
  await mkdirAsync(configDir, { recursive: true });
  await writeFileAsync(seedPath, seed, "utf8");
  return seed;
}

function generateRandomSeed(): string {
  const chars = "0123456789abcdef";
  let seed = "";
  for (let i = 0; i < 32; i++) {
    seed += chars[Math.floor(Math.random() * chars.length)];
  }
  return seed;
}

/**
 * Generate an SVG identicon from a seed string.
 * Uses a 5x5 symmetric grid (mirrored to 9 columns), GitHub-style.
 */
export function getAvatarSvg(seed: string, size: 192 | 512): string {
  const cellSize = Math.round(size * 0.08);
  const gap = Math.max(1, Math.round(size * 0.01));
  const gridSize = 5;
  const totalWidth = gridSize * cellSize + (gridSize - 1) * gap;
  const svgSize = size;

  // Derive color from seed
  const h = Math.abs(hashString(seed + "h")) % 360;
  const s = 50 + (Math.abs(hashString(seed + "s")) % 40);
  const l = 45 + (Math.abs(hashString(seed + "l")) % 20);
  const color = `hsl(${h},${s}%,${l}%)`;

  // Derive fill states from seed (5 chars for 25 cells, each char's LSB)
  const seedChars = seed.slice(0, 25);
  const cells: boolean[] = [];
  for (let i = 0; i < 25; i++) {
    const char = seedChars[i] || "0";
    cells.push(parseInt(char, 16) % 2 === 0);
  }

  const rects: string[] = [];
  const cx = svgSize / 2;
  const cy = svgSize / 2;
  const radius = svgSize * 0.22;

  // Outer background circle
  rects.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`);

  // Symmetric grid: columns 0-4, mirror to 8-4
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const mirrorCol = gridSize - 1 - col;
      const idx = row * gridSize + col;

      // Only draw for left half + middle column (right half mirrors)
      if (col > mirrorCol) continue;

      if (!cells[idx]) continue;

      // Two mirrored rectangles
      const x1 = col * (cellSize + gap);
      const x2 = mirrorCol * (cellSize + gap);
      const y = row * (cellSize + gap);
      const offsetX = (svgSize - totalWidth) / 2;
      const offsetY = (svgSize - totalWidth) / 2;

      // Darken color for filled cells
      const cellColor = `hsl(${h},${s}%,${l - 15}%)`;
      const rx = Math.round(cellSize * 0.15);

      if (col === mirrorCol) {
        // Middle column — single centered rect
        const mx = offsetX + col * (cellSize + gap);
        const my = offsetY + y;
        rects.push(`<rect x="${mx}" y="${my}" width="${cellSize}" height="${cellSize}" rx="${rx}" fill="${cellColor}"/>`);
      } else {
        const mx1 = offsetX + x1;
        const mx2 = offsetX + x2;
        const my = offsetY + y;
        rects.push(`<rect x="${mx1}" y="${my}" width="${cellSize}" height="${cellSize}" rx="${rx}" fill="${cellColor}"/>`);
        rects.push(`<rect x="${mx2}" y="${my}" width="${cellSize}" height="${cellSize}" rx="${rx}" fill="${cellColor}"/>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" width="${svgSize}" height="${svgSize}">
  ${rects.join("\n  ")}
</svg>`;
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return h;
}
