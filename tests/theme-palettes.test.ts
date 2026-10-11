import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { theme } from "antd";
import { getWandTheme } from "../src/web-ui/react/theme.js";
import { WAND_PALETTES, normalizeWandTheme, themeAliases, themeCss } from "../src/web-ui/react/theme-palettes.js";
import { EMBEDDED_WEB_ASSETS } from "../src/web-ui/embedded-assets.js";
import { renderApp } from "../src/web-ui/index.js";

function rgb(color: string, base = [255, 255, 255]): number[] {
  if (color.startsWith("#")) return color.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  const values = color.match(/[\d.]+/g)!.map(Number);
  return values.length === 4 ? values.slice(0, 3).map((v, i) => v * values[3] + base[i] * (1 - values[3])) : values;
}
function luminance(color: number[]): number {
  return color.reduce((sum, v, i) => { v /= 255; return sum + (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]; }, 0);
}
function contrast(foreground: string, background: string): number {
  const a = luminance(rgb(foreground, rgb(background))), b = luminance(rgb(background));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
test("five semantic palettes keep readable text, focus and code on their actual base surfaces", () => {
  const evidence: Record<string, unknown>[] = [];
  assert.equal(WAND_PALETTES.length, 5);
  for (const p of WAND_PALETTES) {
    const token = theme.getDesignToken(getWandTheme(p.id));
    const aliases = themeAliases(token, p);
    const readings: Record<string, number> = {};
    for (const [role, foreground, surfaces] of [
      ["text", token.colorText, [p.background, p.surface, p.sidebar, p.selected, p.hover]],
      ["secondary", token.colorTextSecondary, [p.background, p.surface, p.sidebar, p.selected, p.hover]],
      ["link", token.colorLink, [p.background, p.surface, p.selected]],
      ["success", token.colorSuccessText, [p.background, token.colorSuccessBg]],
      ["warning", token.colorWarningText, [p.background, token.colorWarningBg]],
      ["error", token.colorErrorText, [p.background, token.colorErrorBg]],
      ["primary label", "#ffffff", [token.colorPrimary, token.colorPrimaryHover, token.colorPrimaryActive]],
      ["terminal", p.terminalText, [p.terminal]],
    ] as Array<[string, string, string[]]>) {
      readings[role] = Math.min(...surfaces.map(bg => contrast(foreground, bg)));
      assert.ok(readings[role] >= 4.5, `${p.id} ${role}: ${readings[role].toFixed(3)}`);
    }
    for (const role of ["keyword", "string", "number", "comment", "operator"]) {
      const value = contrast(String(aliases[`syntax-${role}`]), p.background);
      readings[`syntax-${role}`] = value;
      assert.ok(value >= 4.5, `${p.id} syntax ${role}: ${value}`);
    }
    for (const role of ["find-highlight-bg", "find-active-bg"]) {
      readings[role] = contrast(p.text, String(aliases[role]));
      assert.ok(readings[role] >= 4.5, `${p.id} ${role}`);
    }
    readings.focus = Math.min(...[p.background, p.surface, p.selected].map(bg => contrast(p.focus, bg)));
    assert.ok(readings.focus >= 3, `${p.id} focus: ${readings.focus}`);
    evidence.push({ id: p.id, name: p.name, readings });
  }
  mkdirSync("output/theme-palettes", { recursive: true });
  writeFileSync("output/theme-palettes/contrast-tokens.json", JSON.stringify(evidence, null, 2));
});
test("blocking first-paint asset matches runtime aliases, never writes preferences and fails safely", () => {
  const html = renderApp("/tmp/theme-fixture/config.json");
  assert.ok(html.indexOf('/assets/theme.js') < html.indexOf('<link rel="stylesheet"'));
  for (const stored of [...WAND_PALETTES.map(p => p.id), "invalid", null, "__proto__", "constructor"]) {
    const styles: any[] = [];
    const document: any = { head: { appendChild: (s: any) => styles.push(s) },
      createElement: () => ({}), documentElement: { dataset: {}, style: {} }, querySelector: () => null };
    let writes = 0;
    runInNewContext(EMBEDDED_WEB_ASSETS.themePreloadJs, { document, localStorage: { getItem: () => stored, setItem: () => writes++ } });
    const id = normalizeWandTheme(stored), p = WAND_PALETTES.find(p => p.id === id)!;
    assert.equal(document.documentElement.dataset.wandTheme, id);
    assert.equal(styles[0].textContent, themeCss(themeAliases(theme.getDesignToken(getWandTheme(id)), p)));
    assert.equal(writes, 0);
  }
  const document: any = { head: { appendChild() {} }, createElement: () => ({}), documentElement: { dataset: {}, style: {} }, querySelector: () => null };
  runInNewContext(EMBEDDED_WEB_ASSETS.themePreloadJs, { document, localStorage: { getItem: () => { throw Error("denied"); } } });
  assert.equal(document.documentElement.dataset.wandTheme, "warm");
});
test("documented palette roles remain aligned with their canonical owner", () => {
  const design = readFileSync("DESIGN.md", "utf8");
  for (const p of WAND_PALETTES) for (const value of [p.name, p.primary, p.background, p.surface, p.secondary]) assert.ok(design.includes(value), value);
});
