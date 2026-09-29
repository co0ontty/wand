import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import {
  checkPasswordRateLimit,
  recordFailedPassword,
  resetPasswordRateLimit,
} from "../src/middleware/rate-limit.js";
import { startServer } from "../src/server.js";

const MINUTE = 60_000;
const BASE = 1_800_000_000_000;

test("wrong-password failures are counted over a sliding window and lock at ten", () => {
  const ip = "203.0.113.10";
  resetPasswordRateLimit(ip);
  for (let i = 0; i < 9; i++) {
    assert.equal(recordFailedPassword(ip, BASE + i * 1000), null);
    assert.equal(checkPasswordRateLimit(ip, BASE + i * 1000), null);
  }
  const lock = recordFailedPassword(ip, BASE + 9 * 1000);
  assert.ok(lock);
  assert.equal(lock.retryAfter, 15 * MINUTE / 1000);
  assert.ok(checkPasswordRateLimit(ip, BASE + 9 * 1000 + MINUTE));
});

test("failures older than the window do not accumulate into a lock", () => {
  const ip = "203.0.113.11";
  resetPasswordRateLimit(ip);
  for (let i = 0; i < 9; i++) recordFailedPassword(ip, BASE + i * 60_000);
  // The window slid past every recorded failure.
  assert.equal(checkPasswordRateLimit(ip, BASE + 9 * 60_000 + 15 * MINUTE), null);
  assert.equal(recordFailedPassword(ip, BASE + 9 * 60_000 + 15 * MINUTE), null);
});

test("a fresh failure after an expired lock starts a clean window", () => {
  const ip = "203.0.113.12";
  resetPasswordRateLimit(ip);
  for (let i = 0; i < 10; i++) recordFailedPassword(ip, BASE + i * 1000);
  const afterLock = BASE + 10 * 1000 + 15 * MINUTE;
  assert.equal(checkPasswordRateLimit(ip, afterLock), null);
  for (let i = 0; i < 9; i++) {
    assert.equal(recordFailedPassword(ip, afterLock + i * 1000), null);
  }
  assert.ok(recordFailedPassword(ip, afterLock + 9 * 1000));
});

test("success clears the counter", () => {
  const ip = "203.0.113.13";
  resetPasswordRateLimit(ip);
  for (let i = 0; i < 9; i++) recordFailedPassword(ip, BASE + i * 1000);
  resetPasswordRateLimit(ip);
  assert.equal(checkPasswordRateLimit(ip, BASE + 9 * 1000), null);
  assert.equal(recordFailedPassword(ip, BASE + 9 * 1000), null);
});

function clearLoopbackBuckets(): void {
  // The bucket is process-global and every local request arrives as loopback,
  // whether that renders as 127.0.0.1 or ::1.
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) resetPasswordRateLimit(ip);
}

async function withServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  process.env.WAND_TEST_MODE = "1";
  clearLoopbackBuckets();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-login-rate-limit-"));
  const config = {
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
  };
  const handle = await startServer(config, path.join(dir, "config.json"));
  try {
    await run(handle.urls[0]!.url);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
    // A burned bucket must not leak into the next file sharing this process.
    clearLoopbackBuckets();
  }
}

async function login(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a stale app token never feeds the password lockout", async () => {
  await withServer(async (baseUrl) => {
    for (let i = 0; i < 12; i++) {
      const stale = await login(baseUrl, { appToken: "deadbeef".repeat(8) });
      assert.equal(stale.status, 401, `stale token attempt ${i}`);
    }
    const good = await login(baseUrl, { password: "test-password" });
    assert.equal(good.status, 200);
  });
});

test("ten wrong passwords lock the IP and the lock reports the remaining time", async () => {
  await withServer(async (baseUrl) => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await login(baseUrl, { password: `wrong-${i}` })).status, 401, `attempt ${i}`);
    }
    const locked = await login(baseUrl, { password: "wrong-11" });
    assert.equal(locked.status, 429);
    const retryAfter = Number(locked.headers.get("retry-after"));
    assert.ok(retryAfter > 14 * 60 && retryAfter <= 15 * 60, `retry-after=${retryAfter}`);
    const body = await locked.json() as { error?: string; retryAfter?: number };
    assert.match(body.error ?? "", /15 分钟/);
    assert.equal(body.retryAfter, retryAfter);

    // The lock gates every unverified attempt, correct password included.
    assert.equal((await login(baseUrl, { password: "test-password" })).status, 429);
    assert.equal((await login(baseUrl, { appToken: "deadbeef".repeat(8) })).status, 429);
  });
});
