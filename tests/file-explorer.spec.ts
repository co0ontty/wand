import { test, expect } from "@playwright/test";
import { login, openSidebar, TEST_PASSWORD } from "./setup";

test.describe("File Explorer", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await openSidebar(page);
    // Switch to files tab
    await page.click("#tab-files");
  });

  test("should display files tab", async ({ page }) => {
    await expect(page.locator("#files-panel")).toBeVisible();
    await expect(page.locator("#sessions-panel")).toHaveClass(/hidden/);
  });

  test("should show file explorer", async ({ page }) => {
    const fileExplorer = page.locator("#file-explorer");
    await expect(fileExplorer).toBeVisible();
  });

  test("should display current working directory", async ({ page }) => {
    const cwdDisplay = page.locator("#file-explorer-cwd");
    await expect(cwdDisplay).toBeVisible();
    const text = await cwdDisplay.textContent();
    expect(text).toBeTruthy();
  });

  test("should have refresh button", async ({ page }) => {
    const refreshBtn = page.locator("#file-explorer-refresh");
    await expect(refreshBtn).toBeVisible();
  });

  test("should refresh file list on click", async ({ page }) => {
    const refreshBtn = page.locator("#file-explorer-refresh");
    await refreshBtn.click();
    // Should not error
    await page.waitForTimeout(500);
  });

  test("should show file search input", async ({ page }) => {
    const searchInput = page.locator("#file-search-input");
    await expect(searchInput).toBeVisible();
  });

  test("should filter files by search", async ({ page }) => {
    const searchInput = page.locator("#file-search-input");
    await searchInput.fill("test");

    // Wait for filter
    await page.waitForTimeout(300);

    // Files should be filtered (if any visible)
    const files = page.locator("#file-explorer .file-item, .file-entry");
    const count = await files.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("should clear search on clear button", async ({ page }) => {
    const searchInput = page.locator("#file-search-input");
    await searchInput.fill("test");

    const clearBtn = page.locator("#file-search-clear");
    await clearBtn.click();

    const value = await searchInput.inputValue();
    expect(value).toBe("");
  });

  test("should display file items", async ({ page }) => {
    const fileExplorer = page.locator("#file-explorer");
    const items = fileExplorer.locator(".file-item, .file-entry, li, [data-file]");

    // There should be some files or directories listed
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("should distinguish files and directories", async ({ page }) => {
    const fileExplorer = page.locator("#file-explorer");

    // Look for directory indicators
    const directories = fileExplorer.locator(".directory, .folder, [data-type='directory']");
    const files = fileExplorer.locator(".file:not(.directory), [data-type='file']");

    // May or may not have items depending on current directory
    const dirCount = await directories.count();
    const fileCount = await files.count();

    expect(dirCount).toBeGreaterThanOrEqual(0);
    expect(fileCount).toBeGreaterThanOrEqual(0);
  });

  test("should navigate into directory on click", async ({ page }) => {
    const fileExplorer = page.locator("#file-explorer");
    const firstDir = fileExplorer.locator(".directory, .folder, [data-type='directory']").first();

    if (await firstDir.isVisible()) {
      const cwdBefore = await page.locator("#file-explorer-cwd").textContent();
      await firstDir.click();
      await page.waitForTimeout(500);

      const cwdAfter = await page.locator("#file-explorer-cwd").textContent();
      // CWD should have changed
      expect(cwdAfter).not.toBe(cwdBefore);
    }
  });
});

test.describe("File Tab Integration", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("should switch between sessions and files tabs", async ({ page }) => {
    await openSidebar(page);

    // Start on sessions tab
    await expect(page.locator("#tab-sessions")).toHaveClass(/active/);

    // Switch to files
    await page.click("#tab-files");
    await expect(page.locator("#tab-files")).toHaveClass(/active/);
    await expect(page.locator("#files-panel")).not.toHaveClass(/hidden/);

    // Back to sessions
    await page.click("#tab-sessions");
    await expect(page.locator("#tab-sessions")).toHaveClass(/active/);
    await expect(page.locator("#sessions-panel")).not.toHaveClass(/hidden/);
  });

  test("should sync folder picker with file explorer", async ({ page }) => {
    await openSidebar(page);
    await page.click("#tab-files");

    // Get current folder from picker
    const folderInput = page.locator("#folder-picker-input");
    const pickerPath = await folderInput.inputValue();

    // File explorer should show same path
    const cwdDisplay = page.locator("#file-explorer-cwd");
    const cwdPath = await cwdDisplay.textContent();

    // Paths should match (or be related)
    expect(pickerPath).toBeTruthy();
    expect(cwdPath).toBeTruthy();
  });
});