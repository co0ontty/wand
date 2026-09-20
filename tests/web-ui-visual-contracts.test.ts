import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { foundationStyles } from "../src/web-ui/react/styles/base.js";

const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing rule: ${selector}`);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

test("login and shared controls use the same flat geometry and primary color", () => {
  assert.match(styles, /--control-radius: 6px/);
  assert.match(rule(".login-page .form-col .btn"), /border-radius: var\(--control-radius\)/);
  assert.match(foundationStyles, /\.wand-ui-button \{\s*border-radius: var\(--control-radius\)/);
  assert.match(rule(".blank-chat-tool-btn.welcome-new-task"), /background: var\(--accent-solid\)/);
  assert.match(rule(".input-composer .btn-circle-send"), /background: var\(--accent-solid\)/);
  assert.match(rule(".input-composer .btn-circle-send"), /box-shadow: none/);
  assert.match(foundationStyles, /\.wand-ui-button-primary::before,[\s\S]*?background: transparent/);
});

test("sidebar colors alias the login palette instead of introducing a second palette", () => {
  for (const [alias, token] of [
    ["surface", "bg-primary"], ["surface-raised", "bg-elevated"],
    ["ink", "text-primary"], ["muted", "text-tertiary"],
    ["line", "border-subtle"], ["hover", "bg-hover"], ["active", "accent-muted"],
  ]) {
    assert.ok(styles.includes(`--web-sidebar-${alias}: var(--${token});`));
  }
});

test("Appica press feedback cannot reintroduce scaling or vertical jumps", () => {
  const press = foundationStyles.slice(foundationStyles.indexOf(".wand-ui-button:is(:active"));
  const block = press.slice(0, press.indexOf("}"));
  assert.match(block, /scale: none/);
  assert.match(block, /translate: none/);
  assert.match(block, /transform: none/);
  assert.match(foundationStyles, /\.wand-ui-button:focus-visible/);
});

test("portalled menus remain interactive above the shell", () => {
  const start = foundationStyles.indexOf(".wand-ui-dropdown-content {");
  const menu = foundationStyles.slice(start, foundationStyles.indexOf("}", start));
  assert.match(menu, /pointer-events: auto/);
  assert.match(menu, /z-index: 10/);
});

test("the task welcome glyph remains visible on the paper surface", () => {
  const icon = rule(".workspace-task-welcome .blank-chat-logo");
  assert.match(icon, /color: var\(--text-secondary\)/);
  assert.match(icon, /background: var\(--bg-secondary\)/);
  assert.doesNotMatch(icon, /color: white/);
});

test("hover actions preserve title width and keyboard access", () => {
  const start = styles.indexOf("/* Reserve the action gutter");
  assert.ok(start >= 0);
  const gutter = styles.slice(start, styles.indexOf("}\n}", start) + 3);
  assert.match(gutter, /:not\(:focus-within\)/);
  assert.match(gutter, /opacity: 0/);
  assert.doesNotMatch(gutter, /(?:min-)?width: 0|margin-left: -/);
});
