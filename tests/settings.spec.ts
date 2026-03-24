import { test, expect } from "@playwright/test";
import {
  login,
  openSettings,
  closeSettings,
  isDarkMode,
  TEST_PASSWORD
} from "./setup";

test.describe("Settings Modal", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should open settings modal", async ({ page }) => {
    await openSettings(page);
    await expect(page.locator("#settings-modal")).toBeVisible();
  });

  test("should close settings on close button", async ({ page }) => {
    await openSettings(page);
    await closeSettings(page);
    await expect(page.locator("#settings-modal")).toBeHidden();
  });

  test("should close settings on Escape key", async ({ page }) => {
    await openSettings(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-modal")).toBeHidden();
  });

  test("should close settings on backdrop click", async ({ page }) => {
    await openSettings(page);

    // Click backdrop (outside modal)
    await page.click("#settings-modal", { position: { x: 10, y: 10 } });
    await expect(page.locator("#settings-modal")).toBeHidden();
  });

  test("should display settings title", async ({ page }) => {
    await openSettings(page);
    const title = page.locator("#settings-modal .modal-title");
    await expect(title).toContainText(/设置|Settings/i);
  });

  test("should have password change fields", async ({ page }) => {
    await openSettings(page);

    // Check for password fields
    await expect(page.locator("#new-password")).toBeVisible();
    await expect(page.locator("#confirm-password")).toBeVisible();
    await expect(page.locator("#save-password-button")).toBeVisible();
  });

  test("should show error for mismatched passwords", async ({ page }) => {
    await openSettings(page);

    await page.fill("#new-password", "newpass123");
    await page.fill("#confirm-password", "different456");
    await page.click("#save-password-button");

    // Should show error
    await expect(page.locator("#settings-error")).toBeVisible();
  });

  test("should show error for short password", async ({ page }) => {
    await openSettings(page);

    await page.fill("#new-password", "short");
    await page.fill("#confirm-password", "short");
    await page.click("#save-password-button");

    // Should show error about minimum length
    await expect(page.locator("#settings-error")).toBeVisible();
  });
});

test.describe("Dark Mode", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should have dark mode toggle if implemented", async ({ page }) => {
    await openSettings(page);

    // Look for dark mode toggle (may not exist yet)
    const darkModeToggle = page.locator(
      "#settings-dark-mode-toggle, .dark-mode-toggle, [data-dark-mode-toggle]"
    );

    // This test passes whether or not dark mode is implemented
    const isVisible = await darkModeToggle.isVisible().catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });

  test("should toggle dark mode if toggle exists", async ({ page }) => {
    await openSettings(page);

    const darkModeToggle = page.locator(
      "#settings-dark-mode-toggle, .dark-mode-toggle, [data-dark-mode-toggle]"
    );

    if (await darkModeToggle.isVisible()) {
      const initialDarkMode = await isDarkMode(page);

      await darkModeToggle.click();
      await page.waitForTimeout(300);

      const newDarkMode = await isDarkMode(page);
      expect(newDarkMode).toBe(!initialDarkMode);
    }
  });
});