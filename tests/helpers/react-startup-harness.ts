import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as React from "react";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Follow the public export, so moving its implementation does not change the contract. */
export function exportedSource(file: string, name: string): string {
  const absolute = resolve(root, file);
  const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return absolute;
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const binding = statement.exportClause.elements.find(element => element.name.text === name);
    if (!binding) continue;
    const target = resolve(dirname(absolute), statement.moduleSpecifier.text).replace(/\.js$/, "");
    const dependency = [target + ".ts", target + ".tsx", resolve(target, "index.ts")].find(existsSync);
    assert.ok(dependency, `unresolved export ${name} from ${absolute}`);
    return exportedSource(dependency, binding.propertyName?.text ?? name);
  }
  throw new Error(`Missing public export ${name} in ${absolute}`);
}

export const reactStartupSource = exportedSource("src/web-ui/react/index.tsx", "startReactUi");

/** Execute real module code; replace only explicit host boundaries. */
export function loadReactModule(file: string, overrides: Record<string, unknown> = {}, globals: Record<string, unknown> = {}) {
  const absolute = resolve(root, file);
  const require = createRequire(absolute);
  const api: Record<string, any> = {};
  const code = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
    fileName: absolute,
  }).outputText;
  runInNewContext(code, { exports: api, require: (id: string) => overrides[id] ?? require(id), ...globals });
  return { api, require };
}

export function createReactStartupHarness(page = false, genericEnabled = true) {
  class Element {
    id = ""; className = ""; dataset: Record<string, string> = {};
    parentElement: Element | null = null; children: Element[] = [];
    appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child; }
  }
  const body = new Element();
  const find = (element: Element, id: string): Element | undefined => element.id === id ? element
    : element.children.map(child => find(child, id)).find(Boolean);
  const roots: Element[] = [], renders: React.ReactElement[] = [], effects: string[] = [];
  const window: Record<string, unknown> = {};
  const { api, require } = loadReactModule(reactStartupSource, {
    "react-dom/client": { createRoot: (element: Element) => {
      roots.push(element); return { render: (tree: React.ReactElement) => renders.push(tree) };
    } },
    "../page.js": { isStandaloneSettingsPage: () => page },
    "./feature-flags": { isReactUiEnabled: () => genericEnabled },
    "./styles": { installReactUiStyles: () => effects.push("styles") },
    "./settings/history": { installSettingsHistory: () => effects.push("settings-history") },
    "./issues/task-board-controller": {
      ...createRequire(reactStartupSource)("./issues/task-board-controller"),
      installTaskBoardHistory: () => effects.push("task-history"),
    },
  }, { window, document: { body, createElement: () => new Element(), getElementById: (id: string) => find(body, id) } });
  return { start: api.startReactUi as () => unknown, window, roots, renders, effects, body, require };
}

/** Inspect the real host's direct component tree without mounting child effects or portals. */
export function overlayHostTree(presentation: "page" | "workspace") {
  const { api, require } = loadReactModule("src/web-ui/react/overlay-host.tsx", {
    react: { ...React, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() },
  });
  const nodes: React.ReactElement<any>[] = [];
  const visit = (value: React.ReactNode): void => {
    React.Children.forEach(value, child => {
      if (!React.isValidElement(child)) return;
      nodes.push(child);
      visit((child.props as { children?: React.ReactNode }).children);
    });
  };
  visit(api.OverlayHost({ portalContainer: {}, settingsPresentation: presentation }));
  return { nodes, require };
}
