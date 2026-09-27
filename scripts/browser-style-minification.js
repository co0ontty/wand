// Production-only esbuild plugin + post-bundle pass: minify the static
// `String.raw` CSS templates embedded in the React style modules before they
// enter the JS bundle, then group the minified fragments that actually survived
// into the emitted IIFE into one frozen pool so gzip's limited dictionary sees
// neighboring styles. The bundle's second-stage minifiers
// (minify-web-assets.js / minify-dist-content.js) never touch string contents
// and never inline pool references, so without this step those CSS strings ship
// verbatim, spread across scripts.js, inside scripts.js.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import ts from "typescript";

const DIRECT_BASENAMES = new Set(["styles.ts", "markdown-styles.ts"]);
const STYLES_DIR_BASENAMES = new Set(["base.ts", "features.ts"]);

// Anchor on this repo's real `src/web-ui/react` root, resolved from the helper's
// own module URL. A substring match on the pathname (an old lastIndexOf trick)
// would also accept arbitrary roots: nested node_modules/vendor mirrors or
// sibling clones whose paths merely happen to contain "src/web-ui/react/".
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REACT_ROOT = path.join(PROJECT_ROOT, "src", "web-ui", "react");

/** Strict filename guard: only the known React style modules may be rewritten. */
export function isBrowserStyleFile(filePath) {
  const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.join(PROJECT_ROOT, filePath);
  const rel = path.relative(REACT_ROOT, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  const segments = rel.split(path.sep);
  if (segments.includes("node_modules")) return false;
  const base = segments[segments.length - 1];
  const parent = segments.length > 1 ? segments[segments.length - 2] : "";
  if (DIRECT_BASENAMES.has(base)) return true;
  return parent === "styles" && STYLES_DIR_BASENAMES.has(base);
}

function collectCssTemplateEdits(sourceFile, filePath) {
  const edits = [];
  let skipped = 0;

  const visit = (node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      node.tag.getText(sourceFile) === "String.raw" &&
      ts.isNoSubstitutionTemplateLiteral(node.template)
    ) {
      const start = node.template.getStart(sourceFile);
      const raw = sourceFile.text.slice(start + 1, node.template.getEnd() - 1);
      // Backslashes in raw text signal escaped delimiters whose String.raw vs.
      // plain-string round trip we do not want to reason about; keep as-is.
      if (raw.includes("\\")) {
        skipped += 1;
      } else {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const value = minifyCssFragment(raw, filePath, position.line + 1);
        edits.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          value,
          text: JSON.stringify(value),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { edits, skipped };
}

function minifyCssFragment(css, filePath, line) {
  let result;
  try {
    result = transformSync(css, { loader: "css", minify: true, legalComments: "none" });
  } catch (error) {
    throw new Error(
      `[browser-style-minification] invalid CSS in ${filePath} (String.raw at line ${line}): ${error.message}`,
    );
  }
  if (result.warnings.length > 0) {
    throw new Error(
      `[browser-style-minification] esbuild reported warnings while minifying CSS in ${filePath} ` +
        `(String.raw at line ${line}); refusing to risk dropping content: ` +
        result.warnings.map((w) => w.text).join("; "),
    );
  }
  if (css.trim().length > 0 && result.code.trim().length === 0) {
    throw new Error(
      `[browser-style-minification] CSS minification produced empty output for non-empty input in ${filePath} (line ${line}).`,
    );
  }
  return result.code;
}

/**
 * Replace every static `String.raw` CSS template in a style module with the
 * minified JSON string literal. Templates with interpolation or escaped
 * delimiters are skipped. Pure function: never writes to disk. `values` lists
 * the minified CSS fragments in source order for the post-bundle pooling pass.
 */
export function minifyStringRawCssTemplates(sourceText, filePath = "module.ts") {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { edits, skipped } = collectCssTemplateEdits(sourceFile, filePath);
  let code = sourceText;
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  for (const edit of ordered) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  }
  return { code, replaced: edits.length, skipped, values: edits.map((edit) => edit.value) };
}

/**
 * esbuild plugin for `build()` (the sync API does not support plugins). Only
 * files passing isBrowserStyleFile() are transformed; everything else falls
 * back to esbuild's default loader. When `cssCandidates` (a Set) is given, each
 * non-empty minified fragment is recorded there in memory — nothing is written
 * or evaluated, and only fragments that later appear in the emitted bundle are
 * pooled by poolEmittedCssStringLiterals().
 */
export function createBrowserStyleMinificationPlugin(cssCandidates) {
  return {
    name: "browser-style-minification",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        if (!isBrowserStyleFile(args.path)) return null;
        const source = await readFile(args.path, "utf8");
        const { code, values } = minifyStringRawCssTemplates(source, args.path);
        if (cssCandidates) {
          for (const value of values) {
            if (value.length > 0) cssCandidates.add(value);
          }
        }
        return { contents: code, loader: "ts" };
      });
    },
  };
}

