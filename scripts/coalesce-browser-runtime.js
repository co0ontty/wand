import { build } from "esbuild";
import ts from "typescript";
import path from "node:path";

/** Collapse the eagerly shared graph into one module. esbuild's default splitter
 * can otherwise create dozens of tiny requests. Lazy views import this module's
 * exact bindings, keeping one React runtime and one controller instance. */
export async function coalesceBrowserRuntime(outputs, eager, entry, root, production, { preserveDynamicImports = false } = {}) {
  const files = new Map(outputs.map(file => [path.resolve(file.path), file.code]));
  const eagerPaths = new Set([...eager].map(file => path.resolve(root, file)));
  const aliases = new Map();
  const exports = [];
  for (const [index, file] of [...eagerPaths].entries()) {
    const ast = ts.createSourceFile(file, files.get(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Map();
    for (const statement of ast.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const item of statement.exportClause.elements) names.set(item.name.text, `shared${index}_${item.name.text}`);
    }
    aliases.set(file, names);
    if (names.size) exports.push(`export { ${[...names].map(([name, alias]) => `${name} as ${alias}`).join(",")} } from ${JSON.stringify(file)};`);
  }
  const runtime = await build({
    stdin: { contents: `import ${JSON.stringify(path.resolve(root, entry))};\n${exports.join("\n")}`, resolveDir: root, loader: "js" },
    bundle: true, format: "esm", platform: "browser", target: "es2020", minify: production,
    write: false, legalComments: "none",
    plugins: [{ name: "coalesce-eager", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const file = path.resolve(args.resolveDir, args.path);
        if (eagerPaths.has(file)) return { path: file, namespace: "eager" };
        if (files.has(file)) return { path: `./${path.basename(file)}`, external: true };
        return;
      });
      builder.onLoad({ filter: /.*/, namespace: "eager" }, args => ({
        contents: files.get(args.path), loader: "js", resolveDir: path.dirname(args.path),
      }));
    } }],
  });
  const optional = outputs.filter(file => !eagerPaths.has(path.resolve(file.path))).map(file => {
    let code = file.code;
    const ast = ts.createSourceFile(file.path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const edits = [];
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const target = path.resolve(path.dirname(file.path), statement.moduleSpecifier.text);
      if (!eagerPaths.has(target)) continue;
      const clause = statement.importClause;
      if (!clause) {
        edits.push({ start: statement.getStart(ast), end: statement.end, text: 'import "./runtime.js";' });
        continue;
      }
      if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        throw new Error(`Unexpected eager import shape in ${file.path}`);
      }
      const names = clause.namedBindings.elements.map(item => {
        const name = item.propertyName?.text ?? item.name.text;
        const alias = aliases.get(target)?.get(name);
        if (!alias) throw new Error(`Missing shared export ${name} in ${target}`);
        return `${alias} as ${item.name.text}`;
      });
      edits.push({ start: statement.getStart(ast), end: statement.end, text: `import{${names.join(",")}}from"./runtime.js";` });
    }
    for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    return { ...file, code };
  });
  // Browsers cache failed module loads by URL. An explicit user retry needs a
  // fresh entry URL; its relative imports still share the canonical runtime.
  let runtimeCode = runtime.outputFiles[0].text;
  const ast = ts.createSourceFile("runtime.js", runtimeCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      imports.push({ start: node.expression.getStart(ast), end: node.expression.end });
    }
    ts.forEachChild(node, visit);
  };
  if (!preserveDynamicImports) visit(ast);
  for (const edit of imports.reverse()) runtimeCode = runtimeCode.slice(0, edit.start) + "__wandImportOptional" + runtimeCode.slice(edit.end);
  if (imports.length) runtimeCode = `const __wandModuleAttempts=new Map();
function __wandImportOptional(specifier){
  const url=new URL(specifier,import.meta.url),attempt=__wandModuleAttempts.get(specifier)||0;
  if(attempt)url.searchParams.set("wandModuleRetry",String(attempt));
  return import(url.href).catch(error=>{__wandModuleAttempts.set(specifier,attempt+1);throw error});
}
` + runtimeCode;
  return [{ path: path.join(path.dirname(path.resolve(root, entry)), "runtime.js"), code: runtimeCode }, ...optional];
}
