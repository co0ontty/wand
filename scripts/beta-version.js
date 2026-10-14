import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function computeLocalBaseVersion(versions) {
  const bases = versions.map(version => typeof version === "string" ? version.replace(/^v/, "").split(/[+-]/)[0] : "")
    .filter(version => stablePattern.test(version))
    .map(version => version.split(".").map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  if (!bases.length) throw new Error("No valid local Beta base version");
  return bases.at(-1).join(".");
}

export function computeBetaVersion(tags, publishedStable, run, attempt, sha) {
  if (!stablePattern.test(publishedStable)) throw new Error("npm latest must be a stable version");
  if (!/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt) || !/^[a-f0-9]{7,40}$/.test(sha)) {
    throw new Error("Expected CI run number, attempt and commit SHA");
  }
  // Include npm latest: local releases need not have a corresponding Git tag.
  const versions = [...tags.map(tag => tag.replace(/^v/, "")), publishedStable]
    .filter(version => stablePattern.test(version))
    .map(version => version.split(".").map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [major, minor, patch] = versions.at(-1);
  return `${major}.${minor}.${patch + 1}-beta.${run}.${attempt}.g${sha}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--local") {
    let installed = "";
    try { installed = JSON.parse(readFileSync(process.argv[5], "utf8")).version ?? ""; } catch {}
    console.log(computeLocalBaseVersion([process.argv[3], process.argv[4], installed]));
  } else {
    const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).trim().split("\n");
    const stable = execFileSync("npm", ["view", "@co0ontty/wand@latest", "version", "--registry=https://registry.npmjs.org"], {
      encoding: "utf8", timeout: 30_000,
    }).trim();
    const sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
    console.log(computeBetaVersion(tags, stable, process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT, sha));
  }
}
