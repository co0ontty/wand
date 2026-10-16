import { build } from "esbuild";
import { createHash } from "node:crypto";
import { coalesceBrowserRuntime } from "./coalesce-browser-runtime.js";
import { addressBrowserModules } from "./address-browser-modules.js";
import { createBrowserModuleImportsPlugin } from "./browser-module-imports.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBrowserStyleMinificationPlugin,
  poolEmittedCssStringLiterals,
} from "./browser-style-minification.js";
import {
  AI_TEAMS_CHUNK_ENTRY,
  AI_TEAMS_CHUNK_OUTFILE,
  createAiTeamsHostPlugin,
} from "./ai-teams-chunk.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isProduction = !process.argv.includes("--development");
const outfile = path.join(root, "src", "web-ui", "content", "scripts.js");

const commonOptions = {
  entryPoints: [path.join(root, "src", "web-ui", "browser", "main.ts")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  outfile,
  treeShaking: true,
  metafile: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
  },
  target: ["es2020"],
  platform: "browser",
};

// The style minifier is an esbuild plugin, which the sync API does not support,
// so production goes async. --development stays readable: no JS minify, no
// String.raw CSS template compression and no pooling.
//
// Production builds in memory (write:false): the plugin records every minified
// CSS fragment as a candidate, then pooling rewrites only the literals that
// actually survived into the emitted IIFE into one frozen pool, and only then
// is the outfile written once. Anything unexpected (extra emitted assets, a
// pooling AST failure) aborts before writing — never a partial bundle.
//
// The AI teams page + task run panel ship as a separate on-demand script
// (content/ai-teams.js, see scripts/ai-teams-chunk.js), built the same way; it
// borrows every shared module from the main bundle instead of copying it.
async function bundle(options, plugins = []) {
  const target = options.outfile;
  if (!isProduction) {
    const result = await build({ ...options, minify: false, plugins });
    await recordGraph(target, result.metafile);
    return;
  }
  const cssCandidates = new Set();
  const result = await build({
    ...options,
    minify: true,
    legalComments: "none",
    write: false,
    plugins: [...plugins, createBrowserStyleMinificationPlugin(cssCandidates)],
  });
  const outputFiles = result.outputFiles ?? [];
  if (outputFiles.length !== 1 || path.resolve(outputFiles[0].path) !== target) {
    throw new Error(
      `[bundle-browser] expected exactly one emitted asset at ${target}, ` +
        `got: ${outputFiles.map((file) => file.path).join(", ") || "none"}`,
    );
  }
  await recordGraph(target, result.metafile);
  const pooled = poolEmittedCssStringLiterals(outputFiles[0].text, cssCandidates);
  await writeFile(target, pooled.code);
  console.log(
    `[bundle-browser] ${path.basename(target)} CSS pooling: ${pooled.pooled} literals -> ${pooled.poolSize} pooled fragments`,
  );
}

// esbuild owns the ESM dependency graph, so shared React/controllers are singletons.
// Each output is pooled separately and remains independently executable.
async function bundleModules() {
  const outdir = path.join(root, "src/web-ui/content/modules");
  const { outfile: ignored, ...options } = commonOptions;
  const cssCandidates = new Set();
  const result = await build({ ...options,
    entryPoints: { main: path.join(root, "src/web-ui/browser/main.ts") },
    format: "esm", splitting: true, outdir, entryNames: "[name]-[hash]",
    chunkNames: "[name]-[hash]", minify: isProduction, legalComments: "none", write: false,
    plugins: [await createBrowserModuleImportsPlugin(root, isProduction, cssCandidates)],
  });
  // ESM pooling keeps imports/exports in module scope (no IIFE wrapper).
  let outputs = result.outputFiles.map(file => ({ path: file.path, code: file.text }));
  const meta = result.metafile;
  const entry = Object.keys(meta.outputs).find(file => meta.outputs[file].entryPoint === "src/web-ui/browser/main.ts");
  if (!entry) throw new Error("Missing browser module entry");
  const eager = new Set();
  const visit = file => {
    if (eager.has(file)) return;
    eager.add(file);
    for (const dependency of meta.outputs[file].imports) {
      if (!dependency.external && dependency.kind !== "dynamic-import") visit(dependency.path);
    }
  };
  visit(entry);
  // esbuild can emit orphan dynamic entries from unused third-party barrel exports.
  // Publish only the graph reachable from our actual entry, including lazy edges.
  const reachable = new Set();
  const visitAll = file => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const dependency of meta.outputs[file].imports) if (!dependency.external) visitAll(dependency.path);
  };
  visitAll(entry);
  outputs = outputs.filter(file => reachable.has(path.relative(root, file.path).split(path.sep).join("/")));
  for (const file of Object.keys(meta.outputs)) if (!reachable.has(file)) delete meta.outputs[file];
  outputs = await coalesceBrowserRuntime(outputs, eager, entry, root, isProduction, { preserveDynamicImports: true });
  if (isProduction) outputs = outputs.map(file => ({ ...file, code: poolEmittedCssStringLiterals(file.code, cssCandidates, { format: "esm" }).code }));
  const addressed = addressBrowserModules(outputs, meta, root);
  outputs = addressed.outputs;
  const runtime = outputs[0].path;
  const manifest = { buildId: addressed.buildId, entry: runtime, eager: [runtime], files: outputs.map(file => file.path),
    imports: addressed.imports, dependencies: addressed.dependencies,
    integrity: Object.fromEntries(outputs.map(file => [file.path, createHash("sha256").update(file.code).digest("hex")])),
    features: Object.fromEntries(Object.entries(meta.outputs).filter(([, value]) => value.entryPoint && value.entryPoint !== "src/web-ui/browser/main.ts")
      .map(([file, value]) => [value.entryPoint, addressed.published.get(path.resolve(root, file))]).filter(([, file]) => file)) };
  // Only generated build outputs are replaced; no source or user data is removed.
  await rm(outdir, { recursive: true, force: true });
  for (const file of outputs) {
    const target = path.join(path.dirname(outfile), file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.code);
  }
  await writeFile(path.join(path.dirname(outfile), "module-manifest.json"), JSON.stringify(manifest));
  meta.wandBuild = { id: manifest.buildId, manifest };
  await recordGraph(path.join(outdir, "main.js"), meta);
  console.log(`[bundle-browser] ESM: ${outputs.length} modules, 1 eager runtime`);
}

async function recordGraph(target, metafile) {
  const output = path.join(root, "output", "web-ui-library-migration", "bundle-graphs");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `${path.basename(target)}.json`), JSON.stringify(metafile, null, 2));
}

try {
  await bundleModules();
  await bundle({ ...commonOptions, entryPoints: [path.join(root, "src/web-ui/browser/boot.ts")] });
  await bundle(
    { ...commonOptions, entryPoints: [AI_TEAMS_CHUNK_ENTRY], outfile: AI_TEAMS_CHUNK_OUTFILE },
    [createAiTeamsHostPlugin()],
  );
  // Three.js and the procedural model stay out of the eagerly loaded shell.
  // The small React identity adapter loads this content-versioned asset once.
  await bundle({ ...commonOptions,
    entryPoints: [path.join(root, "src", "web-ui", "react", "avatars", "renderer.ts")],
    outfile: path.join(root, "src", "web-ui", "content", "plush-avatar.js"),
  });
} catch (error) {
  // esbuild's default logger already printed the build (or plugin) error;
  // rethrowing here would be silent, so surface non-build failures explicitly.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bundle-browser] bundling aborted: ${message}`);
  process.exit(1);
}

console.log(`browser scripts bundled successfully (${isProduction ? "production" : "development"})`);
