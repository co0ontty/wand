import assert from "node:assert/strict";
import test from "node:test";
import { speechSupport } from "../src/speech-support.ts";
import { getLoginShellEnv, setLoginShellEnv } from "../src/env-utils.ts";

test("speech support accepts an existing runtime without requiring build tools", async () => {
  assert.deepEqual(await speechSupport(true), { supported: true, reason: null });
});

test("speech support distinguishes a bad custom runtime from missing build tools", async () => {
  const previousPath = process.env.PATH, previousBin = process.env.WAND_WHISPER_BIN, login = getLoginShellEnv();
  try {
    setLoginShellEnv(undefined); process.env.PATH = "/nonexistent-wand-speech-tools";
    process.env.WAND_WHISPER_BIN = "/unavailable-runtime";
    assert.match((await speechSupport(false)).reason!, /WAND_WHISPER_BIN/);
    delete process.env.WAND_WHISPER_BIN;
    const result = await speechSupport(false);
    assert.equal(result.supported, false);
    for (const name of ["Git", "CMake", "C++ 编译器"]) assert.ok(result.reason?.includes(name));
    assert.ok(!result.reason?.includes("/nonexistent"));
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.WAND_WHISPER_BIN; else process.env.WAND_WHISPER_BIN = previousBin;
    setLoginShellEnv(login);
  }
});
