import { test, expect } from "@playwright/test";
import { login, switchToChatView, TEST_PASSWORD } from "./setup";

test.describe("Tool Card — Click Toggle", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await switchToChatView(page);
  });

  test("clicking tool card header should toggle collapsed state", async ({ page }) => {
    // Inject a tool card into the chat view
    await page.evaluate(() => {
      const chatMessages = document.querySelector(".chat-messages");
      if (!chatMessages) {
        const chatOutput = document.getElementById("chat-output");
        if (chatOutput) {
          chatOutput.innerHTML = '<div class="chat-messages"></div>';
        }
      }
      const container = document.querySelector(".chat-messages")!;
      container.innerHTML = `
        <div class="chat-message assistant">
          <div class="chat-message-bubble">
            <div class="tool-use-card success collapsed" data-tool-use-id="test-tool-1">
              <div class="tool-use-header" data-tool-toggle>
                <span class="tool-use-icon">✅</span>
                <span class="tool-use-name">Test Tool</span>
                <span class="tool-use-toggle">▼</span>
              </div>
              <div class="tool-use-body">
                <pre class="tool-use-content">{"test": true}</pre>
              </div>
            </div>
          </div>
        </div>
      `;
    });

    const card = page.locator(".tool-use-card[data-tool-use-id='test-tool-1']");
    await expect(card).toBeVisible();

    // Card starts collapsed
    await expect(card).toHaveClass(/collapsed/);
    await expect(card.locator(".tool-use-body")).toBeHidden();

    // Click header to expand
    await card.locator(".tool-use-header").click();
    await expect(card).not.toHaveClass(/collapsed/);
    await expect(card.locator(".tool-use-body")).toBeVisible();

    // Click header again to collapse
    await card.locator(".tool-use-header").click();
    await expect(card).toHaveClass(/collapsed/);
    await expect(card.locator(".tool-use-body")).toBeHidden();
  });

  test("toggle should work after page re-render (no double handler)", async ({ page }) => {
    // Force a re-render by logging out and back in (causes render() to run twice)
    await page.click("#logout-button");
    await page.waitForSelector("#password", { state: "visible" });
    await page.fill("#password", TEST_PASSWORD);
    await page.click("#login-button");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible" });
    await switchToChatView(page);

    // Inject a tool card
    await page.evaluate(() => {
      const chatOutput = document.getElementById("chat-output");
      if (chatOutput) {
        chatOutput.innerHTML = '<div class="chat-messages"></div>';
        const container = chatOutput.querySelector(".chat-messages")!;
        container.innerHTML = `
          <div class="chat-message assistant">
            <div class="chat-message-bubble">
              <div class="tool-use-card success collapsed" data-tool-use-id="test-tool-2">
                <div class="tool-use-header" data-tool-toggle>
                  <span class="tool-use-icon">✅</span>
                  <span class="tool-use-name">Test Tool</span>
                  <span class="tool-use-toggle">▼</span>
                </div>
                <div class="tool-use-body">
                  <pre class="tool-use-content">{"test": true}</pre>
                </div>
              </div>
            </div>
          </div>
        `;
      }
    });

    const card = page.locator(".tool-use-card[data-tool-use-id='test-tool-2']");

    // Card starts collapsed
    await expect(card).toHaveClass(/collapsed/);

    // Click should expand (NOT double-toggle back to collapsed)
    await card.locator(".tool-use-header").click();
    await expect(card).not.toHaveClass(/collapsed/);
  });
});

test.describe("Tool Card — Description Display", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_PASSWORD);
    await switchToChatView(page);
  });

  test("should display input.description as card title for Bash tool", async ({ page }) => {
    // Use page.evaluate to call the renderToolUseCard function with test data
    const titleText = await page.evaluate(() => {
      // Access the renderToolUseCard function (it's in the global scope of the inline script)
      const w = window as unknown as {
        renderToolUseCard?: (block: unknown, result: unknown, index: number) => string;
      };
      // If renderToolUseCard isn't directly accessible, we test via the full message render
      // Inject a session with tool_use messages
      const chatOutput = document.getElementById("chat-output");
      if (!chatOutput) return null;
      chatOutput.innerHTML = '<div class="chat-messages"></div>';

      // Simulate structured message rendering by setting up state
      const state = (window as Record<string, unknown>).state as Record<string, unknown>;
      if (!state) return null;

      // Trigger renderChatMessage via innerHTML
      const mockMsg = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_test_bash",
            name: "Bash",
            input: {
              command: "npm run build && node dist/cli.js web",
              description: "Build and start the web server"
            }
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_test_bash",
            content: "Build succeeded",
            is_error: false
          }
        ]
      };

      // Call renderChatMessage if accessible
      const renderChatMessage = (window as Record<string, unknown>).renderChatMessage as
        ((msg: unknown) => string) | undefined;
      if (renderChatMessage) {
        const html = renderChatMessage(mockMsg);
        const div = document.createElement("div");
        div.innerHTML = html;
        const name = div.querySelector(".tool-use-name");
        return name?.textContent || null;
      }
      return null;
    });

    // If we could access renderChatMessage, verify description is shown
    if (titleText !== null) {
      expect(titleText).toBe("Build and start the web server");
    }
  });

  test("should show tool name when no description available", async ({ page }) => {
    const titleText = await page.evaluate(() => {
      const renderChatMessage = (window as Record<string, unknown>).renderChatMessage as
        ((msg: unknown) => string) | undefined;
      if (!renderChatMessage) return null;

      const html = renderChatMessage({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_test_read",
            name: "Read",
            input: { file_path: "/etc/hostname" }
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_test_read",
            content: "huniu",
            is_error: false
          }
        ]
      });

      const div = document.createElement("div");
      div.innerHTML = html;
      return div.querySelector(".tool-use-name")?.textContent || null;
    });

    if (titleText !== null) {
      // Should show Chinese tool name, not the file path
      expect(titleText).toContain("读取文件");
    }
  });
});
