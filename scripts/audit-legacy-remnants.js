#!/usr/bin/env node
/** Candidate finder, NOT proof of dead DOM or runtime reachability. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TOKEN = /^[A-Za-z_][\w-]*$/;

function staticText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

function selectorTokens(selector) {
  // Attribute values such as [href="file.ts#section"] are not class/id selectors.
  const stripped = selector.replace(/\[(?:[^\]"']|"[^"]*"|'[^']*')*\]/g, "");
  return [...stripped.matchAll(/([.#])([A-Za-z_][\w-]*)/g)].map((match) => match[0]);
}

function ownerOf(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    if (parent.name) return parent.name.getText();
    if (ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText();
    return "<callback>";
  }
  return "<top-level>";
}

/** Accept virtual files so all heuristics can be tested without a build/browser. */
export function auditSources(files) {
  const producers = new Set();
  const cssRules = new Set();
  const consumers = new Map();
  let dynamicQueries = 0;
  const produce = (value, kind) => {
    for (const token of kind === "id" ? [value] : value.split(/\s+/)) {
      if (TOKEN.test(token)) producers.add((kind === "id" ? "#" : ".") + token);
    }
  };

  for (const { path, text } of files) {
    if (path.endsWith(".css")) {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of css.matchAll(/([^{}]+)\{/g)) {
        for (const token of selectorTokens(match[1])) cssRules.add(token);
      }
      continue;
    }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const legacy = path.startsWith("src/web-ui/browser/");
    // These are possible writes, not proof that the corresponding branch executes.
    const produceExpression = (node, kind) => {
      const value = staticText(node);
      if (value !== null) {
        produce(value, kind);
        return;
      }
      if (node) ts.forEachChild(node, (child) => produceExpression(child, kind));
    };
    const consume = (node, tokens) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const token of new Set(tokens)) {
        const sites = consumers.get(token) ?? [];
        sites.push({ file: path, line, owner: ownerOf(node) });
        consumers.set(token, sites);
      }
    };
    const visit = (node) => {
      // Literal HTML templates, including static pieces of interpolated templates.
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        for (const match of node.text.matchAll(/\b(id|class)\s*=\s*["']([^"']*)["']/g)) {
          produce(match[2], match[1]);
        }
      }
      if (ts.isJsxAttribute(node) && ["id", "className"].includes(node.name.getText())) {
        produceExpression(node.initializer, node.name.getText() === "id" ? "id" : "class");
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)) {
        const name = node.left.name.text;
        if (name === "id" || name === "className") {
          produceExpression(node.right, name === "id" ? "id" : "class");
        }
      }
      if (ts.isCallExpression(node)) {
        const call = node.expression;
        const name = ts.isPropertyAccessExpression(call) ? call.name.text
          : ts.isIdentifier(call) ? call.text : "";
        const classList = ts.isPropertyAccessExpression(call)
          && ts.isPropertyAccessExpression(call.expression)
          && call.expression.name.text === "classList";
        if (name === "classNames") {
          for (const arg of node.arguments) produceExpression(arg, "class");
        }
        if (name === "setAttribute") {
          const attr = staticText(node.arguments[0]);
          if (attr === "id" || attr === "class") produceExpression(node.arguments[1], attr);
        }
        if (classList && ["add", "toggle", "replace"].includes(name)) {
          const args = name === "replace" ? [node.arguments[1]]
            : name === "toggle" ? [node.arguments[0]] : node.arguments;
          for (const arg of args) produceExpression(arg, "class");
        }
        if (legacy) {
          if (classList) {
            const args = ["toggle", "contains"].includes(name)
              ? [node.arguments[0]] : node.arguments;
            consume(node, args.flatMap((arg) => {
              const value = staticText(arg);
              return value !== null && TOKEN.test(value) ? ["." + value] : [];
            }));
          } else if (["getElementById", "getElementsByClassName", "querySelector",
            "querySelectorAll", "closest", "matches"].includes(name)) {
            const value = staticText(node.arguments[0]);
            if (value === null) dynamicQueries++;
            else consume(node, name === "getElementById" ? ["#" + value]
              : name === "getElementsByClassName" ? value.split(/\s+/).map((s) => "." + s)
              : selectorTokens(value));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const candidates = [...consumers].filter(([token]) => !producers.has(token))
    .map(([token, sites]) => ({ token, hasCss: cssRules.has(token), sites }))
    .sort((a, b) => a.token.localeCompare(b.token));
  return { candidates, consumerTargets: consumers.size, dynamicQueries };
}

function sourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "vendor"].includes(entry.name)) walk(path);
      } else if (/\.(tsx?|css)$/.test(entry.name)
        && !["embedded-assets.ts", "tailwind.css"].includes(entry.name)) {
        files.push({ path: relative(root, path).split("\\").join("/"), text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(join(root, "src/web-ui"));
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const report = auditSources(sourceFiles(root));
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("静态候选：发现消费者，但未识别到字面量生产者（不代表死代码）");
    for (const item of report.candidates) {
      console.log(`\n${item.token}${item.hasCss ? " [有 CSS 规则]" : ""}`);
      for (const site of item.sites) console.log(`  ${site.file}:${site.line} (${site.owner})`);
    }
    console.log(`\n${report.candidates.length} 个候选 / ${report.consumerTargets} 个目标；`
      + `${report.dynamicQueries} 处动态查询未解析。`);
    console.log("变量拼接、第三方组件、运行分支仍需人工与浏览器核对；此工具不自动删除代码。");
  }
  if (process.argv.includes("--fail-on-found") && report.candidates.length) process.exitCode = 1;
}
