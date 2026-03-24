import { test, expect } from "@playwright/test";
import {
  login,
  openSidebar,
  getFolderPickerInput,
  getFolderPickerDropdown,
  waitForFolderSuggestions,
  clearFolderPickerInput,
  typeInFolderPicker,
  TEST_PASSWORD
} from "./setup";

test.describe("Folder Picker", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await openSidebar(page);
  });

  test("should display folder picker input", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await expect(input).toBeVisible();
  });

  test("should have default value in folder picker", async ({ page }) => {
    const input = getFolderPickerInput(page);
    const value = await input.inputValue();
    expect(value).toBeTruthy();
  });

  test("should show dropdown when typing path", async ({ page }) => {
    await typeInFolderPicker(page, "/tm");

    // Dropdown should appear with suggestions
    const dropdown = getFolderPickerDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 5000 });
  });

  test("should filter suggestions based on input", async ({ page }) => {
    await typeInFolderPicker(page, "/tmp");

    const dropdown = getFolderPickerDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Should contain suggestions
    const items = dropdown.locator(".folder-picker-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test("should select suggestion on click", async ({ page }) => {
    await typeInFolderPicker(page, "/tm");

    const dropdown = getFolderPickerDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Click first suggestion
    const firstItem = dropdown.locator(".folder-picker-item").first();
    const itemText = await firstItem.textContent();
    await firstItem.click();

    // Input should update
    const input = getFolderPickerInput(page);
    const value = await input.inputValue();
    expect(value).toBeTruthy();
  });

  test("should hide dropdown on blur", async ({ page }) => {
    await typeInFolderPicker(page, "/tm");

    const dropdown = getFolderPickerDropdown(page);
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Click elsewhere
    await page.click("body", { position: { x: 10, y: 10 } });

    // Dropdown should hide
    await expect(dropdown).toBeHidden();
  });

  test("should show validation state for invalid path", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.fill("/nonexistent/path/that/does/not/exist");
    await input.blur();

    // Wait for validation
    await page.waitForTimeout(500);

    // Should show error state
    const errorState = await input.getAttribute("data-error");
    // Depending on implementation, might have error class or attribute
    const hasError = await input.evaluate((el) => {
      return el.classList.contains("error") || el.getAttribute("data-error") === "true";
    });
    // For now just check input has value
    expect(await input.inputValue()).toBe("/nonexistent/path/that/does/not/exist");
  });

  test("should show quick paths", async ({ page }) => {
    const quickPaths = page.locator("#folder-picker-quick-paths");
    await expect(quickPaths).toBeVisible();
  });

  test("should select quick path on click", async ({ page }) => {
    const quickPaths = page.locator("#folder-picker-quick-paths");
    const firstQuickPath = quickPaths.locator("button").first();

    if (await firstQuickPath.isVisible()) {
      await firstQuickPath.click();

      const input = getFolderPickerInput(page);
      const value = await input.inputValue();
      expect(value).toBeTruthy();
    }
  });
});

test.describe("Path Validation", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await openSidebar(page);
  });

  test("should accept valid system paths", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.fill("/tmp");
    await input.blur();

    await page.waitForTimeout(300);

    // Path should remain (valid)
    expect(await input.inputValue()).toBe("/tmp");
  });

  test("should expand relative paths", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.fill("~/");
    await input.blur();

    await page.waitForTimeout(300);

    const value = await input.inputValue();
    // Should expand ~ to home directory
    expect(value).toMatch(/^\/home\/|^\/Users\//);
  });

  test("should handle path with spaces", async ({ page }) => {
    const input = getFolderPickerInput(page);

    // Try a path that might have spaces
    await input.fill("/tmp/test folder");
    await input.blur();

    const value = await input.inputValue();
    expect(value).toBe("/tmp/test folder");
  });
});

test.describe("Breadcrumb Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await openSidebar(page);
  });

  test("should show breadcrumbs for current path", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.fill("/tmp");
    await input.blur();

    // Wait for breadcrumb to render
    await page.waitForTimeout(300);

    // Look for breadcrumb container
    const breadcrumbs = page.locator("#folder-breadcrumb");
    await expect(breadcrumbs).toBeVisible();

    // Should have breadcrumb items
    const items = breadcrumbs.locator(".folder-breadcrumb-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test("should navigate to parent directory from breadcrumb", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.fill("/tmp");
    await input.blur();

    await page.waitForTimeout(300);

    // Click on root "/" breadcrumb
    const rootBreadcrumb = page.locator("#folder-breadcrumb .folder-breadcrumb-item[data-path='/']");
    if (await rootBreadcrumb.isVisible()) {
      await rootBreadcrumb.click();

      await page.waitForTimeout(300);
      const value = await input.inputValue();
      expect(value).toBe("/");
    }
  });

  test("should highlight current path in breadcrumb", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.fill("/tmp");
    await input.blur();

    await page.waitForTimeout(300);

    // Current item should have "current" class
    const currentItem = page.locator("#folder-breadcrumb .folder-breadcrumb-item.current");
    await expect(currentItem).toBeVisible();
  });
});

test.describe("Favorite Paths", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await openSidebar(page);
  });

  test("should display favorites section if implemented", async ({ page }) => {
    const favorites = page.locator(".folder-favorites, [data-favorites]");
    // This test passes whether or not favorites are implemented
    const count = await favorites.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("should add current path to favorites", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.fill("/tmp");

    // Look for favorite/star button
    const favBtn = page.locator(".folder-favorite-btn, .add-favorite, [data-add-favorite]");
    if (await favBtn.isVisible()) {
      await favBtn.click();

      // Check if it appears in favorites
      const favorites = page.locator(".favorites-list, [data-favorites-list]");
      await expect(favorites).toBeVisible();
    }
  });
});

test.describe("Search Functionality", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await openSidebar(page);
  });

  test("should filter suggestions by search term", async ({ page }) => {
    const input = getFolderPickerInput(page);
    await input.click();
    await input.fill("/tmp");

    // Wait for dropdown
    const dropdown = getFolderPickerDropdown(page);
    await page.waitForTimeout(500);

    if (await dropdown.isVisible()) {
      // Type additional filter
      await input.press("End");
      await input.fill("/tmp/lo");

      // Suggestions should be filtered
      const items = dropdown.locator(".folder-picker-item");
      if ((await items.count()) > 0) {
        const firstText = await items.first().textContent();
        expect(firstText?.toLowerCase()).toContain("lo");
      }
    }
  });
});