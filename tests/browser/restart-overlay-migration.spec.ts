import { expect, test } from "@playwright/test";
import { login, revealSettingsButton } from "./helpers";

test("React restart overlay is non-dismissable and consumes native back", async ({ page }) => {
  await login(page);

  await page.evaluate(() => {
    const target = window as Window & {
      __wandReactRestartOverlay?: {
        showRestart(previousInstanceId?: string, expectedVersion?: string): void;
      };
    };
    target.__wandReactRestartOverlay?.showRestart("fixture-instance", "99.0.0");
  });

  const overlay = page.getByTestId("restart-overlay");
  await expect(overlay).toBeVisible();
  await expect(page.getByRole("heading", { name: "正在完成更新" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("等待");
  await expect(page.locator(".restart-overlay, .restart-overlay-content, .restart-spinner")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(overlay).toBeVisible();
  expect(await page.evaluate(() => (
    window as Window & { handleNativeBack?: () => boolean }
  ).handleNativeBack?.())).toBe(true);
  await expect(overlay).toBeVisible();
});

test("Settings restart action enters the public restart overlay", async ({ page }) => {
  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...payload, restartRequired: true } });
  });
  await page.route("**/api/restart", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, message: "fixture restart" }),
  }));
  await login(page);
  await page.route("**/api/config", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "fixture restarting" }),
  }));

  await revealSettingsButton(page);
  await page.locator("#settings-button").click();
  const settings = page.getByTestId("settings-dialog");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "重启服务" }).click();

  const overlay = page.getByTestId("restart-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("heading", { name: "服务正在重启" })).toBeVisible();
  await expect(settings).toBeVisible();
});
