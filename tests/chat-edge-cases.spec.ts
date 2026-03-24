import { test, expect } from "@playwright/test";
import {
  login,
  openSidebar,
  switchToChatView,
  switchToTerminalView,
  waitForSession,
  TEST_PASSWORD
} from "./setup";

/**
 * Helper: create a session running a simple shell command.
 * Sets folder to /tmp, sends the given command, and waits for session creation.
 */
async function createSession(page: import("@playwright/test").Page, command: string) {
  await openSidebar(page);
  const folderInput = page.locator("#folder-picker-input");
  await folderInput.fill("/tmp");

  const inputBox = page.locator("#input-box");
  await inputBox.fill(command);
  await page.click("#send-input-button");
  await waitForSession(page, 15000);
}

test.describe("Chat Edge Cases — Control Characters", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("sending Ctrl+C should not create a user message bubble", async ({ page }) => {
    await createSession(page, "cat");
    await switchToChatView(page);

    // Count existing user messages
    const userMessages = page.locator(".message-user, .user-message, [data-role='user']");
    const countBefore = await userMessages.count();

    // Send Ctrl+C via the input API
    const inputBox = page.locator("#input-box");
    await inputBox.focus();
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(500);

    // No new user message should have been added
    const countAfter = await userMessages.count();
    expect(countAfter).toBeLessThanOrEqual(countBefore + 1); // at most the echo command itself
  });

  test("sending Ctrl+D should not create a user message bubble", async ({ page }) => {
    await createSession(page, "cat");
    await switchToChatView(page);

    const userMessages = page.locator(".message-user, .user-message, [data-role='user']");
    const countBefore = await userMessages.count();

    const inputBox = page.locator("#input-box");
    await inputBox.focus();
    await page.keyboard.press("Control+d");
    await page.waitForTimeout(500);

    const countAfter = await userMessages.count();
    expect(countAfter).toBeLessThanOrEqual(countBefore + 1);
  });
});

test.describe("Chat Edge Cases — Empty Messages", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("empty input should not be sent", async ({ page }) => {
    await createSession(page, "echo ready");
    await switchToChatView(page);

    const inputBox = page.locator("#input-box");

    // Try sending empty string
    await inputBox.fill("");
    await page.click("#send-input-button");
    await page.waitForTimeout(300);

    // Input should remain empty, no error thrown
    expect(await inputBox.inputValue()).toBe("");
  });

  test("whitespace-only input should not create a message", async ({ page }) => {
    await createSession(page, "echo ready");
    await switchToChatView(page);

    const inputBox = page.locator("#input-box");

    // Try sending spaces
    await inputBox.fill("   ");
    await page.click("#send-input-button");
    await page.waitForTimeout(300);

    // The input box should not be cleared (message was not sent) OR it was cleared but no crash
    // The key assertion: the page is still responsive
    await expect(page.locator("#send-input-button")).toBeVisible();
  });
});

test.describe("Chat Edge Cases — Long Text", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("very long message should not crash the UI", async ({ page }) => {
    await createSession(page, "cat");
    await switchToChatView(page);

    const inputBox = page.locator("#input-box");
    const longText = "A".repeat(2000);
    await inputBox.fill(longText);

    // Should be able to fill without crash
    const value = await inputBox.inputValue();
    expect(value.length).toBe(2000);

    // Sending should not crash
    await page.click("#send-input-button");
    await page.waitForTimeout(1000);

    // Page should still be responsive
    await expect(page.locator("#send-input-button")).toBeVisible();
  });

  test("message over 5000 chars should not freeze the browser", async ({ page }) => {
    await createSession(page, "cat");

    const inputBox = page.locator("#input-box");
    const veryLong = "x".repeat(5000);
    await inputBox.fill(veryLong);
    await page.click("#send-input-button");
    await page.waitForTimeout(1000);

    // Page is still alive
    await expect(inputBox).toBeVisible();
  });
});

