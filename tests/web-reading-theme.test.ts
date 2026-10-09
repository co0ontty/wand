import assert from "node:assert/strict";
import test from "node:test";
import { theme } from "antd";
import { wandTheme } from "../src/web-ui/react/theme.js";

function rgb(color: string, base = [255, 255, 255]): number[] {
  if (color.startsWith("#")) return color.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  const values = color.match(/[\d.]+/g)!.map(Number);
  return values.length === 4 ? values.slice(0, 3).map((value, index) => value * values[3] + base[index] * (1 - values[3])) : values;
}
function luminance(color: number[]): number {
  return color.reduce((total, value, index) => {
    value /= 255;
    return total + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

test("secondary descriptions and placeholders stay readable on the shared warm surfaces", () => {
  const token = theme.getDesignToken(wandTheme);
  assert.equal(token.colorTextDescription, token.colorTextSecondary);
  assert.equal(token.colorTextPlaceholder, token.colorTextSecondary);
  const foreground = luminance(rgb(token.colorTextSecondary));
  const backgrounds = [token.colorBgLayout, token.colorBgContainer, token.colorPrimaryBg, "#f4f0e9", "#ebe0d3", "#eadfd2", "#f2f3f7"];
  for (const background of backgrounds) {
    const ratio = (luminance(rgb(background)) + 0.05) / (foreground + 0.05);
    assert.ok(ratio >= 4.5, `${token.colorTextSecondary} on ${background}: ${ratio.toFixed(2)}:1`);
  }
});
