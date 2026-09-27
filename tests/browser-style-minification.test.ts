import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import {
  createBrowserStyleMinificationPlugin,
  isBrowserStyleFile,
  minifyStringRawCssTemplates,
  poolEmittedCssStringLiterals,
} from "../scripts/browser-style-minification.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REAL_STYLE_FILES = [
  "src/web-ui/react/code-editor/styles.ts",
  "src/web-ui/react/file-explorer/styles.ts",
  "src/web-ui/react/file-preview/markdown-styles.ts",
  "src/web-ui/react/file-preview/styles.ts",
  "src/web-ui/react/image-viewer/styles.ts",
  "src/web-ui/react/local-preview/styles.ts",
  "src/web-ui/react/restart-overlay/styles.ts",
  "src/web-ui/react/styles/base.ts",
  "src/web-ui/react/styles/features.ts",
];

test("static String.raw CSS templates are replaced with a minified string literal", () => {
  const source = "export const css = String.raw`\n.a {\n  display: flex;\n}\n`;\n";
  const { code, replaced, skipped } = minifyStringRawCssTemplates(source, "styles.ts");
  assert.equal(replaced, 1);
  assert.equal(skipped, 0);
  assert.ok(!code.includes("String.raw"));
  assert.ok(code.startsWith('export const css = "'));
  assert.match(code, /\.a\{display:flex\}/);
});

test("templates with interpolation are never evaluated or changed", () => {
  const source = 'const c = "flex";\nexport const css = String.raw`.a { display: ${c}; }`;\n';
  const { code, replaced } = minifyStringRawCssTemplates(source, "features.ts");
  assert.equal(code, source);
  assert.equal(replaced, 0);
});

test("unrelated strings, templates and regexes stay untouched", () => {
  const source =
    'const label = "String.raw";\n' +
    "const tpl = `hi ${1}`;\n" +
    "const re = /String\\.raw/;\n" +
    "export const css = String.raw`.a{display:flex}`;\n";
  const { code, replaced } = minifyStringRawCssTemplates(source, "styles.ts");
  assert.equal(replaced, 1);
  assert.ok(code.includes('const label = "String.raw";'));
  assert.ok(code.includes("const tpl = `hi ${1}`;"));
  assert.ok(code.includes("const re = /String\\.raw/;"));
});

test("unterminated CSS syntax (esbuild parse errors) aborts the whole transform", () => {
  // Boundary note: a minifier is not a CSS semantic validator. Semantically
  // odd but syntactically valid input (e.g. `display: ;`) is esbuild's business,
  // not ours. What must never slip through is a *parse* error: esbuild reports
  // it as a warning/error and we abort instead of shipping partially transformed
  // output. No ad-hoc regex parser here — that would break valid custom props/strings.
  const unclosedBlock = "export const css = String.raw`.a { display: flex`;\n";
  assert.throws(
    () => minifyStringRawCssTemplates(unclosedBlock, "styles.ts"),
    /browser-style-minification/,
  );

  const unterminatedString = 'export const css = String.raw`.a::before { content: "oops`;\n';
  assert.throws(
    () => minifyStringRawCssTemplates(unterminatedString, "styles.ts"),
    /browser-style-minification/,
  );

  // One broken template alongside a valid one still aborts the entire module.
  const mixed =
    "export const ok = String.raw`.b { display: flex; }`;\n" +
    "export const bad = String.raw`.a { color: red`;\n";
  assert.throws(() => minifyStringRawCssTemplates(mixed, "styles.ts"), /browser-style-minification/);
});

test("escaped CSS content is conservatively preserved, not rewritten", () => {
  const source = 'export const css = String.raw`.a::before { content: "\\201C"; }`;\n';
  const { code, replaced, skipped } = minifyStringRawCssTemplates(source, "styles.ts");
  assert.equal(code, source);
  assert.equal(replaced, 0);
  assert.equal(skipped, 1);
});