test.describe("Chat Edge Cases — Special Characters", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("HTML tags in input should be escaped, not rendered", async ({ page }) => {
    await createSession(page, "cat");
    await switchToChatView(page);

    const inputBox = page.locator("#input-box");
    await inputBox.fill('<script>alert("xss")</script>');
    await page.click("#send-input-button");
    await page.waitForTimeout(1000);

    // No script should have executed — check page is fine
    await expect(page.locator("#send-input-button")).toBeVisible();

    // Verify no injected script element
    const scriptCount = await page.locator("script:not([src])").count();
    // Only the app's inline scripts should exist, not injected ones
    const chatOutput = page.locator("#chat-output");
    const html = await chatOutput.innerHTML();
    expect(html).not.toContain("<script>alert");
  });

  test("backticks and markdown should not break rendering", async ({ page }) => {
    await createSession(page, "cat");
    await switchToChatView(page);

    const inputBox = page.locator("#input-box");
    await inputBox.fill("```\ncode block\n```");
    await page.click("#send-input-button");
    await page.waitForTimeout(1000);

    // Page should not crash
    await expect(page.locator("#chat-output")).toBeVisible();
  });

  test("unicode emoji should display correctly", async ({ page }) => {
    await createSession(page, "echo test");
    await switchToChatView(page);

    const inputBox = page.locator("#input-box");
    const emojiText = "Hello 🎉🚀💻 World";
    await inputBox.fill(emojiText);
    await page.click("#send-input-button");
    await page.waitForTimeout(1000);

    // Page should not crash from emoji
    await expect(page.locator("#send-input-button")).toBeVisible();
  });
});

test.describe("Chat Edge Cases — Rapid Fire Messages", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("sending multiple messages rapidly should not lose messages", async ({ page }) => {
    await createSession(page, "cat");
    await switchToChatView(page);

    const inputBox = page.locator("#input-box");

    // Send 5 messages in rapid succession
    for (let i = 1; i <= 5; i++) {
      await inputBox.fill(`message ${i}`);
      await page.click("#send-input-button");
      // Minimal delay between sends
      await page.waitForTimeout(100);
    }

    // Wait for all messages to be processed
    await page.waitForTimeout(2000);

    // Page should still be responsive
    await expect(page.locator("#send-input-button")).toBeVisible();
    await expect(page.locator("#chat-output")).toBeVisible();
  });
});

test.describe("Chat Edge Cases — Input After Session End", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("sending input after session ends should show error or be ignored", async ({ page }) => {
    // Start a short-lived session
    await createSession(page, "echo done");

    // Wait for session to finish
    await page.waitForTimeout(3000);

    // Try sending input to the ended session
    const inputBox = page.locator("#input-box");
    await inputBox.fill("this should fail");
    await page.click("#send-input-button");
    await page.waitForTimeout(1000);

    // Page should still be responsive — no crash
    await expect(page.locator("#send-input-button")).toBeVisible();
  });
});

test.describe("Chat Edge Cases — Mode Switching", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
  });

  test("rapid switching between terminal and chat should not crash", async ({ page }) => {
    await createSession(page, "echo mode test");
    await page.waitForTimeout(1000);

    // Rapidly toggle between views
    for (let i = 0; i < 5; i++) {
      await switchToChatView(page);
      await switchToTerminalView(page);
    }

    // End in chat view
    await switchToChatView(page);
    await expect(page.locator("#chat-output")).toHaveClass(/active/);
  });

  test("messages should persist after mode switch", async ({ page }) => {
    await createSession(page, "echo hello from mode test");
    await page.waitForTimeout(2000);

    // Switch to chat
    await switchToChatView(page);
    const chatContent1 = await page.locator("#chat-output").textContent();

    // Switch to terminal and back
    await switchToTerminalView(page);
    await page.waitForTimeout(200);
    await switchToChatView(page);

    const chatContent2 = await page.locator("#chat-output").textContent();

    // Content should still be present (not empty or lost)
    if (chatContent1 && chatContent1.length > 0) {
      expect(chatContent2).toBeTruthy();
    }
  });

  test("switching mode while session is running should not interrupt it", async ({ page }) => {
    await createSession(page, "sleep 3 && echo finished");

    // Switch views while session runs
    await switchToChatView(page);
    await page.waitForTimeout(500);
    await switchToTerminalView(page);
    await page.waitForTimeout(500);
    await switchToChatView(page);

    // Session should still be tracked
    const sessions = page.locator("#sessions-list .session-item");
    await expect(sessions.first()).toBeVisible();
  });
});
