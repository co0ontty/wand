import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const sessionId = "worktree-browser-fixture";

function context(intent: "merge" | "cleanup") {
  return {
    sessionId,
    intent,
    sourceBranch: "wand/task-browser-fixture",
    worktreePath: "/tmp/wand-worktree-browser-fixture",
    targetBranch: "main",
    sessionStatus: "exited",
    mergeStatus: intent === "cleanup" ? "merged" : "ready",
    cleanupPending: intent === "cleanup",
  };
}

test("React Worktree merge inspects, merges, and runs compensating cleanup", async ({ page }) => {
  let mergeCalls = 0;
  let cleanupCalls = 0;
  await page.route(`**/api/sessions/${sessionId}/worktree/merge/check`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      result: {
        ok: true,
        sourceBranch: "wand/task-browser-fixture",
        targetBranch: "main",
        worktreePath: "/tmp/wand-worktree-browser-fixture",
        repoRoot: "/tmp/repo",
        hasUncommittedChanges: false,
        aheadCount: 1,
        hasConflicts: false,
        recommendedAction: "merge",
        reason: "",
        commits: [{ hash: "abcdef123456", shortHash: "abcdef1", subject: "Browser migration" }],
      },
    }),
  }));
  await page.route(`**/api/sessions/${sessionId}/worktree/merge`, async (route) => {
    mergeCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          ok: true,
          sourceBranch: "wand/task-browser-fixture",
          targetBranch: "main",
          repoRoot: "/tmp/repo",
          mergeCommit: "abcdef123456",
          mergedAt: "2026-07-16T00:00:00.000Z",
          cleanupDone: true,
          conflict: false,
          errorCode: "",
          reason: "",
        },
      }),
    });
  });
  await page.route(`**/api/sessions/${sessionId}/worktree/cleanup`, async (route) => {
    cleanupCalls += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await page.evaluate((openContext) => {
    (window as Window & {
      __wandReactWorktreeMerge?: { open(value: unknown): boolean };
    }).__wandReactWorktreeMerge?.open(openContext);
  }, context("merge"));

  const dialog = page.getByTestId("worktree-merge-dialog");
  await expect(dialog.getByRole("heading", { name: "合并 Worktree" })).toBeVisible();
  await expect(dialog).toContainText("Browser migration");
  await dialog.getByRole("button", { name: "确认合并并清理" }).click();
  await expect.poll(() => mergeCalls).toBe(1);
  await expect(dialog).toBeHidden();

  await page.evaluate((openContext) => {
    (window as Window & {
      __wandReactWorktreeMerge?: { open(value: unknown): boolean };
    }).__wandReactWorktreeMerge?.open(openContext);
  }, context("cleanup"));
  await expect(dialog.getByRole("heading", { name: "清理 Worktree" })).toBeVisible();
  await dialog.getByRole("button", { name: "重试清理" }).click();
  await expect.poll(() => cleanupCalls).toBe(1);
  await expect(dialog).toBeHidden();
});

test("React Worktree blocks conflict risk and preserves cancel focus", async ({ page }) => {
  await page.route(`**/api/sessions/${sessionId}/worktree/merge/check`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      result: {
        ok: false,
        sourceBranch: "wand/task-browser-fixture",
        targetBranch: "main",
        worktreePath: "/tmp/wand-worktree-browser-fixture",
        repoRoot: "/tmp/repo",
        hasUncommittedChanges: false,
        aheadCount: 1,
        hasConflicts: true,
        recommendedAction: "resolve-conflict",
        reason: "请先解决冲突。",
        commits: [],
      },
    }),
  }));

  await login(page);
  await page.evaluate((openContext) => {
    (window as Window & {
      __wandReactWorktreeMerge?: { open(value: unknown): boolean };
    }).__wandReactWorktreeMerge?.open(openContext);
  }, context("merge"));

  const dialog = page.getByTestId("worktree-merge-dialog");
  await expect(dialog).toContainText("请先解决冲突");
  await expect(dialog.getByRole("button", { name: "确认合并并清理" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("native back consumes a busy Worktree operation without closing its dialog", async ({ page }) => {
  await page.route(`**/api/sessions/${sessionId}/worktree/merge/check`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      result: {
        ok: true,
        sourceBranch: "wand/task-browser-fixture",
        targetBranch: "main",
        worktreePath: "/tmp/wand-worktree-browser-fixture",
        repoRoot: "/tmp/repo",
        hasUncommittedChanges: false,
        aheadCount: 1,
        hasConflicts: false,
        recommendedAction: "merge",
        reason: "",
        commits: [],
      },
    }),
  }));

  let releaseMerge: (() => void) | undefined;
  const mergeGate = new Promise<void>((resolve) => { releaseMerge = resolve; });
  await page.route(`**/api/sessions/${sessionId}/worktree/merge`, async (route) => {
    await mergeGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          ok: true,
          sourceBranch: "wand/task-browser-fixture",
          targetBranch: "main",
          repoRoot: "/tmp/repo",
          mergeCommit: "abcdef123456",
          mergedAt: "2026-07-16T00:00:00.000Z",
          cleanupDone: true,
          conflict: false,
          errorCode: "",
          reason: "",
        },
      }),
    });
  });

  await login(page);
  await page.evaluate((openContext) => {
    (window as Window & {
      __wandReactWorktreeMerge?: { open(value: unknown): boolean };
    }).__wandReactWorktreeMerge?.open(openContext);
  }, context("merge"));

  const dialog = page.getByTestId("worktree-merge-dialog");
  const confirm = dialog.getByRole("button", { name: "确认合并并清理" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog.getByRole("button", { name: "合并中…" })).toBeDisabled();

  const consumed = await page.evaluate(() => (
    window as Window & { handleNativeBack?: () => boolean }
  ).handleNativeBack?.());
  expect(consumed).toBe(true);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  releaseMerge?.();
  await expect(dialog).toBeHidden();
});
