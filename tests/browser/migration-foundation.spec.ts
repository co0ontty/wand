import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("login reports an invalid password and then recovers", async ({ page }) => {
  await page.goto("/");
  const password = page.locator("#password");
  await expect(password).toBeVisible();

  await password.fill("incorrect-password");
  await page.locator("#login-button").click();
  await expect(page.locator("#login-error")).toContainText("密码错误");
  await expect(password).toHaveAttribute("aria-invalid", "true");

  await password.fill("change-me");
  await page.locator("#login-button").click();
  await expect(page.locator("#topbar-file-button")).toBeVisible();
  await expect(page.locator("#overlay-root")).toHaveAttribute("data-react-ui", "enabled");

  await page.reload();
  await expect(page.locator("#topbar-file-button")).toBeVisible();
  await expect(page.locator("#password")).toHaveCount(0);
});

test("React overlay survives the legacy full render and owns focus lifecycle", async ({ page }) => {
  await login(page);
  const trigger = page.locator("#settings-button");
  await trigger.evaluate((element: HTMLElement) => element.focus());

  await page.evaluate(() => {
    const overlay = (window as Window & {
      __wandReactUi: {
        dialog(options: unknown): Promise<unknown>;
        toast(message: string, options?: unknown): unknown;
      };
    }).__wandReactUi;
    overlay.toast("Overlay smoke", { tone: "success", duration: 30_000 });
    void overlay.dialog({
      title: "Overlay smoke",
      description: "Focus, Escape, and portal regression coverage.",
      tone: "question",
      actions: [
        { label: "Cancel", value: false, kind: "secondary" },
        { label: "Continue", value: true, kind: "primary", autoFocus: true },
      ],
    });
  });

  const dialog = page.locator(".wand-ui-dialog-content");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".wand-ui-toast", { hasText: "Overlay smoke" })).toBeVisible();
  const overlayZ = await page.locator("#overlay-root").evaluate((element) => Number(getComputedStyle(element).zIndex));
  expect(overlayZ).toBeGreaterThan(10_000);
  expect(overlayZ).toBeLessThan(99_999);
  await expect(page.getByRole("button", { name: "Continue" })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.getByRole("button", { name: "关闭通知" }).click();
  await expect(page.locator(".wand-ui-toast", { hasText: "Overlay smoke" })).toBeHidden();
  await expect(page.locator("#wand-react-ui-mount")).toBeAttached();
  await expect(page.locator("#wand-react-ui-portals")).toBeAttached();
});