const POOL_BASE_IDENTIFIER = "__wandCssTextPool";

/** Collision-free pool binding: never shadow or clash with an emitted name. */
function pickPoolIdentifier(code) {
  if (!code.includes(POOL_BASE_IDENTIFIER)) return POOL_BASE_IDENTIFIER;
  for (let n = 1; n < 1000; n += 1) {
    const name = `${POOL_BASE_IDENTIFIER}_${n}`;
    if (!code.includes(name)) return name;
  }
  throw new Error("[browser-style-minification] no collision-free CSS pool identifier found");
}

/**
 * A literal is poolable only when it sits in value position AND its exact
 * cooked text is a candidate. Property names, directives, module specifiers and
 * import() arguments are syntax positions and are never rewritten, no matter
 * what they contain.
 */
function isPoolableLiteral(node, candidates) {
  if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return false;
  if (node.text.length === 0 || !candidates.has(node.text)) return false;
  const parent = node.parent;
  if (!parent) return false;
  // Standalone string statements are directive prologues; keep them verbatim.
  if (ts.isExpressionStatement(parent)) return false;
  // Tagged template operands are raw text; a cooked-value swap would corrupt
  // semantics (String.raw) or syntax. Interpolated templates parse as
  // TemplateHead/Middle/Tail and are never matched in the first place.
  if (ts.isTaggedTemplateExpression(parent) && parent.template === node) return false;
  // Declaration/member names are syntax, not values — this covers property
  // assignments, enum members, and every quoted object/class method, getter,
  // setter or member name (parent.name === node), plus destructuring and
  // export-specifier aliases (parent.propertyName === node).
  if (("name" in parent && parent.name === node) || ("propertyName" in parent && parent.propertyName === node)) {
    return false;
  }
  if (ts.isComputedPropertyName(parent)) return false;
  // Module resolution operands must stay literal.
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) {
    return false;
  }
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return false;
  return true;
}

/**
 * Post-bundle pass (production only, pure function, no eval): rewrite string
 * literals in the emitted IIFE whose values are CSS candidates into indexed
 * reads of one private frozen array, grouped contiguously so gzip's 32KiB
 * window can reuse neighboring style text. Only literals actually present in
 * the emitted code are pooled — unreachable candidate fragments are never
 * embedded. Leading directive prologues stay at the top level; everything else
 * moves into a lexical wrapper so the pool never reaches window/global. With
 * zero matches the input is returned byte-identical. The original statement
 * order and stylesheet insertion timing are untouched because only literal
 * *values* change.
 */
export function poolEmittedCssStringLiterals(code, cssCandidates) {
  const candidates = new Set();
  for (const value of cssCandidates ?? []) {
    if (typeof value === "string" && value.length > 0) candidates.add(value);
  }
  if (candidates.size === 0) return { code, poolSize: 0, pooled: 0 };

  const sourceFile = ts.createSourceFile(
    "scripts.emitted.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const poolIdentifier = pickPoolIdentifier(code);
  const poolValues = [];
  const poolIndex = new Map();
  const edits = [];

  const visit = (node) => {
    if (isPoolableLiteral(node, candidates)) {
      const value = node.text;
      let index = poolIndex.get(value);
      if (index === undefined) {
        index = poolValues.length;
        poolValues.push(value);
        poolIndex.set(value, index);
      }
      // AST walk order is emitted occurrence order, so the pool groups each
      // module's fragments in the sequence the bundle already used them.
      edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), text: `${poolIdentifier}[${index}]` });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (edits.length === 0) return { code, poolSize: 0, pooled: 0 };

  // Top-level directive prologue (strict mode etc.): re-emitted verbatim
  // outside the wrapper so the script's semantics do not change. Directive
  // literals are excluded above, so no edit precedes this region.
  let prefixEnd = 0;
  const directives = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      directives.push(`${statement.expression.getText(sourceFile)};`);
      prefixEnd = statement.getEnd();
      continue;
    }
    break;
  }

  let rewritten = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  const wrapper =
    `(() => {\nconst ${poolIdentifier} = Object.freeze(${JSON.stringify(poolValues)});\n` +
    rewritten.slice(prefixEnd) +
    "\n})();";
  return {
    code: directives.length > 0 ? `${directives.join("\n")}\n${wrapper}` : wrapper,
    poolSize: poolValues.length,
    pooled: edits.length,
  };
}
