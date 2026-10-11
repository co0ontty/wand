import ts from "typescript";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isBrowserStyleFile, minifyStringRawCssTemplates } from "./browser-style-minification.js";

/** Native component entrypoints avoid an all-controls barrel becoming one eager
 * shared chunk. Derive mappings from the installed library, never hand-maintain
 * a second component list. Source imports and team-IIFE sharing remain unchanged. */
export async function createBrowserModuleImportsPlugin(root, production) {
  const libraries = new Map();
  for (const name of ["antd", "@ant-design/x"]) {
    const directory = path.join(root, "node_modules", name, "es");
    const index = ts.createSourceFile("index.js", await readFile(path.join(directory, "index.js"), "utf8"), ts.ScriptTarget.Latest, true);
    const exports = new Map();
    for (const statement of index.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !statement.exportClause
        || !ts.isNamedExports(statement.exportClause)) continue;
      for (const item of statement.exportClause.elements) {
        if (item.propertyName?.text === "default") exports.set(item.name.text,
          path.join(directory, statement.moduleSpecifier.text).split(path.sep).join("/"));
      }
    }
    libraries.set(name, exports);
  }
  return {
    name: "wand-browser-component-imports",
    setup(build) {
      build.onLoad({ filter: /\.[jt]sx?$/ }, async args => {
        if (!args.path.startsWith(path.join(root, "src") + path.sep)
          && !args.path.startsWith(path.join(root, "node_modules/@ant-design/x/es") + path.sep)) return;
        let source = await readFile(args.path, "utf8");
        if (production && isBrowserStyleFile(args.path)) source = minifyStringRawCssTemplates(source, args.path).code;
        const ast = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true);
        const edits = [];
        for (const statement of ast.statements) {
          if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
          const specifier = statement.moduleSpecifier.text;
          const library = specifier === "antd" || /(?:^|\/)design-library(?:\.js)?$/.test(specifier) ? "antd"
            : specifier === "@ant-design/x" || /(?:^|\/)x-library(?:\.js)?$/.test(specifier) ? "@ant-design/x" : null;
          const bindings = statement.importClause.namedBindings;
          if (!library || !bindings || !ts.isNamedImports(bindings)) continue;
          if (statement.importClause.name) throw new Error(`Mixed default/named import not supported: ${specifier}`);
          const declarations = [];
          for (const item of bindings.elements) {
            if (item.isTypeOnly) continue;
            const name = item.propertyName?.text ?? item.name.text;
            const target = libraries.get(library).get(name);
            if (!target) throw new Error(`No native ${library} entry for ${name}`);
            declarations.push(`import ${item.name.text} from ${JSON.stringify(target)};`);
          }
          edits.push({ start: statement.getStart(ast), end: statement.end, text: declarations.join("\n") });
        }
        for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
        return { contents: source, loader: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".ts") ? "ts" : "js" };
      });
    },
  };
}
