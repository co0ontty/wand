import { test, expect } from "@playwright/test";
import { login, switchToChatView, TEST_PASSWORD } from "./setup";

test("find error in attachEventListeners", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", msg => logs.push(msg.text()));
  page.on("pageerror", err => logs.push(`[PAGE_ERROR] ${err.message}`));

  await page.goto("https://localhost:8544", { waitUntil: "domcontentloaded" });

  // Login
  await page.fill("#password", "test-change-me");
  await page.click("#login-button");
  await page.waitForSelector("#sessions-toggle-button", { state: "visible" });
  await page.waitForTimeout(500);

  // Get the page source
  const html = await page.content();

  // Extract the entire attachEventListeners function
  const funcStart = html.indexOf("function attachEventListeners()");
  // Find the guard block
  const guardIdx = html.indexOf("if (!_docClickBound)");

  // Get the code between the function start and the guard
  // Find where the function body starts (after the opening {)
  const bodyStart = html.indexOf("{", funcStart) + 1;

  // Extract just the portion that should execute after login (skip the loginButton block)
  const afterLoginReturn = html.indexOf("return;\n", bodyStart);
  const afterLoginBlock = html.indexOf("}", afterLoginReturn);

  // Get code from after the loginButton block to the guard
  const relevantCode = html.substring(afterLoginBlock + 1, guardIdx);

  // Try to execute this code and see if it errors
  const error = await page.evaluate((code) => {
    try {
      // We can't eval the code directly since it references local vars
      // But we can look for obvious issues

      // Instead, let's try to manually re-invoke the problematic section
      // by monkey-patching the function

      // Actually, let's check what happens if we try calling attachEventListeners
      // It's in a closure so we can't call it directly

      // Let's instead check for errors by examining the page state
      return {
        hasLoginButton: !!document.getElementById("login-button"),
        hasSessionsToggle: !!document.getElementById("sessions-toggle-button"),
        hasFolderPickerInput: !!document.getElementById("folder-picker-input"),
        hasFolderPickerDropdown: !!document.getElementById("folder-picker-dropdown"),
        hasFolderPickerToggle: !!document.getElementById("folder-picker-toggle"),
        hasChatMessages: !!document.querySelector(".chat-messages"),
        hasInputBox: !!document.getElementById("input-box"),
        // Check if the page has welcome view or session view
        hasWelcomeInput: !!document.getElementById("welcome-input"),
        hasQuickStartGrid: !!document.getElementById("quick-start-grid"),
      };
    } catch (e: any) {
      return { error: e.message };
    }
  }, relevantCode);

  console.log("Page state after login:", error);

  // Now let me try to find the actual error by evaluating chunks of the code
  // But first, let me try a different approach: patch console.error
  const error2 = await page.evaluate(() => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = function(...args: any[]) {
      errors.push(args.map(String).join(" "));
      origError.apply(console, args);
    };

    // Try to find what state._docClickBound equivalent is
    // Since we can't access the closure, let's check if ANY document click handlers
    // respond to tool-toggle

    const div = document.createElement("div");
    div.innerHTML = `<div class="tool-use-card collapsed" data-tool-use-id="err-test">
      <div class="tool-use-header" data-tool-toggle>test</div>
    </div>`;
    document.body.appendChild(div);

    const card = div.querySelector(".tool-use-card")!;
    const header = div.querySelector("[data-tool-toggle]")!;

    // Try clicking
    header.click();
    const toggledByExistingHandler = !card.classList.contains("collapsed");

    console.error = origError;
    document.body.removeChild(div);

    return {
      toggledByExistingHandler,
      errors: errors
    };
  });

  console.log("Error test:", error2);

  console.log("\n=== All browser logs ===");
  logs.forEach(l => console.log(l));
});
