import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";

import { createUtf8TextDecoder, STRUCTURED_RUN_LOG_MAX_CHARS } from "../src/structured-exec-host.js";
import { startStructuredCli } from "../src/structured-exec-pump.js";
import type { StructuredRunnerTurnState } from "../src/structured-runner.js";

const JSON_LINE = '{"text":"你好🙂"}';

function splitUtf8At(text: string, byteOffset: number): [Buffer, Buffer] {
  const bytes = Buffer.from(text, "utf8");
  assert.ok(byteOffset > 0 && byteOffset < bytes.length, "split must be inside the buffer");
  return [bytes.subarray(0, byteOffset), bytes.subarray(byteOffset)];
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test("StringDecoder holds incomplete UTF-8 sequences across writes", () => {
  const decoder = createUtf8TextDecoder();
  const [head, tail] = splitUtf8At(JSON_LINE, 10); // mid 你
  assert.equal(decoder.write(head), '{"text":"');
  assert.equal(decoder.write(tail), '你好🙂"}');
  assert.equal(decoder.end(), "");
});

test("startStructuredCli round-trips a Chinese+emoji JSON line split mid-character", async () => {
  const child = new FakeChild();
  const lines: string[] = [];
  const stdoutChunks: string[] = [];
  const execution = startStructuredCli<StructuredRunnerTurnState>({
    sessionId: "utf8-pump",
    file: "fake-cli",
    args: [],
    cwd: tmpdir(),
    env: {},
    observer: { isActive: () => true },
    spawnProcess: () => child as unknown as ChildProcess,
    createState: () => ({ blocks: [], result: "", sessionId: null }),
    processLine: (line) => { lines.push(line); },
    onStdoutText: (text) => { stdoutChunks.push(text); },
    finalize: (ctx, exitCode) => ({
      state: ctx.state,
      exitCode,
      signal: null,
      stderr: ctx.stderr,
      primaryError: null,
    }),
  });

  const payload = `${JSON_LINE}\n`;
  const [head, rest] = splitUtf8At(payload, 16); // mid 🙂
  child.stdout.emit("data", head);
  assert.equal(lines.length, 0, "incomplete UTF-8 must not produce a line yet");
  child.stdout.emit("data", rest);
  child.emit("close", 0, null);

  const result = await execution.completion;
  assert.deepEqual(lines, [JSON_LINE]);
  assert.equal(stdoutChunks.join(""), payload);
  assert.ok(!stdoutChunks.join("").includes("\uFFFD"));
  assert.equal(result.exitCode, 0);
});

test("incomplete UTF-8 at close does not invent replacement characters in processed lines", async () => {
  const child = new FakeChild();
  const lines: string[] = [];
  const execution = startStructuredCli<StructuredRunnerTurnState>({
    sessionId: "utf8-trunc",
    file: "fake-cli",
    args: [],
    cwd: tmpdir(),
    env: {},
    observer: { isActive: () => true },
    spawnProcess: () => child as unknown as ChildProcess,
    createState: () => ({ blocks: [], result: "", sessionId: null }),
    processLine: (line) => { lines.push(line); },
    finalize: (ctx, exitCode) => ({
      state: ctx.state,
      exitCode,
      signal: null,
      stderr: ctx.stderr,
      primaryError: null,
    }),
  });

  const [head] = splitUtf8At(`${JSON_LINE}\n`, 10);
  child.stdout.emit("data", head);
  child.emit("close", 0, null);
  await execution.completion;
  assert.equal(lines.join(""), '{"text":"');
  assert.ok(!lines.join("").includes("\uFFFD"));
});


test("truncated replay logs keep stdoutTruncated without decoder replacement characters", () => {
  const decoder = createUtf8TextDecoder();
  const jsonLine = '{"text":"你好🙂"}\n';
  const bytes = Buffer.from(jsonLine.repeat(4), "utf8");
  let log = "";
  let truncated = false;
  const maxChars = 20;
  const [head, tail] = [bytes.subarray(0, 10), bytes.subarray(10, 40)];
  for (const chunk of [head, tail]) {
    const textChunk = decoder.write(chunk);
    if (!textChunk) continue;
    log += textChunk;
    if (log.length > maxChars) {
      log = log.slice(-maxChars);
      truncated = true;
    }
  }
  decoder.end();
  assert.equal(truncated, true);
  assert.ok(!log.includes("\uFFFD"));
  assert.ok(maxChars < STRUCTURED_RUN_LOG_MAX_CHARS);
});
