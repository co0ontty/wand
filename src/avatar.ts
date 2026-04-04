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
 * Uses a 5x5 symmetric grid with white cells on a colored background.
 * The pattern is mirrored horizontally for visual balance.
 */
export function getAvatarSvg(seed: string, size: 192 | 512): string {
  const svgSize = size;
  const gridSize = 5;
  const padding = Math.round(svgSize * 0.12);
  const innerSize = svgSize - padding * 2;
  const cellSize = Math.floor(innerSize / gridSize);
  const gridWidth = cellSize * gridSize;
  const gridOffset = (svgSize - gridWidth) / 2;

  // Derive color from seed — warm tones that match the Wand theme
  const h = Math.abs(hashString(seed + "h")) % 360;
  const s = 55 + (Math.abs(hashString(seed + "s")) % 30);
  const l = 42 + (Math.abs(hashString(seed + "l")) % 16);
  const bgColor = `hsl(${h},${s}%,${l}%)`;

  // Derive fill states from seed
  const seedChars = seed.slice(0, 25);
  const cells: boolean[] = [];
  for (let i = 0; i < 25; i++) {
    const char = seedChars[i] || "0";
    cells.push(parseInt(char, 16) % 2 === 0);
  }

  const parts: string[] = [];
  const cornerR = Math.round(svgSize * 0.14);

  // Full SVG background with rounded corners
  parts.push(`<rect width="${svgSize}" height="${svgSize}" rx="${cornerR}" fill="${bgColor}"/>`);

  // White cells on colored background — high contrast
  const cellR = Math.round(cellSize * 0.12);
  const cellGap = Math.max(1, Math.round(cellSize * 0.08));
  const actualCell = cellSize - cellGap;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const mirrorCol = gridSize - 1 - col;
      const idx = row * gridSize + col;

      if (col > mirrorCol) continue;
      if (!cells[idx]) continue;

      const y = gridOffset + row * cellSize + cellGap / 2;

      if (col === mirrorCol) {
        const x = gridOffset + col * cellSize + cellGap / 2;
        parts.push(`<rect x="${x}" y="${y}" width="${actualCell}" height="${actualCell}" rx="${cellR}" fill="rgba(255,255,255,0.9)"/>`);
      } else {
        const x1 = gridOffset + col * cellSize + cellGap / 2;
        const x2 = gridOffset + mirrorCol * cellSize + cellGap / 2;
        parts.push(`<rect x="${x1}" y="${y}" width="${actualCell}" height="${actualCell}" rx="${cellR}" fill="rgba(255,255,255,0.9)"/>`);
        parts.push(`<rect x="${x2}" y="${y}" width="${actualCell}" height="${actualCell}" rx="${cellR}" fill="rgba(255,255,255,0.9)"/>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" width="${svgSize}" height="${svgSize}">
  ${parts.join("\n  ")}
</svg>`;
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return h;
}
