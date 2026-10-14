import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function stageLocalPackage(projectRoot, stageRoot, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error("Invalid local package version");
  }
  const root = realpathSync(projectRoot);
  const absoluteStage = path.resolve(stageRoot);
  const stage = path.join(realpathSync(path.dirname(absoluteStage)), path.basename(absoluteStage));
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Local package needs an explicit files list");
  const files = manifest.files.map(entry => {
    if (typeof entry !== "string" || !entry || entry === "." || path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..") || /[*?\[\]]/.test(entry)) {
      throw new Error("Local package files must be explicit repository-relative paths");
    }
    if (!existsSync(path.join(root, entry))) throw new Error(`Local package file is missing: ${entry}`);
    return entry;
  });
  const buildInfo = JSON.parse(readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
  if (buildInfo.version !== version) throw new Error(`Build version ${buildInfo.version} does not match local package ${version}`);
  if (root === stage || stage.startsWith(root + path.sep)) throw new Error("Local package staging must be outside the shared workspace");
  mkdirSync(stage, { mode: 0o700 });
  for (const entry of files) {
    const destination = path.join(stage, entry);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, entry), destination, { recursive: true, dereference: true });
  }
  for (const name of readdirSync(root)) {
    if (/^(readme|licen[cs]e|copying)(?:\..*)?$/i.test(name)) cpSync(path.join(root, name), path.join(stage, name));
  }
  writeFileSync(path.join(stage, "package.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  const copiedBuild = JSON.parse(readFileSync(path.join(stage, "dist/build-info.json"), "utf8"));
  if (copiedBuild.version !== version) throw new Error("Build changed during local package staging");
  return stage;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(stageLocalPackage(process.argv[2], process.argv[3], process.argv[4])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