test("legacy dialog APIs preserve confirm, prompt, and FIFO semantics through React", async ({ page }) => {
  await login(page);

  await page.evaluate(() => {
    const target = window as Window & {
      wandConfirm(message: string, options?: unknown): Promise<boolean>;
      wandPrompt(message: string, initial?: string, options?: unknown): Promise<string | null>;
      wandAlert(message: string, options?: unknown): Promise<void>;
      __confirmResult?: Promise<boolean>;
      __promptResult?: Promise<string | null>;
      __queueResult?: Promise<unknown>;
    };
    target.__confirmResult = target.wandConfirm("Delete the fixture?", {
      title: "Danger confirm",
      danger: true,
      okLabel: "Delete",
    });
  });
  await expect(page.getByRole("heading", { name: "Danger confirm" })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消" })).toBeFocused();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await page.evaluate(() => (window as Window & { __confirmResult?: Promise<boolean> }).__confirmResult)).toBe(true);

  await page.evaluate(() => {
    const target = window as Window & {
      wandPrompt(message: string, initial?: string, options?: unknown): Promise<string | null>;
      __promptResult?: Promise<string | null>;
    };
    target.__promptResult = target.wandPrompt("Name", "initial", { title: "Prompt smoke" });
  });
  const promptInput = page.locator(".wand-ui-dialog-input");
  await expect(promptInput).toBeFocused();
  await expect(promptInput).toHaveValue("initial");
  await promptInput.fill("updated");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as Window & { __promptResult?: Promise<string | null> }).__promptResult)).toBe("updated");

  await page.evaluate(() => {
    const target = window as Window & {
      wandAlert(message: string, options?: unknown): Promise<void>;
      __queueResult?: Promise<unknown>;
    };
    target.__queueResult = Promise.all([
      target.wandAlert("First message", { title: "First queued" }),
      target.wandAlert("Second message", { title: "Second queued" }),
    ]);
  });
  await expect(page.getByRole("heading", { name: "First queued" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Second queued" })).toHaveCount(0);
  await page.getByRole("button", { name: "好" }).click();
  await expect(page.getByRole("heading", { name: "Second queued" })).toBeVisible();
  await page.getByRole("button", { name: "好" }).click();
  await page.evaluate(() => (window as Window & { __queueResult?: Promise<unknown> }).__queueResult);
});

test("React UI rollback uses the legacy Shell without orphaning business overlay entries", async ({ page }) => {
  const sessionId = "rollback-worktree-fixture";
  const session = {
    id: sessionId,
    sessionSource: "interactive",
    sessionKind: "pty",
    provider: "claude",
    command: "claude",
    // Empty selects the browser-test server's configured fixture workspace
    // for the public file drawer while Worktree keeps its own path below.
    cwd: "",
    mode: "default",
    worktreeEnabled: true,
    worktree: {
      branch: "wand/rollback-fixture",
      path: "/tmp/wand-worktree-rollback",
    },
    worktreeMergeStatus: "ready",
    status: "exited",
    exitCode: 0,
    startedAt: "2026-07-16T00:00:00.000Z",
    endedAt: "2026-07-16T00:01:00.000Z",
    archived: false,
    output: "",
    title: "Rollback fixture",
    description: "Public overlay entry coverage",
  };

  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([session]),
  }));
  await page.route(`**/api/sessions/${sessionId}`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...session,
      outputOffset: 0,
      outputTotal: 0,
      outputTruncated: false,
    }),
  }));
  await page.route(`**/api/sessions/${sessionId}/git-status`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      isGit: true,
      branch: "wand/rollback-fixture",
      modifiedCount: 1,
      files: [{ path: "README.md", status: "M" }],
      head: "abcdef123456",
      ahead: 1,
      behind: 0,
      latestTag: "v0.0.0",
    }),
  }));
  await page.route(`**/api/sessions/${sessionId}/worktree/merge/check`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      result: {
        ok: true,
        sourceBranch: "wand/rollback-fixture",
        targetBranch: "main",
        worktreePath: "/tmp/wand-worktree-rollback",
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

  await page.goto(`/?reactUi=0&session=${sessionId}`);
  const password = page.locator("#password");
  await expect(password).toBeVisible();
  await password.fill("change-me");
  await page.locator("#login-button").click();
  await expect(page.locator("#topbar-file-button")).toBeVisible();

  await expect(page.locator("#overlay-root")).toHaveAttribute("data-react-ui", "fallback");
  await expect(page.locator("#wand-react-ui-mount")).toBeAttached();
  await expect(page.locator("#wand-react-ui-portals")).toBeAttached();
  await expect(page.locator("#app")).not.toHaveAttribute("data-react-shell", "enabled");
  const exposure = await page.evaluate(() => {
    const target = window as Window & Record<string, unknown>;
    return {
      generic: Boolean(target.__wandReactUi),
      business: [
        "__wandReactNewSession",
        "__wandReactSettings",
        "__wandReactFolderPicker",
        "__wandReactFilePreview",
        "__wandReactWorktreeMerge",
        "__wandReactQuickCommit",
      ].every((name) => Boolean(target[name])),
    };
  });
  expect(exposure).toEqual({ generic: false, business: true });

  const dialogPromise = page.waitForEvent("dialog");
  const evaluationPromise = page.evaluate(() => {
    const target = window as Window & {
      wandConfirm(message: string): Promise<boolean>;
      __fallbackResult?: Promise<boolean>;
    };
    target.__fallbackResult = target.wandConfirm("Legacy fallback still works");
  });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  expect(dialog.message()).toContain("Legacy fallback still works");
  await dialog.accept();
  await evaluationPromise;
  await expect(page.locator(".wand-dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __fallbackResult?: Promise<boolean> }).__fallbackResult)).toBe(true);

  const revealSidebarControl = async (selector: string) => {
    const control = page.locator(selector);
    const intersectsViewport = () => control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < window.innerWidth
        && rect.top < window.innerHeight;
    });
    if (!await intersectsViewport()) await page.locator("#sessions-toggle-button").click();
    await expect.poll(intersectsViewport).toBe(true);
    return control;
  };

  // New and Settings use their real legacy-Shell buttons.
  await (await revealSidebarControl("#drawer-new-session-button")).click();
  const newSession = page.getByTestId("new-session-dialog");
  await expect(newSession.getByRole("heading", { name: "新对话" })).toBeVisible();
  await newSession.getByRole("button", { name: "关闭新建会话" }).click();
  await expect(newSession).toBeHidden();

  await (await revealSidebarControl("#settings-button")).click();
  const settings = page.getByTestId("settings-dialog");
  await expect(settings.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await settings.getByRole("tab", { name: /通知/ }).click();
  await settings.getByRole("button", { name: "立即测试" }).click();
  await expect(page.locator(".wand-ui-toast", { hasText: "这是一条测试通知。" })).toBeVisible();
  await expect(page.locator(".wand-ui-toast", { hasText: "测试通知" })).toHaveCount(2);
  await settings.getByRole("button", { name: "关闭设置" }).click();
  await expect(settings).toBeHidden();

  // File Preview uses the public file-tree click adapter.
  const drawer = page.locator("#sessions-drawer");
  if (await drawer.evaluate((element) => element.classList.contains("open"))) {
    await page.locator("#close-drawer-button").click();
    await expect(drawer).not.toHaveClass(/\bopen\b/);
  }
  await page.locator("#topbar-file-button").click();
  const readme = page.locator(".tree-item[data-type='file']", { hasText: "README.md" });
  await expect(readme).toBeVisible();
  await readme.click();
  const preview = page.getByTestId("file-preview-dialog");
  await expect(preview.getByRole("heading", { name: "README.md" })).toBeVisible();
  await preview.getByRole("button", { name: "关闭文件预览" }).click();
  await expect(preview).toBeHidden();
  const filePanel = page.locator("#file-side-panel");
  if (await filePanel.evaluate((element) => element.classList.contains("open"))) {
    await page.locator("#file-side-panel-close").click();
    await expect(filePanel).not.toHaveClass(/\bopen\b/);
  }

  // Quick Commit uses the real Git badge adapter populated by the fixture.
  const quickEntry = page.locator("#topbar-git-badge");
  await expect(quickEntry).toBeVisible();
  await quickEntry.click();
  const quickCommit = page.getByTestId("quick-commit-dialog");
  await expect(quickCommit.getByRole("heading", { name: "快捷提交" })).toBeVisible();
  await quickCommit.getByRole("button", { name: "关闭快捷提交" }).click();
  await expect(quickCommit).toBeHidden();

  // Worktree uses the legacy session-row adapter rather than its controller global.
  const worktreeEntry = await revealSidebarControl(
    `.session-action-btn[data-action="worktree-merge"][data-session-id="${sessionId}"]`,
  );
  await worktreeEntry.click();
  const worktree = page.getByTestId("worktree-merge-dialog");
  await expect(worktree.getByRole("heading", { name: "合并 Worktree" })).toBeVisible();
  await worktree.getByRole("button", { name: "关闭 Worktree 合并" }).click();
  await expect(worktree).toBeHidden();

  // Folder Picker uses the legacy welcome-page working-directory adapter.
  // Returning home makes the real #blank-chat-cwd public entry visible.
  const sidebarHome = page.locator("#sidebar-home-btn");
  if (!await sidebarHome.isVisible()) {
    await (await revealSidebarControl("#sidebar-more-btn")).click();
  }
  await expect(sidebarHome).toBeVisible();
  await sidebarHome.click();
  const folderPickerEntry = page.locator("#blank-chat-cwd");
  await expect(folderPickerEntry).toBeVisible();
  await folderPickerEntry.click();
  const folderPicker = page.getByTestId("folder-picker-dialog");
  await expect(folderPicker.getByRole("heading", { name: "选择工作目录" })).toBeVisible();
  await folderPicker.getByRole("button", { name: "关闭工作目录选择器" }).click();
  await expect(folderPicker).toBeHidden();
});

test("file drawer can browse and preview a fixture file", async ({ page }) => {
  await login(page);
  await page.locator("#topbar-file-button").click();
  await expect(page.locator("#file-side-panel")).toHaveClass(/open/);
  const readme = page.locator(".tree-item[data-type='file']", { hasText: "README.md" });
  await expect(readme).toBeVisible();
  await readme.click();
  const preview = page.getByTestId("file-preview-dialog");
  await expect(preview.getByRole("heading", { name: "README.md" })).toBeVisible();
  await expect(preview.locator(".wand-file-preview-body")).toContainText("Playwright fixture");
  await expect(page.locator(".file-preview-overlay")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});
