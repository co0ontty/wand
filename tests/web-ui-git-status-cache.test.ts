import assert from "node:assert/strict";
import test from "node:test";

import { createGitStatusCache } from "../src/web-ui/browser/git-status-cache.ts";

test("缓存按会话存状态，切会话即可取回", () => {
  const cache = createGitStatusCache<{ branch: string; modifiedCount: number }>();
  assert.equal(cache.peek("a"), null);

  assert.equal(cache.accept("a", { branch: "main", modifiedCount: 3 }, 100), true);
  assert.equal(cache.accept("b", { branch: "dev", modifiedCount: 0 }, 100), true);
  assert.deepEqual(cache.peek("a"), { branch: "main", modifiedCount: 3 });
  assert.deepEqual(cache.peek("b"), { branch: "dev", modifiedCount: 0 });
  assert.equal(cache.peek(null), null);

  cache.forget("a");
  assert.equal(cache.peek("a"), null);
  assert.deepEqual(cache.peek("b"), { branch: "dev", modifiedCount: 0 });
});

test("同一会话只认更晚发起的请求，晚到的旧响应不覆盖新快照", () => {
  const cache = createGitStatusCache<{ modifiedCount: number }>();
  assert.equal(cache.accept("a", { modifiedCount: 5 }, 200), true);
  // 更早发起、更晚落地的响应
  assert.equal(cache.accept("a", { modifiedCount: 3 }, 100), false);
  assert.deepEqual(cache.peek("a"), { modifiedCount: 5 });
  // 更晚发起的响应正常覆盖
  assert.equal(cache.accept("a", { modifiedCount: 7 }, 300), true);
  assert.deepEqual(cache.peek("a"), { modifiedCount: 7 });
  // 同一时刻重复落地不丢弃（同一次请求的两条路径）
  assert.equal(cache.accept("a", { modifiedCount: 7 }, 300), true);
});

test("缓存忽略空会话与空状态", () => {
  const cache = createGitStatusCache<{ isGit: boolean }>();
  assert.equal(cache.accept("", { isGit: true }, 1), false);
  assert.equal(cache.accept("a", null, 1), false);
  assert.equal(cache.peek("a"), null);
});
