import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(
  readFileSync(new URL("../../src/web-ui/browser/session-fetch.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

/** Keep the production request wrapper inside each legacy harness's fetch boundary. */
export function sessionFetchModule(fetchImpl: unknown): typeof import("../../src/web-ui/browser/session-fetch.js") {
  const api = {};
  runInNewContext(code, { exports: api, fetch: fetchImpl, Headers });
  return api as typeof import("../../src/web-ui/browser/session-fetch.js");
}
