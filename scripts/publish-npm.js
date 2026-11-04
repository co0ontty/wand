import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@co0ontty/wand";
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

export async function readPublication(version, tag, fetchImpl = fetch) {
  // Version and channel endpoints avoid depending on a cached full packument.
  // These anonymous requests never send NODE_AUTH_TOKEN.
  const request = path => {
    const url = new URL(path, "https://registry.npmjs.org");
    url.searchParams.set("wand-verification", randomUUID());
    return fetchImpl(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
  };
  const packagePath = PACKAGE.replace("/", "%2f");
  const [versionResponse, tagsResponse] = await Promise.all([
    request(`/${packagePath}/${encodeURIComponent(version)}`),
    request(`/-/package/${packagePath}/dist-tags`),
  ]);
  if (!versionResponse.ok && versionResponse.status !== 404) {
    throw new Error(`Registry version verification returned HTTP ${versionResponse.status}`);
  }
  if (!tagsResponse.ok) throw new Error(`Registry channel verification returned HTTP ${tagsResponse.status}`);
  const [document, tags] = await Promise.all([
    versionResponse.ok ? versionResponse.json() : null,
    tagsResponse.json(),
  ]);
  if (document && (document.name !== PACKAGE || document.version !== version)) {
    throw new Error("Registry verification returned the wrong package version");
  }
  const taggedVersion = typeof tags[tag] === "string" ? tags[tag] : null;
  let downloadable = false;
  let tarballError = null;
  if (document) {
    try {
      const tarball = new URL(document.dist?.tarball);
      if (tarball.origin !== "https://registry.npmjs.org") throw new Error("Registry returned an unexpected tarball origin");
      const integrity = typeof document.dist?.integrity === "string" ? document.dist.integrity : "";
      const digests = integrity.trim().split(/\s+/)
        .map(entry => /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?\S*)?$/.exec(entry)).filter(Boolean);
      const algorithm = ["sha512", "sha384", "sha256"].find(candidate => digests.some(digest => digest[1] === candidate));
      if (!algorithm) throw new Error("Registry tarball integrity is missing or unsupported");
      tarball.searchParams.set("wand-verification", randomUUID());
      const response = await fetchImpl(tarball, {
        method: "GET", headers: { "Cache-Control": "no-cache" }, redirect: "error",
        cache: "no-store", signal: AbortSignal.timeout(60_000),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`Registry tarball download returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Registry tarball download returned no body");
      const hash = createHash(algorithm);
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        hash.update(chunk);
      }
      if (bytes === 0) throw new Error("Registry tarball download was empty");
      const actual = hash.digest("base64");
      if (!digests.some(digest => digest[1] === algorithm && digest[2] === actual)) {
        throw new Error(`Registry tarball ${algorithm} integrity mismatch`);
      }
      downloadable = true;
    } catch (error) {
      // Retain known metadata on every blob failure; never reupload an existing version.
      tarballError = error instanceof Error ? error.message : "Registry tarball verification failed";
    }
  }
  return { exists: document?.version === version, tagged: taggedVersion === version, taggedVersion, downloadable, tarballError };
}

function newerStableVersion(actual, expected) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (typeof actual !== "string" || !stable.test(actual) || !stable.test(expected)) return false;
  const left = actual.split(".").map(BigInt);
  const right = expected.split(".").map(BigInt);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
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
  if (tag === "latest" && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("The latest channel only accepts stable X.Y.Z releases");
  }
  const deps = { read: readPublication, npm, sleep, now: Date.now, log: console.log, ...overrides };
  const read = async () => {
    try { return await deps.read(version, tag); }
    catch { deps.log("Registry verification is temporarily unavailable; retrying."); return { exists: false, tagged: false }; }
  };
  const superseded = state => tag === "latest" && newerStableVersion(state.taggedVersion, version);
  const confirmed = state => {
    if (!state.exists || !state.downloadable) return false;
    if (state.tagged) return true;
    if (superseded(state)) {
      deps.log(`${PACKAGE}@${version} is published; keeping newer latest ${state.taggedVersion}.`);
      return true;
    }
    return false;
  };
  const wait = async () => {
    const deadline = deps.now() + 15 * 60_000;
    while (true) {
      const state = await read();
      if (confirmed(state)) return true;
      if (deps.now() >= deadline) return false;
      deps.log(`Waiting for ${PACKAGE}@${version}: version visible=${state.exists}, tarball verified=${!!state.downloadable}${state.tarballError ? ` (${state.tarballError})` : ""}, ${tag}=${state.taggedVersion ?? "unavailable"}...`);
      await deps.sleep(Math.min(10_000, deadline - deps.now()));
    }
  };
  const existing = await read();
  if (confirmed(existing)) return true;
  if (existing.exists) {
    if (!existing.tagged && !superseded(existing)
      && !await deps.npm(["dist-tag", "add", `${PACKAGE}@${version}`, tag])) return false;
    return await wait();
  }
  if (superseded(existing)) {
    deps.log(`Refusing to publish ${version} over newer latest ${existing.taggedVersion}. Use a newer stable version.`);
    return false;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (await deps.npm(["publish", "--ignore-scripts", "--access", "public", "--tag", tag])) {
      // A successful write must never be submitted again while reads propagate.
      return await wait();
    }
    const state = await read();
    if (confirmed(state)) return true;
    if (state.exists) {
      if (!state.tagged && !superseded(state)
        && !await deps.npm(["dist-tag", "add", `${PACKAGE}@${version}`, tag])) return false;
      return await wait();
    }
    if (superseded(state)) {
      deps.log(`A newer latest ${state.taggedVersion} appeared; not retrying publication of ${version}.`);
      return false;
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
