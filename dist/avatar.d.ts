/**
 * Random avatar (identicon) generation for PWA icons.
 * Each installation gets a unique GitHub-style symmetric pattern.
 */
/**
 * Ensure a random seed exists for this installation.
 * Reads existing seed from config dir, or generates and saves a new one.
 */
export declare function ensureAvatarSeed(configDir: string): Promise<string>;
/**
 * Generate an SVG identicon from a seed string.
 * Uses a 5x5 symmetric grid with white cells on a colored background.
 * The pattern is mirrored horizontally for visual balance.
 */
export declare function getAvatarSvg(seed: string, size: 192 | 512): string;
