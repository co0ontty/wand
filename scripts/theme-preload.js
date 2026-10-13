import { build } from "esbuild";
import { theme as antTheme } from "antd";
import path from "node:path";

/** Generate from the canonical TS owner; deployed servers need no Ant dependency. */
export async function buildThemePreload(root) {
  const compiled = await build({ entryPoints: [path.join(root, "src/web-ui/react/theme-palettes.ts")],
    bundle: true, platform: "node", format: "esm", write: false });
  const source = compiled.outputFiles[0].text;
  const { WAND_PALETTES, THEME_STORAGE_KEY, paletteThemeConfig, themeAliases, themeCss } =
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const lookup = Object.fromEntries(WAND_PALETTES.map(p => [p.id, {
    css: themeCss(themeAliases(antTheme.getDesignToken(paletteThemeConfig(p, antTheme.darkAlgorithm)), p)),
    dark: p.dark, background: p.background,
  }]));
  return `(()=>{const palettes=${JSON.stringify(lookup)};let id="warm";try{const stored=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(Object.prototype.hasOwnProperty.call(palettes,stored))id=stored}catch{}const p=palettes[id];const sheet=document.createElement("style");sheet.id="wand-theme-tokens";sheet.textContent=p.css;document.head.appendChild(sheet);document.documentElement.dataset.wandTheme=id;document.documentElement.style.colorScheme=p.dark?"dark":"light";document.querySelector('meta[name="theme-color"]')?.setAttribute("content",p.background)})();`;
}
