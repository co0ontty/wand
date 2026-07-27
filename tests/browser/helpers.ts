import { expect, type Page } from "@playwright/test";

export async function login(page: Page): Promise<void> {
  await page.goto("/");
  const password = page.locator("#password");
  await expect(password).toBeVisible();
  await password.fill("change-me");
  await page.locator("#login-button").click();
  await expect(page.locator("#settings-button")).toBeAttached();
  await expect(page.locator("#topbar-file-button")).toBeVisible();
}

export async function revealSettingsButton(page: Page): Promise<void> {
  const settings = page.locator("#settings-button");
  const intersectsViewport = await settings.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.top < window.innerHeight;
  });
  if (!intersectsViewport) await page.locator("#sessions-toggle-button").click();
  await expect.poll(() => settings.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.top < window.innerHeight;
  })).toBe(true);
}
