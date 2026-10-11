import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@co0ontty/wand";
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

export async function readPublication(version, tag, fetchImpl = fetch) {
  // A unique public metadata request avoids polling the same CDN representation.
  // Do not send NODE_AUTH_TOKEN to this read-only endpoint or cache credentials.
  const url = new URL(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}`);
  url.searchParams.set("wand-verification", randomUUID());
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Registry verification returned HTTP ${response.status}`);
  const document = await response.json();
  if (document.name !== PACKAGE) throw new Error("Registry verification returned the wrong package");
  return {
    exists: document.versions?.[version]?.version === version,
    tagged: document["dist-tags"]?.[tag] === version,
  };
}

function npm(args) {
  return new Promise(resolveCommand => {
    const child = spawn("npm", args, { stdio: "inherit" });
    child.once("error", () => resolveCommand(false));
    child.once("exit", code => resolveCommand(code === 0));
  });
}

export async function publish(version, tag, overrides = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version) || !["latest", "beta"].includes(tag)) {
    throw new Error("Expected a release version and latest/beta tag");
  }
  const deps = { read: readPublication, npm, sleep, now: Date.now, log: console.log, ...overrides };
  const read = async () => {
    try { return await deps.read(version, tag); }
    catch { deps.log("Registry verification is temporarily unavailable; retrying."); return { exists: false, tagged: false }; }
  };
  const wait = async () => {
    const deadline = deps.now() + 360_000;
    while (true) {
      const state = await read();
      if (state.exists && state.tagged) return true;
      if (deps.now() >= deadline) return false;
      deps.log(`Waiting for ${PACKAGE}@${version} and ${tag} to become visible...`);
      await deps.sleep(Math.min(10_000, deadline - deps.now()));
    }
  };
  const existing = await read();
  if (existing.exists) {
    if (!existing.tagged && !await deps.npm(["dist-tag", "add", `${PACKAGE}@${version}`, tag])) return false;
    return existing.tagged || await wait();
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (await deps.npm(["publish", "--ignore-scripts", "--access", "public", "--tag", tag])) {
      // A successful write must never be submitted again while reads propagate.
      return await wait();
    }
    const state = await read();
    if (state.exists) {
      if (!state.tagged && !await deps.npm(["dist-tag", "add", `${PACKAGE}@${version}`, tag])) return false;
      return state.tagged || await wait();
    }
    if (attempt < 5) await deps.sleep(attempt * 30_000);
  }
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!await publish(process.argv[2], process.argv[3])) {
      console.error("npm publication or registry verification did not complete.");
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
