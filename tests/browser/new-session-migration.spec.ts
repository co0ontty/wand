import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

async function openNewSession(page: Page): Promise<void> {
  // The same drawer action exists in pinned and off-canvas layouts. Invoking its
  // real click listener avoids coupling this feature test to sidebar animation.
  const drawerTrigger = page.locator("#drawer-new-session-button");
  await drawerTrigger.evaluate((element: HTMLButtonElement) => element.click());
}

test("New Session supports keyboard choices, Worktree, and a typed create request", async ({ page }) => {
  await login(page);

  let createBody: Record<string, unknown> | null = null;
  await page.route("**/api/commands", async (route) => {
    createBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "fixture create blocked" }),
    });
  });

  await openNewSession(page);
  const dialog = page.getByTestId("new-session-dialog");
  await expect(dialog).toBeVisible();

  const providers = dialog.getByRole("radiogroup", { name: "Provider" });
  const claude = providers.getByRole("radio", { name: /Claude/ });
  const codex = providers.getByRole("radio", { name: /Codex/ });
  // Preferences persist across viewport projects, so establish a deterministic
  // starting choice before exercising the radio-group keyboard contract.
  await claude.click();
  await expect(claude).toHaveAttribute("aria-checked", "true");
  await claude.focus();
  await page.keyboard.press("ArrowRight");
  await expect(codex).toHaveAttribute("aria-checked", "true");
  await expect(codex).toBeFocused();

  const kinds = dialog.getByRole("radiogroup", { name: "会话类型" });
  await kinds.getByRole("radio", { name: /PTY/ }).click();
  await expect(kinds.getByRole("radio", { name: /PTY/ })).toHaveAttribute("aria-checked", "true");

  const worktree = dialog.getByRole("switch", { name: "启用 Worktree 模式" });
  await worktree.click();
  await expect(worktree).toHaveAttribute("data-state", "checked");

  await dialog.getByRole("textbox", { name: "工作目录", exact: true }).fill("/tmp/wand-e2e-worktree");
  await dialog.getByRole("button", { name: "启动会话" }).click();

  await expect(dialog.getByRole("alert")).toContainText("fixture create blocked");
  expect(createBody).toMatchObject({
    command: "codex",
    provider: "codex",
    cwd: "/tmp/wand-e2e-worktree",
    mode: "full-access",
    worktreeEnabled: true,
    sessionSource: "interactive",
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
