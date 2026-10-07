import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
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

async function recordGraph(target, metafile) {
  const output = path.join(root, "output", "web-ui-library-migration", "bundle-graphs");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `${path.basename(target)}.json`), JSON.stringify(metafile, null, 2));
}

try {
  await bundle(commonOptions);
  await bundle(
    { ...commonOptions, entryPoints: [AI_TEAMS_CHUNK_ENTRY], outfile: AI_TEAMS_CHUNK_OUTFILE },
    [createAiTeamsHostPlugin()],
  );
} catch (error) {
  // esbuild's default logger already printed the build (or plugin) error;
  // rethrowing here would be silent, so surface non-build failures explicitly.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bundle-browser] bundling aborted: ${message}`);
  process.exit(1);
}

console.log(`browser scripts bundled successfully (${isProduction ? "production" : "development"})`);
