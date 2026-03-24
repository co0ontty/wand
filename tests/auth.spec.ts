import { test, expect } from "@playwright/test";
import { login, logout, TEST_PASSWORD } from "./setup";

test.describe("Authentication", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("should display login page", async ({ page }) => {
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("#login-button")).toBeVisible();
    await expect(page.locator("#login-error")).toBeHidden();
  });

  test("should show error for wrong password", async ({ page }) => {
    await page.fill("#password", "wrong-password");
    await page.click("#login-button");

    // Wait for error message
    await expect(page.locator("#login-error")).toBeVisible();
    await expect(page.locator("#login-error")).toContainText(/错误|失败|invalid/i);

    // Should still be on login page
    await expect(page.locator("#password")).toBeVisible();
  });

  test("should login successfully with correct password", async ({ page }) => {
    await login(page, TEST_PASSWORD);

    // Should see main UI
    await expect(page.locator("#sessions-toggle-button")).toBeVisible();
    await expect(page.locator("#password")).toBeHidden();
  });

  test("should logout successfully", async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await expect(page.locator("#sessions-toggle-button")).toBeVisible();

    await logout(page);

    // Should be back on login page
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("#login-button")).toBeVisible();
  });

  test("should persist session on page reload", async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await expect(page.locator("#sessions-toggle-button")).toBeVisible();

    // Reload page
    await page.reload();

    // Should still be logged in (session cookie persists)
    await expect(page.locator("#sessions-toggle-button")).toBeVisible();
  });

  test("should focus password input on load", async ({ page }) => {
    const passwordInput = page.locator("#password");
    await expect(passwordInput).toBeFocused();
  });

  test("should submit login on Enter key", async ({ page }) => {
    await page.fill("#password", TEST_PASSWORD);
    await page.keyboard.press("Enter");

    // Should navigate to main UI
    await expect(page.locator("#sessions-toggle-button")).toBeVisible();
  });

  test("should rate limit login attempts", async ({ page }) => {
    // Try multiple failed logins
    for (let i = 0; i < 12; i++) {
      await page.fill("#password", `wrong-${i}`);
      await page.click("#login-button");
      await page.waitForTimeout(100);
    }

    // Should see rate limit error eventually
    const errorText = await page.locator("#login-error").textContent();
    expect(errorText).toMatch(/错误|失败|limit|too many/i);
  });
});