test("custom properties, media queries, reduced-motion and selectors survive minification", () => {
  const css =
    ":root { --wand-gap: 8px; --wand-empty: ; }\n" +
    "@media (prefers-reduced-motion: reduce) {\n  .a, .b > .c { transition: none; }\n}\n" +
    '.d::before { content: ""; }\n';
  const source = `export const css = String.raw\`${css}\`;\n`;
  const { code, replaced } = minifyStringRawCssTemplates(source, "styles.ts");
  assert.equal(replaced, 1);
  assert.ok(!code.includes("String.raw"), code);
  // The emitted literal is a JSON string; assertions run on its CSS content and
  // use flexible whitespace — minified formatting is esbuild's, not a fixed shape.
  const literal = code.match(/^export const css = ("(?:[^"\\]|\\.)*");\n$/);
  assert.ok(literal !== null, code);
  const minified = JSON.parse(literal[1]);
  assert.match(minified, /--wand-gap:\s*8px/);
  assert.match(minified, /--wand-empty:/);
  assert.match(minified, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  assert.match(minified, /\.a\s*,\s*\.b\s*>\s*\.c\s*\{\s*transition:\s*none\s*\}/);
  // esbuild may collapse a two-colon pseudo-element to its valid one-colon form.
  assert.match(minified, /\.d::?before\s*\{\s*content:\s*""\s*\}/);
});

test("filename guard is anchored to this repo's real react root", () => {
  // Positives must live under the actual project root (or the same-relative
  // project path); an arbitrary "/repo/src/..." prefix is NOT accepted any more.
  const projectPositives = [
    "src/web-ui/react/foo/styles.ts",
    "src/web-ui/react/a/b/styles.ts",
    "src/web-ui/react/file-preview/markdown-styles.ts",
    "src/web-ui/react/styles/base.ts",
    "src/web-ui/react/styles/features.ts",
  ];
  for (const rel of projectPositives) {
    assert.equal(isBrowserStyleFile(rel), true, rel);
    assert.equal(isBrowserStyleFile(path.join(root, rel)), true, rel);
  }
  const negatives = [
    // Wrong names or wrong nesting inside the real react root.
    "src/web-ui/react/styles/helpers.ts",
    "src/web-ui/react/styles/deep/nested/base.ts",
    "src/web-ui/react/foo/other.ts",
    "src/server.ts",
    "src/web-ui/browser/styles.ts",
    "src/web-ui/reactx/styles.ts",
    // Absolute paths that merely *contain* src/web-ui/react/ are rejected:
    // dependency/vendor mirrors and sibling clones are not this project.
    "/repo/src/web-ui/react/foo/styles.ts",
    "/repo/src/web-ui/react/styles/base.ts",
  ];
  for (const rel of negatives) {
    assert.equal(isBrowserStyleFile(rel), false, rel);
  }
  for (const abs of [
    path.join(root, "node_modules/pkg/src/web-ui/react/styles/base.ts"),
    path.join(root, "vendor/mirror/src/web-ui/react/foo/styles.ts"),
    path.join(root, "src/web-ui/react/node_modules/pkg/styles.ts"),
    path.resolve(root, "..", "sibling-clone/src/web-ui/react/styles/features.ts"),
    path.join(root, "src/server.ts"),
  ]) {
    assert.equal(isBrowserStyleFile(abs), false, abs);
  }
});

test("real source style files are transformed in memory but untouched on disk", () => {
  let totalReplaced = 0;
  for (const rel of REAL_STYLE_FILES) {
    const full = path.join(root, rel);
    const before = readFileSync(full, "utf8");
    assert.equal(isBrowserStyleFile(full), true, rel);
    const { code, replaced, skipped } = minifyStringRawCssTemplates(before, full);
    assert.equal(readFileSync(full, "utf8"), before, `${rel} must not be written to disk`);
    assert.equal(skipped, 0, rel);
    assert.ok(before.includes("String.raw"), rel);
    assert.ok(!code.includes("String.raw"), rel);
    assert.ok(code.length < before.length, rel);
    totalReplaced += replaced;
  }
  assert.equal(totalReplaced, 15);
});

test("plugin exposes the expected esbuild plugin shape", () => {
  const plugin = createBrowserStyleMinificationPlugin();
  assert.equal(plugin.name, "browser-style-minification");
  assert.equal(typeof plugin.setup, "function");
});

// ---------- post-bundle CSS pooling ----------

// Tricky fragment: escaped quotes inside CSS content, a real newline, and
// non-ASCII characters that must survive the JSON round trip untouched.
const CSS_A = ".a{content:\"q\";margin:0}\n\u2014\u00e9";
const CSS_B = "body{margin:0;padding:0}";

function executeBundle(code: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {};
  vm.runInContext(code, vm.createContext(sandbox));
  return sandbox;
}

/**
 * Copy a vm-realm array out of its sandbox context into a host-realm array.
 * `assert.deepEqual` (strict) compares prototypes, and each `vm.createContext`
 * spawns a distinct realm whose Array.prototype differs from the host one, so
 * arrays crossing realms must be normalized before deep equality.
 */
function hostArray(value: unknown): unknown[] {
  return Array.from(value as ArrayLike<unknown>);
}

/** Mimics an esbuild-emitted IIFE: each style value as one JSON literal. */
function emittedBundle(styleValues: string[]): string {
  const declarations = styleValues.map((value, i) => `  const s${i} = ${JSON.stringify(value)};`).join("\n");
  return (
    "(() => {\n" +
    '  const keep = "not-css";\n' +
    declarations +
    `\n  globalThis.__out = [${styleValues.map((_v, i) => `s${i}`).join(", ")}];\n` +
    "})();\n"
  );
}

function extractPool(code: string): string[] {
  const match = code.match(/^const __wandCssTextPool(?:_\d+)? = Object\.freeze\((.+)\);$/m);
  assert.ok(match !== null && match[1] !== undefined, "frozen pool declaration missing");
  return JSON.parse(match[1]) as string[];
}

test("pooling rewrites only exact-match literals, in emitted order, deduped", () => {
  const source = emittedBundle([CSS_A, CSS_B, CSS_A]);
  const { code, pooled, poolSize } = poolEmittedCssStringLiterals(
    source,
    new Set([CSS_A, CSS_B, "unused-fragment{a:b}"]),
  );
  assert.equal(pooled, 3);
  assert.equal(poolSize, 2);
  // Exact values, first-occurrence order, one declaration line.
  assert.deepEqual(extractPool(code), [CSS_A, CSS_B]);
  assert.equal(code.split("__wandCssTextPool[0]").length - 1, 2);
  assert.equal(code.split("__wandCssTextPool[1]").length - 1, 1);
  // Unreachable candidates are never embedded; unrelated strings are intact.
  assert.ok(!code.includes("unused-fragment{a:b}"));
  assert.ok(code.includes('"not-css"'));
  assert.deepEqual(hostArray(executeBundle(code).__out), hostArray(executeBundle(source).__out));
});

test("untagged no-substitution templates are pooled; tagged or interpolated ones are not", () => {
  const source =
    "(() => {\n" +
    "  const a = `.a{\\ndisplay:flex}`;\n" +
    "  const b = String.raw`.a{\\ndisplay:flex}`;\n" +
    "  const c = `x${1}y`;\n" +
    "  globalThis.__out = [a, b, c];\n" +
    "})();\n";
  const { code, pooled, poolSize } = poolEmittedCssStringLiterals(
    source,
    new Set([".a{\ndisplay:flex}"]),
  );
  assert.equal(pooled, 1);
  assert.equal(poolSize, 1);
  assert.ok(code.includes("String.raw`.a{\\ndisplay:flex}`"));
  assert.ok(code.includes("`x${1}y`"));
  assert.ok(!code.includes("const a = `"));
  assert.deepEqual(hostArray(executeBundle(code).__out), hostArray(executeBundle(source).__out));
});

test("zero matches or empty candidates leave the bundle byte-identical", () => {
  const source = emittedBundle(["some.js(\"code\")"]);
  assert.equal(poolEmittedCssStringLiterals(source, new Set([".a{color:red}"])).code, source);
  assert.equal(poolEmittedCssStringLiterals(source, new Set<string>()).code, source);
  const emptyValue = poolEmittedCssStringLiterals(source, new Set(["", ".a{color:red}"]));
  assert.equal(emptyValue.code, source);
  assert.equal(emptyValue.pooled, 0);
});

test("empty-string candidates never capture the common empty literal", () => {
  const source = "(() => {\n  const a = \"\";\n  globalThis.__n = a.length;\n})();\n";
  const { code, pooled } = poolEmittedCssStringLiterals(source, new Set([""]));
  assert.equal(pooled, 0);
  assert.equal(code, source);
});

test("directive prologue and property-name literals are syntax and never pooled", () => {
  const source =
    '"use strict";\n' +
    "(() => {\n" +
    '  const o = { "use strict": 1 };\n' +
    '  globalThis.__x = o["use strict"];\n' +
    "})();\n";
  const { code, pooled } = poolEmittedCssStringLiterals(source, new Set(["use strict"]));
  assert.ok(code.startsWith('"use strict";'), code.slice(0, 80));
  assert.ok(code.includes('{ "use strict": 1 }'));
  assert.equal(pooled, 1); // only the element-access value position
  assert.equal(executeBundle(code).__x, 1);
});

test("quoted object/class method, getter, setter and destructuring names are never pooled", () => {
  const source =
    "(() => {\n" +
    '  const obj = { ".a{color:red}"() { return 7; }, get ".b{color:red}"() { return 8; }, set ".c{color:red}"(v) { this.c = v; } };\n' +
    '  class K { ".d{color:red}"() { return 9; } get ".e{color:red}"() { return 10; } set ".f{color:red}"(v) { this.f = v; } }\n' +
    '  const { ".a{color:red}": renamed } = obj;\n' +
    "  const k = new K();\n" +
    '  const value = ".a{color:red}";\n' +
    '  globalThis.__out = [obj[".a{color:red}"](), renamed(), k[".d{color:red}"](), value, obj[".b{color:red}"], k[".e{color:red}"]];\n' +
    "})();\n";
  const { code, pooled, poolSize } = poolEmittedCssStringLiterals(
    source,
    new Set([".a{color:red}", ".b{color:red}", ".c{color:red}", ".d{color:red}", ".e{color:red}", ".f{color:red}"]),
  );
  // Only value positions pool: the `value` declaration plus the four
  // element-access keys. The six quoted member names and the destructuring
  // property name are syntax; pooling them would emit invalid code such as
  // `__wandCssTextPool[0]() {}` or `{ __wandCssTextPool[0]: renamed }`.
  assert.equal(pooled, 5);
  assert.equal(poolSize, 4);
  assert.deepEqual(extractPool(code), [".a{color:red}", ".d{color:red}", ".b{color:red}", ".e{color:red}"]);
  assert.ok(code.includes('".a{color:red}"() { return 7'), code);
  assert.ok(code.includes('get ".b{color:red}"()'), code);
  assert.ok(code.includes('set ".c{color:red}"(v)'), code);
  assert.ok(code.includes('".d{color:red}"()'), code);
  assert.ok(code.includes('set ".f{color:red}"(v)'), code);
  assert.ok(code.includes('".a{color:red}": renamed'), code);
  assert.ok(!/\{\s*__wandCssTextPool\[\d+\]\s*[(:a-z]/.test(code), code);
  // The transformed bundle still parses and executes, and ordinary value
  // literals round-trip through the pool unchanged.
  assert.deepEqual(hostArray(executeBundle(code).__out), [7, 7, 9, ".a{color:red}", 8, 10]);
});

test("pool identifier avoids names already present in the emitted code", () => {
  const source =
    "(() => {\n" +
    '  const __wandCssTextPool = "sentinel";\n' +
    "  globalThis.__keep = __wandCssTextPool;\n" +
    `  globalThis.__out = [${JSON.stringify(CSS_A)}];\n` +
    "})();\n";
  const { code } = poolEmittedCssStringLiterals(source, new Set([CSS_A]));
  assert.ok(code.includes("const __wandCssTextPool_1 = Object.freeze("));
  assert.ok(!code.includes("const __wandCssTextPool = Object.freeze("));
  const context = executeBundle(code);
  assert.deepEqual(hostArray(context.__out), [CSS_A]);
  assert.equal(context.__keep, "sentinel");
});

test("plugin records minified CSS candidates in memory without touching disk", async () => {
  type LoadHandler = (args: { path: string }) => Promise<{ contents?: string } | null>;
  const candidates = new Set<string>();
  const plugin = createBrowserStyleMinificationPlugin(candidates);
  let load: LoadHandler | undefined;
  plugin.setup({
    onLoad: (_options: unknown, handler: LoadHandler) => {
      load = handler;
    },
  } as unknown as Parameters<typeof plugin.setup>[0]);
  assert.ok(load !== undefined);

  const expected = new Set<string>();
  for (const rel of REAL_STYLE_FILES) {
    const full = path.join(root, rel);
    const before = readFileSync(full, "utf8");
    const result = await load({ path: full });
    assert.ok(typeof result?.contents === "string", rel);
    assert.equal(readFileSync(full, "utf8"), before, `${rel} must not be written to disk`);
    for (const value of minifyStringRawCssTemplates(before, full).values) {
      assert.ok(value.length > 0, rel);
      expected.add(value);
    }
  }
  const outside = await load({ path: path.join(root, "src/web-ui/browser/main.ts") });
  assert.equal(outside, null);
  assert.deepEqual([...candidates].sort(), [...expected].sort());
});

test("all 15 real style fragments pool with identical runtime values", () => {
  const values: string[] = [];
  for (const rel of REAL_STYLE_FILES) {
    const full = path.join(root, rel);
    const before = readFileSync(full, "utf8");
    const { values: fileValues } = minifyStringRawCssTemplates(before, full);
    assert.equal(readFileSync(full, "utf8"), before, `${rel} must not be written to disk`);
    values.push(...fileValues);
  }
  assert.equal(values.length, 15);
  const source = emittedBundle(values);
  const { code, pooled, poolSize } = poolEmittedCssStringLiterals(source, new Set(values));
  assert.equal(pooled, 15);
  assert.equal(poolSize, new Set(values).size);
  assert.deepEqual(extractPool(code), [...new Set(values)]);
  assert.deepEqual(hostArray(executeBundle(code).__out), hostArray(executeBundle(source).__out));
});
