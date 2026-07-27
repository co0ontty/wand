import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { SessionLogger, type SessionLoggerOptions } from "../src/session-logger.js";

function createLogger(
  t: TestContext,
  options: SessionLoggerOptions = {},
): { root: string; logger: SessionLogger; sessionDir: (id: string) => string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-logger-"));
  const logger = new SessionLogger(root, undefined, options);
  t.after(() => {
    logger.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    logger,
    sessionDir: (id: string) => path.join(root, "sessions", id),
  };
}

test("SessionLogger batches frequent small appends without changing JSONL order", (t) => {
  let appendCalls = 0;
  const { logger, sessionDir } = createLogger(t, {
    flushIntervalMs: 10_000,
    appendFile: (filePath, data) => {
      appendCalls += 1;
      appendFileSync(filePath, data);
    },
  });

  for (let index = 0; index < 200; index += 1) {
    logger.appendStreamEvent("ordered", { index });
  }
  assert.equal(appendCalls, 0);

  logger.flushAll();
  assert.equal(appendCalls, 1);
  const lines = readFileSync(path.join(sessionDir("ordered"), "stream-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { index: number });
  assert.deepEqual(lines.map((line) => line.index), Array.from({ length: 200 }, (_, index) => index));
});

test("SessionLogger timer flush makes a complete batch visible", async (t) => {
  const { logger, sessionDir } = createLogger(t, { flushIntervalMs: 20 });
  logger.appendStructuredStdout("timer", "alpha");
  logger.appendStructuredStdout("timer", "-omega");

  await delay(60);

  assert.equal(readFileSync(path.join(sessionDir("timer"), "structured-stdout.log"), "utf8"), "alpha-omega");
});

test("SessionLogger reads flush pending PTY and stderr data first", (t) => {
  const { logger, sessionDir } = createLogger(t, { flushIntervalMs: 10_000 });
  logger.appendPtyOutput("read", "pending-pty");
  logger.appendStructuredStderr("read", "pending-stderr");
  assert.equal(existsSync(path.join(sessionDir("read"), "pty-output.log")), false);
  assert.equal(existsSync(path.join(sessionDir("read"), "structured-stderr.log")), false);

  assert.equal(logger.readPtyOutput("read"), "pending-pty");
  assert.equal(logger.readStructuredStderrTail("read"), "pending-stderr");
});

test("SessionLogger flushes the current PTY batch before rotation", (t) => {
  const { logger, sessionDir } = createLogger(t, {
    flushIntervalMs: 10_000,
    ptyLogMaxBytes: 5,
    ptyLogMaxRotations: 2,
  });

  logger.appendPtyOutput("rotate", "abc");
  logger.appendPtyOutput("rotate", "de");
  logger.appendPtyOutput("rotate", "FG");
  logger.flushAll();

  assert.equal(readFileSync(path.join(sessionDir("rotate"), "pty-output.log.1"), "utf8"), "abcde");
  assert.equal(readFileSync(path.join(sessionDir("rotate"), "pty-output.log"), "utf8"), "FG");
  assert.equal(logger.readPtyOutput("rotate"), "abcdeFG");
});

test("SessionLogger delete clears pending timers without recreating files", async (t) => {
  const { logger, sessionDir } = createLogger(t, { flushIntervalMs: 20 });
  logger.appendStructuredStdout("deleted", "last batch");
  logger.deleteSession("deleted");
  assert.equal(existsSync(sessionDir("deleted")), false);

  await delay(60);

  assert.equal(existsSync(sessionDir("deleted")), false);
});

test("SessionLogger dispose is idempotent and preserves the final batch", (t) => {
  const { logger, sessionDir } = createLogger(t, { flushIntervalMs: 10_000 });
  logger.appendStructuredStdout("dispose", "stdout-final");
  logger.appendStructuredStderr("dispose", "stderr-final");

  logger.dispose();
  logger.dispose();

  assert.equal(readFileSync(path.join(sessionDir("dispose"), "structured-stdout.log"), "utf8"), "stdout-final");
  assert.equal(readFileSync(path.join(sessionDir("dispose"), "structured-stderr.log"), "utf8"), "stderr-final");
  logger.appendStructuredStdout("dispose", "ignored");
  assert.equal(readFileSync(path.join(sessionDir("dispose"), "structured-stdout.log"), "utf8"), "stdout-final");
});

test("SessionLogger forces bounded per-file and global buffers to disk", (t) => {
  const { logger, sessionDir } = createLogger(t, {
    flushIntervalMs: 10_000,
    perFileBufferMaxBytes: 8,
    totalBufferMaxBytes: 12,
  });

  logger.appendStructuredStdout("bounded-file", "1234");
  logger.appendStructuredStdout("bounded-file", "5678");
  assert.equal(readFileSync(path.join(sessionDir("bounded-file"), "structured-stdout.log"), "utf8"), "12345678");

  logger.appendStructuredStdout("bounded-global", "abcdef");
  logger.appendStructuredStderr("bounded-global", "ghijkl");
  assert.equal(readFileSync(path.join(sessionDir("bounded-global"), "structured-stdout.log"), "utf8"), "abcdef");
  assert.equal(readFileSync(path.join(sessionDir("bounded-global"), "structured-stderr.log"), "utf8"), "ghijkl");
});
