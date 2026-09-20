import { WAND_BRAND } from "./brand-logo-data.js";

/** Wand's Android pixel cat, shared by favicon, legacy login and React chrome. */
export function renderWandBrandMarkup(className = "wand-brand-mark"): string {
  const safeClass = className.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const { viewport, inset, background, paths } = WAND_BRAND;
  return `<svg class="${safeClass}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewport} ${viewport}" aria-hidden="true" focusable="false" data-wand-brand="pixel-cat">` +
    `<rect width="${viewport}" height="${viewport}" rx="24" fill="${background}"/>` +
    `<g transform="translate(${inset} ${inset})">` +
    paths.map(({ fill, d }) => `<path fill="${fill}" d="${d}"/>`).join("") +
    "</g></svg>";
}

export const WAND_FAVICON_URL = "data:image/svg+xml," + encodeURIComponent(renderWandBrandMarkup());
