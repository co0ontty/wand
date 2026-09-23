import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderPaths } from "../src/render-protocol.js";
import {
  STRUCTURED_RENDER_PROTOCOL_VERSION,
  decodeRenderFrames,
  encodeRenderFrame,
  structuredRenderPaths,
  type StructuredRenderEvent,
} from "../src/render-structured-protocol.js";

test("structured v2 framing and namespace are separate from PTY v1", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-structured-protocol-"));
  try {
    const config = path.join(dir, "config.json");
    const alias = path.join(dir, "config-alias.json");
    writeFileSync(config, "{}", { mode: 0o600 });
    symlinkSync(config, alias);
    const paths = structuredRenderPaths(config);
    const ptyPaths = renderPaths(config);
    assert.deepEqual(structuredRenderPaths(alias), paths);
    for (const key of ["socketPath", "tokenPath", "pidPath", "metaPath"] as const) {
      assert.notEqual(paths[key], ptyPaths[key]);
    }
    assert.match(paths.socketPath, /wand-structured-render-\d+-[0-9a-f]{12}\.sock$/);
    assert.equal(STRUCTURED_RENDER_PROTOCOL_VERSION, 2);
    const event: StructuredRenderEvent = {
      event: "stream", runId: "structured:fixture", incarnationId: "fixture-incarnation",
      stream: "stderr", seq: 2, data: "中文💡",
    };
    const encoded = encodeRenderFrame(event);
    const partial = decodeRenderFrames<StructuredRenderEvent>(encoded.subarray(0, 5));
    assert.deepEqual(partial.frames, []);
    const complete = decodeRenderFrames<StructuredRenderEvent>(encoded);
    assert.deepEqual(complete.frames, [event]);
    assert.equal(complete.rest.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
