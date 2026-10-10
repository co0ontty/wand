import { normalizeWandTheme } from "../../src/web-ui/react/theme-palettes.js";
import { EMBEDDED_WEB_ASSETS } from "../../src/web-ui/embedded-assets.js";

/** Only isolated HTTP fixtures use this opt-in; never touch a user's browser profile. */
export function themeFixtureHtml(html: string): string {
  if (!process.env.WAND_QA_THEME) return html;
  const id = normalizeWandTheme(process.env.WAND_QA_THEME);
  return html.replace("<head>", `<head><script>localStorage.setItem("wand-theme",${JSON.stringify(id)});${EMBEDDED_WEB_ASSETS.themePreloadJs}</script>`);
}
