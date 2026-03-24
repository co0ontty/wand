import { test, expect } from "@playwright/test";
import {
  login,
  openSidebar,
  closeSidebar,
  openNewSessionModal,
  closeNewSessionModal,
  waitForSession,
  TEST_PASSWORD
} from "./setup";

test.describe("Session Management", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should display sidebar toggle button", async ({ page }) => {
    await expect(page.locator("#sessions-toggle-button")).toBeVisible();
  });

  test("should open and close sidebar", async ({ page }) => {
    // Open sidebar
    await openSidebar(page);
    await expect(page.locator("#sessions-drawer")).toBeVisible();

    // Close sidebar
    await closeSidebar(page);
    await expect(page.locator("#sessions-drawer")).toBeHidden();
  });

  test("should close sidebar on backdrop click", async ({ page }) => {
    await openSidebar(page);
    await expect(page.locator("#sessions-drawer")).toBeVisible();

    // Click backdrop
    await page.click("#sessions-drawer-backdrop");
    await expect(page.locator("#sessions-drawer")).toBeHidden();
  });

  test("should display session count in sidebar", async ({ page }) => {
    await openSidebar(page);
    const sessionCount = page.locator("#session-count");
    await expect(sessionCount).toBeVisible();
    // Session count should be a number
    const count = await sessionCount.textContent();
    expect(count).toMatch(/^\d+$/);
  });

  test("should show new session button in topbar", async ({ page }) => {
    await expect(page.locator("#topbar-new-session-button")).toBeVisible();
  });

  test("should show new session button in drawer", async ({ page }) => {
    await openSidebar(page);
    await expect(page.locator("#drawer-new-session-button")).toBeVisible();
  });

  test("should open new session modal from drawer", async ({ page }) => {
    await openNewSessionModal(page);
    await expect(page.locator("#session-modal")).toBeVisible();
  });

  test("should close modal on close button", async ({ page }) => {
    await openNewSessionModal(page);
    await closeNewSessionModal(page);
    await expect(page.locator("#session-modal")).toBeHidden();
  });

  test("should close modal on Escape key", async ({ page }) => {
    await openNewSessionModal(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#session-modal")).toBeHidden();
  });

  test("should have tool selection cards in modal", async ({ page }) => {
    await openNewSessionModal(page);

    // Check Claude tool card
    const claudeCard = page.locator('[data-tool="claude"]');
    await expect(claudeCard).toBeVisible();

    // Check Codex tool card
    const codexCard = page.locator('[data-tool="codex"]');
    await expect(codexCard).toBeVisible();
  });

  test("should select tool card on click", async ({ page }) => {
    await openNewSessionModal(page);

    const claudeCard = page.locator('[data-tool="claude"]');
    await claudeCard.click();

    // Should have active class
    await expect(claudeCard).toHaveClass(/active/);
  });

  test("should display mode selector", async ({ page }) => {
    await openSidebar(page);

    const modeSelect = page.locator("#chat-mode-select");
    await expect(modeSelect).toBeVisible();

    // Check available options
    const options = await modeSelect.locator("option").allTextContents();
    expect(options.length).toBeGreaterThan(0);
  });

  test("should switch between files and sessions tabs", async ({ page }) => {
    await openSidebar(page);

    // Sessions tab should be active by default
    await expect(page.locator("#tab-sessions")).toHaveClass(/active/);
    await expect(page.locator("#sessions-panel")).not.toHaveClass(/hidden/);

    // Click files tab
    await page.click("#tab-files");
    await expect(page.locator("#tab-files")).toHaveClass(/active/);
    await expect(page.locator("#files-panel")).not.toHaveClass(/hidden/);
    await expect(page.locator("#sessions-panel")).toHaveClass(/hidden/);

    // Back to sessions tab
    await page.click("#tab-sessions");
    await expect(page.locator("#tab-sessions")).toHaveClass(/active/);
    await expect(page.locator("#sessions-panel")).not.toHaveClass(/hidden/);
  });

  test("should display blank state when no session selected", async ({ page }) => {
    // If no session selected, should show blank chat
    const blankChat = page.locator("#blank-chat");
    await expect(blankChat).toBeVisible();

    // Welcome input should be visible
    await expect(page.locator("#welcome-input")).toBeVisible();
  });
});

test.describe("Session Creation", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should create new session from welcome input", async ({ page }) => {
    // Type in welcome input
    await page.fill("#welcome-input", "echo hello");
    await page.click("#welcome-send-btn");

    // Wait for session to be created
    await waitForSession(page, 15000);

    // Should have at least one session in list
    const sessions = page.locator("#sessions-list .session-item");
    await expect(sessions.first()).toBeVisible();
  });

  test("should create new session from input box after selecting folder", async ({ page }) => {
    await openSidebar(page);

    // Set folder path
    const folderInput = page.locator("#folder-picker-input");
    await folderInput.fill("/tmp");

    // Type command
    const inputBox = page.locator("#input-box");
    await inputBox.fill("echo test");

    // Send
    await page.click("#send-input-button");

    // Wait for session
    await waitForSession(page, 15000);
  });
});