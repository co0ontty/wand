import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Content-address the static dependency graph. Dynamic edges use a small
 * document-owned lookup installed by boot.ts, so editing an optional feature
 * does not invalidate the cold runtime (nor unrelated optional features).
 * Static cycles share a component hash; a dependent changes when its imported
 * bytes change. No global graph hash appears in the published module URLs. */
export function addressBrowserModules(outputs, metadata, root) {
  const files = new Map(outputs.map(file => [path.resolve(file.path), file]));
  const nodes = new Map();
  const ids = new Set();
  for (const [file, output] of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const meta = metadata.outputs[relative];
    const identity = path.basename(file) === "runtime.js" ? "runtime"
      : meta?.entryPoint ?? `shared:${Object.keys(meta?.inputs ?? {}).sort().join("\n")}`;
    const id = hash(identity);
    if (ids.has(id)) throw new Error(`Duplicate browser module identity: ${identity}`);
    ids.add(id);
    nodes.set(file, { file, code: output.code, id, identity, edges: new Set(), edits: [], dynamic: new Set() });
  }
  for (const node of nodes.values()) {
    const ast = ts.createSourceFile(node.file, node.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const targetOf = literal => nodes.get(path.resolve(path.dirname(node.file), literal.text));
    function visit(item) {
      if ((ts.isImportDeclaration(item) || ts.isExportDeclaration(item)) && item.moduleSpecifier && ts.isStringLiteral(item.moduleSpecifier)) {
        const target = targetOf(item.moduleSpecifier);
        if (target) {
          node.edges.add(target);
          node.edits.push({ start: item.moduleSpecifier.getStart(ast), end: item.moduleSpecifier.end, target });
        } else if (item.moduleSpecifier.text.startsWith(".")) throw new Error(`Missing static module in ${node.file}: ${item.moduleSpecifier.text}`);
      }
      if (ts.isCallExpression(item) && item.expression.kind === ts.SyntaxKind.ImportKeyword && item.arguments.length === 1 && ts.isStringLiteral(item.arguments[0])) {
        const target = targetOf(item.arguments[0]);
        if (target) {
          node.dynamic.add(target);
          node.edits.push({ start: item.getStart(ast), end: item.end, dynamic: true, target });
        } else if (item.arguments[0].text.startsWith(".")) throw new Error(`Missing dynamic module in ${node.file}: ${item.arguments[0].text}`);
      }
      ts.forEachChild(item, visit);
    }
    visit(ast);
    node.edits.sort((a, b) => b.start - a.start);
  }
  function rewrite(node, resolve) {
    let code = node.code;
    for (const edit of node.edits) {
      const value = edit.dynamic
        ? `globalThis.__wandImportBrowserModule(${JSON.stringify(edit.target.id)})`
        : JSON.stringify(resolve(edit.target));
      code = code.slice(0, edit.start) + value + code.slice(edit.end);
    }
    return code;
  }

  // Tarjan: cycles are addressed together, not by an unstable fixed-point hash.
  let index = 0;
  const stack = [], components = [];
  function connect(node) {
    node.index = node.low = index++;
    stack.push(node); node.stacked = true;
    for (const target of node.edges) {
      if (target.index === undefined) { connect(target); node.low = Math.min(node.low, target.low); }
      else if (target.stacked) node.low = Math.min(node.low, target.index);
    }
    if (node.low === node.index) {
      const component = { nodes: [] };
      let item;
      do { item = stack.pop(); item.stacked = false; item.component = component; component.nodes.push(item); } while (item !== node);
      components.push(component);
    }
  }
  for (const node of nodes.values()) if (node.index === undefined) connect(node);
  function fingerprint(component) {
    if (component.hash) return component.hash;
    const dependencies = new Map();
    for (const node of component.nodes) for (const target of node.edges) if (target.component !== component) dependencies.set(target.id, fingerprint(target.component));
    component.hash = hash(JSON.stringify({
      code: component.nodes.map(node => [node.id, rewrite(node, target => `@wand/${target.id}`)]).sort(([a], [b]) => a.localeCompare(b)),
      dependencies: [...dependencies].sort(([a], [b]) => a.localeCompare(b)),
    }));
    return component.hash;
  }
  const published = new Map();
  for (const node of nodes.values()) {
    const name = path.basename(node.file).replace(/-[A-Z0-9]{8}\.js$/, ".js");
    published.set(node.file, `modules/${fingerprint(node.component)}/${name}`);
  }
  if (new Set(published.values()).size !== published.size) throw new Error("Browser module address collision");
  const addressed = outputs.map(output => {
    const node = nodes.get(path.resolve(output.path));
    return { path: published.get(node.file), code: rewrite(node, target => `/assets/${published.get(target.file)}`) };
  });
  const imports = {};
  for (const node of nodes.values()) for (const target of node.dynamic) imports[target.id] = published.get(target.file);
  const buildId = hash(JSON.stringify(addressed.map(file => [file.path, file.code]).sort(([a], [b]) => a.localeCompare(b))));
  const dependencies = Object.fromEntries([...nodes.values()].map(node => [published.get(node.file), [...node.edges].map(target => published.get(target.file)).sort()]));
  return { outputs: addressed, published, imports, dependencies, buildId };
}
