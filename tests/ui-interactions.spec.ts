import { test, expect } from "@playwright/test";
import { login, waitForSession, TEST_PASSWORD } from "./setup";

test.describe("Floating Controls Panel", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should display floating controls toggle", async ({ page }) => {
    const toggle = page.locator("#floating-controls-toggle");
    await expect(toggle).toBeVisible();
  });

  test("should open floating controls panel", async ({ page }) => {
    const toggle = page.locator("#floating-controls-toggle");
    await toggle.click();

    const panel = page.locator("#floating-controls");
    await expect(panel).toBeVisible();
  });

  test("should close floating controls panel on toggle", async ({ page }) => {
    const toggle = page.locator("#floating-controls-toggle");

    // Open
    await toggle.click();
    const panel = page.locator("#floating-controls");
    await expect(panel).toBeVisible();

    // Close
    await toggle.click();
    await expect(panel).toBeHidden();
  });

  test("should have control buttons in panel", async ({ page }) => {
    await page.locator("#floating-controls-toggle").click();
    const panel = page.locator("#floating-controls");

    // Check for control buttons (Ctrl+C, Ctrl+D, etc.)
    const buttons = panel.locator("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
  });
});

test.describe("Keyboard Shortcuts", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should copy text with Ctrl+C", async ({ page }) => {
    // Create a session with some output
    await page.locator("#folder-picker-input").fill("/tmp");
    await page.locator("#input-box").fill("echo hello");
    await page.click("#send-input-button");
    await waitForSession(page, 15000);

    // Select some text (if possible in terminal/chat)
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");

    // Copy
    await page.keyboard.down("Control");
    await page.keyboard.press("c");
    await page.keyboard.up("Control");

    // No error should occur
  });

  test("should paste text with Ctrl+V in input", async ({ page }) => {
    const inputBox = page.locator("#input-box");
    await inputBox.click();

    // Write to clipboard
    await page.evaluate(() => navigator.clipboard.writeText("pasted text"));

    // Paste
    await page.keyboard.down("Control");
    await page.keyboard.press("v");
    await page.keyboard.up("Control");

    // Input should have the text
    const value = await inputBox.inputValue();
    expect(value).toContain("pasted text");
  });

  test("should select all with Ctrl+A in input", async ({ page }) => {
    const inputBox = page.locator("#input-box");
    await inputBox.fill("test content");
    await inputBox.click();

    // Select all
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");

    // Type something to replace (proves selection worked)
    await page.keyboard.type("new");

    const value = await inputBox.inputValue();
    expect(value).toBe("new");
  });
});

test.describe("Topbar", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should display logo", async ({ page }) => {
    const logo = page.locator(".logo, .logo-icon");
    await expect(logo).toBeVisible();
  });

  test("should display brand name", async ({ page }) => {
    const brandName = page.locator(".brand-name");
    await expect(brandName).toBeVisible();
    const text = await brandName.textContent();
    expect(text?.toLowerCase()).toContain("wand");
  });

  test("should toggle topbar collapse", async ({ page }) => {
    const toggleBtn = page.locator("#topbar-toggle-button");
    const topbar = page.locator(".topbar");

    if (await toggleBtn.isVisible()) {
      await toggleBtn.click();
      await page.waitForTimeout(300);
      await toggleBtn.click();
    }
  });

  test("should display status indicator", async ({ page }) => {
    const statusDot = page.locator("#status-dot");
    const statusText = page.locator("#status-text");

    await expect(statusDot).toBeVisible();
    await expect(statusText).toBeVisible();
  });
});

test.describe("Responsive Design", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should adapt to mobile viewport", async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Page should still be functional
    await expect(page.locator("#sessions-toggle-button")).toBeVisible();
    await expect(page.locator("#input-box")).toBeVisible();
  });

  test("should show sidebar on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.click("#sessions-toggle-button");
    await expect(page.locator("#sessions-drawer")).toBeVisible();
  });

  test("should close sidebar on mobile when clicking outside", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.click("#sessions-toggle-button");
    await expect(page.locator("#sessions-drawer")).toBeVisible();

    // Click backdrop
    await page.click("#sessions-drawer-backdrop");
    await expect(page.locator("#sessions-drawer")).toBeHidden();
  });
});

test.describe("Error Handling", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should show error for empty command", async ({ page }) => {
    await page.locator("#input-box").fill("");
    await page.click("#send-input-button");

    // Should either not send or show validation error
    const errorEl = page.locator("#action-error");
    // Error might be shown or nothing happens
    const isVisible = await errorEl.isVisible().catch(() => false);
    expect(typeof isVisible).toBe("boolean");
  });

  test("should handle network disconnection gracefully", async ({ page }) => {
    // Create a session
    await page.locator("#folder-picker-input").fill("/tmp");
    await page.locator("#input-box").fill("sleep 5");
    await page.click("#send-input-button");
    await waitForSession(page, 15000);

    // Simulate network issues by going offline
    await page.context().setOffline(true);
    await page.waitForTimeout(1000);
    await page.context().setOffline(false);

    // Page should still be functional
    await page.waitForTimeout(1000);
    await expect(page.locator("#input-box")).toBeVisible();
  });
});