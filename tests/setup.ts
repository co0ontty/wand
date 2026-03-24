import { Page, expect } from "@playwright/test";
import { TEST_PASSWORD, TEST_PORT } from "./global-setup";

export { TEST_PASSWORD };

export interface TestConfig {
  baseURL: string;
}

export const defaultConfig: TestConfig = {
  baseURL: `https://localhost:${TEST_PORT}`,
};

/**
 * Login helper - authenticates and waits for main UI to load
 */
export async function login(page: Page, password: string = TEST_PASSWORD): Promise<void> {
  await page.goto("/");
  await page.waitForSelector("#password", { state: "visible" });
  await page.fill("#password", password);
  await page.click("#login-button");

  // Wait for main UI to appear (indicates successful login)
  await page.waitForSelector("#sessions-toggle-button", { state: "visible" });
}

/**
 * Logout helper
 */
export async function logout(page: Page): Promise<void> {
  await page.click("#logout-button");
  await page.waitForSelector("#password", { state: "visible" });
}

/**
 * Open the sessions sidebar drawer
 */
export async function openSidebar(page: Page): Promise<void> {
  const drawer = page.locator("#sessions-drawer");
  const isVisible = await drawer.isVisible();
  if (!isVisible) {
    await page.click("#sessions-toggle-button");
    await page.waitForSelector("#sessions-drawer", { state: "visible" });
  }
}

/**
 * Close the sessions sidebar drawer
 */
export async function closeSidebar(page: Page): Promise<void> {
  const drawer = page.locator("#sessions-drawer");
  const isVisible = await drawer.isVisible();
  if (isVisible) {
    await page.click("#close-drawer-button");
    await page.waitForSelector("#sessions-drawer", { state: "hidden" });
  }
}

/**
 * Open the new session modal
 */
export async function openNewSessionModal(page: Page): Promise<void> {
  await openSidebar(page);
  await page.click("#drawer-new-session-button");
  await page.waitForSelector("#session-modal", { state: "visible" });
}

/**
 * Close the new session modal
 */
export async function closeNewSessionModal(page: Page): Promise<void> {
  await page.click('#session-modal .modal-close');
  await page.waitForSelector("#session-modal", { state: "hidden" });
}

/**
 * Open settings modal
 */
export async function openSettings(page: Page): Promise<void> {
  await page.click("#settings-button");
  await page.waitForSelector("#settings-modal", { state: "visible" });
}

/**
 * Close settings modal
 */
export async function closeSettings(page: Page): Promise<void> {
  await page.click('#settings-modal .modal-close');
  await page.waitForSelector("#settings-modal", { state: "hidden" });
}

/**
 * Wait for a session to be created and appear in the list
 */
export async function waitForSession(page: Page, timeout = 10000): Promise<void> {
  await page.waitForSelector("#sessions-list .session-item", { state: "visible", timeout });
}

/**
 * Switch to chat view
 */
export async function switchToChatView(page: Page): Promise<void> {
  await page.click("#view-chat-btn");
  await expect(page.locator("#chat-output")).toHaveClass(/active/);
}

/**
 * Switch to terminal view
 */
export async function switchToTerminalView(page: Page): Promise<void> {
  await page.click("#view-terminal-btn");
  await expect(page.locator("#output")).toHaveClass(/active/);
}

/**
 * Get the folder picker input element
 */
export function getFolderPickerInput(page: Page) {
  return page.locator("#folder-picker-input");
}

/**
 * Get the folder picker dropdown
 */
export function getFolderPickerDropdown(page: Page) {
  return page.locator("#folder-picker-dropdown");
}

/**
 * Wait for folder picker suggestions to load
 */
export async function waitForFolderSuggestions(page: Page): Promise<void> {
  await page.waitForSelector("#folder-picker-dropdown:not(.hidden)", { state: "visible" });
}

/**
 * Clear the folder picker input
 */
export async function clearFolderPickerInput(page: Page): Promise<void> {
  const input = getFolderPickerInput(page);
  await input.click();
  await input.fill("");
}

/**
 * Type in folder picker input with debounce wait
 */
export async function typeInFolderPicker(page: Page, text: string): Promise<void> {
  const input = getFolderPickerInput(page);
  await input.click();
  await input.fill(text);
  // Wait for debounce (300ms typically)
  await page.waitForTimeout(350);
}

/**
 * Check if dark mode is active
 */
export async function isDarkMode(page: Page): Promise<boolean> {
  const html = page.locator("html");
  const theme = await html.getAttribute("data-theme");
  return theme === "dark";
}

/**
 * Toggle dark mode via settings
 */
export async function toggleDarkMode(page: Page): Promise<void> {
  await openSettings(page);
  const darkModeToggle = page.locator("#settings-dark-mode-toggle");
  await darkModeToggle.click();
  await closeSettings(page);
}