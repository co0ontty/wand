import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { uploadReferenceGuard } from "../src/upload-reference-guard.ts";

test("actual PTY and structured dispatch pin orphan references before continuing; unrelated GETs never write", () => {
  const events: unknown[] = [];
  const guard = uploadReferenceGuard({ retainManagedUploadReferences: (...args) => { events.push(args); } });
  for (const route of ["/sessions/id/input", "/structured-sessions/id/messages"]) {
    guard({ method: "POST", path: route, body: { input: "path" } } as Request, {} as Response, () => { events.push("next"); });
    assert.deepEqual(events.splice(0), [["id", '{"input":"path"}'], "next"]);
  }
  for (const [method, route] of [["GET", "/sessions/id/input"], ["POST", "/sessions/id/stop"], ["POST", "/sessions/%ZZ/input"]]) {
    guard({ method, path: route, body: {} } as Request, {} as Response, () => { events.push("next"); });
    assert.deepEqual(events.splice(0), ["next"]);
  }
});
