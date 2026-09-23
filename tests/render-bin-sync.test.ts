import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = "0.1.2";
const TRIPLE = "darwin-arm64";

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("render-bin release sync verifies and retains both artifacts without rewriting identical sidecars", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-bin-sync-"));
  try {
    const fixtureDir = path.join(root, "release");
    const assetDir = path.join(fixtureDir, "archive", TRIPLE);
    const binDir = path.join(root, "bin");
    mkdirSync(assetDir, { recursive: true });
    mkdirSync(binDir);
    const render = path.join(assetDir, "wand-render");
    const structured = path.join(assetDir, "wand-structured-renderd");
    writeFileSync(render, "#!/bin/sh\necho 'wand-render 0.1.2 (protocol 1)'\n");
    writeFileSync(structured, "#!/bin/sh\necho 'wand-structured-render 0.1.2 (protocol 2)'\n");
    chmodSync(render, 0o755);
    chmodSync(structured, 0o755);
    const artifact = {
      rustTarget: "aarch64-apple-darwin",
      sha256: sha256(render), size: statSync(render).size,
      structured: { protocolVersion: 2, sha256: sha256(structured), size: statSync(structured).size },
    };
    writeFileSync(path.join(fixtureDir, "manifest.json"), JSON.stringify({
      schemaVersion: 1, latest: VERSION,
      versions: { [VERSION]: { protocolVersion: 1, minServerVersion: "4.73.0",
        triples: { [TRIPLE]: artifact } } },
    }));
    execFileSync("tar", ["-czf", path.join(fixtureDir, `wand-render-${VERSION}-${TRIPLE}.tar.gz`),
      "-C", path.join(fixtureDir, "archive"), TRIPLE]);

    const script = path.join(binDir, "sync.mjs");
    copyFileSync(path.join(ROOT, "render-bin/scripts/sync.mjs"), script);
    const mockFetch = path.join(root, "mock-fetch.mjs");
    writeFileSync(mockFetch, `import { readFile } from "node:fs/promises";
import path from "node:path";
globalThis.fetch = async (url) => {
  const name = path.basename(new URL(url).pathname);
  if (!/^(manifest\\.json|wand-render-0\\.1\\.2-darwin-arm64\\.tar\\.gz)$/.test(name)) {
    throw new Error("Unexpected release asset");
  }
  return new Response(await readFile(path.join(process.env.WAND_SYNC_FIXTURE_DIR, name)));
};
`);
    const env = { ...process.env, WAND_SYNC_FIXTURE_DIR: fixtureDir };
    const sync = (): string => execFileSync(process.execPath,
      ["--import", mockFetch, script, "--version", VERSION], { env, encoding: "utf8" });
    sync();
    const targetDir = path.join(root, `v${VERSION}`, TRIPLE);
    const manifestPath = path.join(root, "manifest.json");
    assert.equal(sha256(path.join(targetDir, "wand-render")), artifact.sha256);
    assert.equal(sha256(path.join(targetDir, "wand-structured-renderd")), artifact.structured.sha256);
    assert.equal(statSync(path.join(targetDir, "wand-structured-renderd")).mode & 0o777, 0o755);
    const result = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(result.versions[VERSION].triples[TRIPLE].structured.protocolVersion, 2);
    const sidecar = path.join(targetDir, "wand-structured-renderd.sha256");
    const timestamps = [statSync(sidecar, { bigint: true }).mtimeNs,
      statSync(manifestPath, { bigint: true }).mtimeNs];
    assert.match(sync(), /manifest 无变化/);
    assert.deepEqual([statSync(sidecar, { bigint: true }).mtimeNs,
      statSync(manifestPath, { bigint: true }).mtimeNs], timestamps);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
