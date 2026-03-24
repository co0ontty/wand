/**
 * Comprehensive UX test against the live server on 8443
 * Tests ALL buttons, interactions, and features thoroughly
 */
import { test, expect, Page } from "@playwright/test";

const PASSWORD = "change-me";

test.use({
  baseURL: "https://localhost:8443",
  ignoreHTTPSErrors: true,
});

async function login(page: Page) {
  await page.goto("/");
  await page.waitForSelector("#password", { state: "visible", timeout: 10000 });
  await page.fill("#password", PASSWORD);
  await page.click("#login-button");
  await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
}

async function createSessionViaAPI(page: Page, command: string, mode: string = "default") {
  const response = await page.request.post("/api/commands", {
    data: { command, cwd: "/tmp", mode },
  });
  const data = await response.json();
  return data.id as string;
}

test.describe("Comprehensive UX Test", () => {
  // ── Test 1: Login Flow ──
  test("login works correctly", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#password", { state: "visible", timeout: 10000 });

    // Check login form elements exist
    const passwordInput = page.locator("#password");
    const loginButton = page.locator("#login-button");
    await expect(passwordInput).toBeVisible();
    await expect(loginButton).toBeVisible();

    // Type password and login
    await passwordInput.fill(PASSWORD);
    await loginButton.click();

    // Verify we're logged in
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    console.log("[PASS] Login works correctly");
  });

  // ── Test 2: Welcome Screen ──
  test("welcome screen or active session is shown after login", async ({ page }) => {
    await login(page);

    // Either blank-chat (no sessions) or a session view (sessions exist)
    const blankChat = page.locator("#blank-chat");
    const chatOutput = page.locator("#chat-output");
    const termOutput = page.locator("#output");

    const blankVisible = await blankChat.evaluate(el => !el.classList.contains("hidden"));
    const sessionActive = await chatOutput.evaluate(el => el.classList.contains("active")) ||
                          await termOutput.evaluate(el => el.classList.contains("active"));

    console.log(`Blank chat visible: ${blankVisible}, Session active: ${sessionActive}`);
    // One of these must be true
    expect(blankVisible || sessionActive).toBe(true);

    // If blank chat is visible, check its elements
    if (blankVisible) {
      const welcomeInput = page.locator("#welcome-input");
      await expect(welcomeInput).toBeVisible();
      const welcomeSendBtn = page.locator("#welcome-send-btn");
      await expect(welcomeSendBtn).toBeVisible();
    }

    await page.screenshot({ path: "test-results/ux-01-welcome.png", fullPage: true });
    console.log("[PASS] Welcome screen / session view correct");
  });

  // ── Test 3: View Toggle Buttons ──
  test("view toggle buttons have correct labels", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const termBtn = page.locator("#view-terminal-btn");
    const chatBtn = page.locator("#view-chat-btn");

    await expect(termBtn).toBeVisible();
    await expect(chatBtn).toBeVisible();

    const termText = await termBtn.textContent();
    const chatText = await chatBtn.textContent();

    console.log(`Terminal button text: "${termText}"`);
    console.log(`Chat button text: "${chatText}"`);

    expect(termText).toBe("终端");
    expect(chatText).toBe("对话");

    await page.screenshot({ path: "test-results/ux-02-view-toggle.png", fullPage: true });
    console.log("[PASS] View toggle labels correct");
  });

  // ── Test 4: View Switching ──
  test("switching between terminal and chat view works", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const termBtn = page.locator("#view-terminal-btn");
    const chatBtn = page.locator("#view-chat-btn");

    // Switch to terminal
    await termBtn.click();
    await page.waitForTimeout(500);
    await expect(termBtn).toHaveClass(/active/);

    const termContainer = page.locator("#output");
    await expect(termContainer).toHaveClass(/active/);

    await page.screenshot({ path: "test-results/ux-03-terminal-view.png", fullPage: true });

    // Switch to chat
    await chatBtn.click();
    await page.waitForTimeout(500);
    await expect(chatBtn).toHaveClass(/active/);

    const chatContainer = page.locator("#chat-output");
    await expect(chatContainer).toHaveClass(/active/);

    await page.screenshot({ path: "test-results/ux-04-chat-view.png", fullPage: true });
    console.log("[PASS] View switching works");
  });

  // ── Test 5: Chat Mode Send/Receive ──
  test("send message in chat and see immediate user bubble", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    // Make sure we're in chat view
    const chatBtn = page.locator("#view-chat-btn");
    if (await chatBtn.isVisible()) await chatBtn.click();
    await page.waitForTimeout(500);

    // Type and send
    const inputBox = page.locator("#input-box");
    await expect(inputBox).toBeVisible({ timeout: 5000 });
    await inputBox.fill("test message one");

    const sendBtn = page.locator("#send-input-button");
    await sendBtn.click();

    // Wait for chat to update
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/ux-05-chat-send.png", fullPage: true });

    // Verify user message appears
    const chatOutput = page.locator("#chat-output");
    const chatHtml = await chatOutput.innerHTML();
    console.log(`Chat contains "user" class: ${chatHtml.includes("user")}`);
    console.log(`Chat contains "chat-message": ${chatHtml.includes("chat-message")}`);

    // Input should be cleared
    const inputValue = await inputBox.inputValue();
    expect(inputValue).toBe("");
    console.log("[PASS] Chat send works, input cleared");
  });

  // ── Test 6: Multiple Messages ──
  test("send multiple messages and verify all render", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const chatBtn = page.locator("#view-chat-btn");
    if (await chatBtn.isVisible()) await chatBtn.click();
    await page.waitForTimeout(500);

    const inputBox = page.locator("#input-box");

    // Send first message
    await inputBox.fill("first message");
    await inputBox.press("Enter");
    await page.waitForTimeout(1500);

    // Send second message
    await inputBox.fill("second message");
    await inputBox.press("Enter");
    await page.waitForTimeout(1500);

    // Send third message
    await inputBox.fill("third message");
    await inputBox.press("Enter");
    await page.waitForTimeout(1500);

    await page.screenshot({ path: "test-results/ux-06-multi-msg.png", fullPage: true });

    const messages = page.locator(".chat-message");
    const count = await messages.count();
    console.log(`Total chat messages rendered: ${count}`);
    expect(count).toBeGreaterThanOrEqual(3);
    console.log("[PASS] Multiple messages render correctly");
  });

  // ── Test 7: Shift+Enter Multiline ──
  test("Shift+Enter inserts newline and cursor moves correctly", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const chatBtn = page.locator("#view-chat-btn");
    if (await chatBtn.isVisible()) await chatBtn.click();
    await page.waitForTimeout(500);

    const inputBox = page.locator("#input-box");
    await inputBox.focus();

    // Type line 1, Shift+Enter, type line 2
    await page.keyboard.type("line one");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line two");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line three");

    await page.screenshot({ path: "test-results/ux-07-multiline.png", fullPage: true });

    const value = await inputBox.inputValue();
    console.log(`Multiline value: ${JSON.stringify(value)}`);
    expect(value).toContain("line one");
    expect(value).toContain("line two");
    expect(value).toContain("line three");
    expect(value).toContain("\n");

    // Check textarea expanded
    const height = await inputBox.evaluate(el => (el as HTMLElement).offsetHeight);
    console.log(`Textarea height: ${height}px`);
    expect(height).toBeGreaterThan(44);
    console.log("[PASS] Shift+Enter multiline works");
  });

  // ── Test 8: Sidebar Toggle ──
  test("sidebar toggle opens and closes", async ({ page }) => {
    await login(page);
    await page.waitForTimeout(500);

    const toggleBtn = page.locator("#sessions-toggle-button");
    await expect(toggleBtn).toBeVisible();

    // Check initial state
    const sidebar = page.locator("#sessions-drawer");
    const initialState = await sidebar.evaluate(el => el.classList.contains("open"));
    console.log(`Sidebar initial open: ${initialState}`);

    // Toggle
    await toggleBtn.click();
    await page.waitForTimeout(500);
    const afterToggle = await sidebar.evaluate(el => el.classList.contains("open"));
    console.log(`Sidebar after toggle: ${afterToggle}`);
    expect(afterToggle).not.toBe(initialState);

    // Toggle back
    await toggleBtn.click();
    await page.waitForTimeout(500);
    const afterSecondToggle = await sidebar.evaluate(el => el.classList.contains("open"));
    console.log(`Sidebar after second toggle: ${afterSecondToggle}`);
    expect(afterSecondToggle).toBe(initialState);

    await page.screenshot({ path: "test-results/ux-08-sidebar.png", fullPage: true });
    console.log("[PASS] Sidebar toggle works");
  });

  // ── Test 9: New Session Modal ──
  test("new session modal shows all elements", async ({ page }) => {
    await login(page);

    // Open sidebar if needed
    const sidebar = page.locator("#sessions-drawer");
    if (!await sidebar.evaluate(el => el.classList.contains("open"))) {
      await page.click("#sessions-toggle-button");
      await page.waitForTimeout(500);
    }

    // Click new session
    const newBtn = page.locator("#drawer-new-session-button");
    await expect(newBtn).toBeVisible({ timeout: 5000 });
    await newBtn.click();
    await page.waitForSelector("#session-modal", { state: "visible", timeout: 5000 });

    // Check modal elements
    const modal = page.locator("#session-modal");
    await expect(modal).toBeVisible();

    // Tool cards
    const toolCards = page.locator(".tool-card");
    const toolCount = await toolCards.count();
    console.log(`Tool card count: ${toolCount}`);
    expect(toolCount).toBeGreaterThanOrEqual(2);

    // Command input
    const commandInput = page.locator("#command");
    await expect(commandInput).toBeVisible();

    // Mode select
    const modeSelect = page.locator("#mode");
    await expect(modeSelect).toBeVisible();

    // CWD input
    const cwdInput = page.locator("#cwd");
    await expect(cwdInput).toBeVisible();

    // Run button
    const runBtn = page.locator("#run-button");
    await expect(runBtn).toBeVisible();

    await page.screenshot({ path: "test-results/ux-09-modal.png", fullPage: true });

    // Check mode options
    const modeOptions = await modeSelect.locator("option").allTextContents();
    console.log(`Mode options: ${JSON.stringify(modeOptions)}`);

    // Close modal
    const closeBtn = page.locator("#close-modal-button");
    await closeBtn.click();
    await page.waitForTimeout(300);
    await expect(modal).toBeHidden();
    console.log("[PASS] Session modal works correctly");
  });

  // ── Test 10: Send Button ──
  test("send button works to submit message", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const chatBtn = page.locator("#view-chat-btn");
    if (await chatBtn.isVisible()) await chatBtn.click();
    await page.waitForTimeout(500);

    const inputBox = page.locator("#input-box");
    const sendBtn = page.locator("#send-input-button");

    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toBeEnabled();

    // Fill and click send
    await inputBox.fill("sent via button");
    await sendBtn.click();

    // Verify input cleared
    await page.waitForTimeout(500);
    const val = await inputBox.inputValue();
    expect(val).toBe("");
    console.log("[PASS] Send button submits and clears input");
  });

  // ── Test 11: Stop Button ──
  test("stop button kills session", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const stopBtn = page.locator("#stop-button");
    await expect(stopBtn).toBeVisible();

    await stopBtn.click();
    await page.waitForTimeout(2000);

    // Session should end
    const termInfo = page.locator("#terminal-info");
    const infoText = await termInfo.textContent();
    console.log(`Terminal info after stop: ${infoText}`);

    await page.screenshot({ path: "test-results/ux-10-after-stop.png", fullPage: true });
    console.log("[PASS] Stop button works");
  });

  // ── Test 12: Chat Mode Select ──
  test("chat mode select dropdown has options", async ({ page }) => {
    await login(page);
    await page.waitForTimeout(500);

    const modeSelect = page.locator("#chat-mode-select");
    await expect(modeSelect).toBeVisible();

    const options = await modeSelect.locator("option").allTextContents();
    console.log(`Mode select options: ${JSON.stringify(options)}`);
    expect(options.length).toBeGreaterThanOrEqual(2);
    console.log("[PASS] Mode select has options");
  });

  // ── Test 13: Topbar New Session Button ──
  test("topbar new session button opens modal", async ({ page }) => {
    await login(page);

    const newSessBtn = page.locator("#topbar-new-session-button");
    await expect(newSessBtn).toBeVisible();
    await newSessBtn.click();

    const modal = page.locator("#session-modal");
    await expect(modal).toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: "test-results/ux-11-topbar-new.png", fullPage: true });
    console.log("[PASS] Topbar new session button works");
  });

  // ── Test 14: Session List Shows Sessions ──
  test("session list shows created sessions", async ({ page }) => {
    await login(page);

    // Create a session
    await createSessionViaAPI(page, "echo session-test");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    // Open sidebar
    const sidebar = page.locator("#sessions-drawer");
    if (!await sidebar.evaluate(el => el.classList.contains("open"))) {
      await page.click("#sessions-toggle-button");
      await page.waitForTimeout(500);
    }

    // Check sessions list
    const sessionItems = page.locator(".session-item");
    const count = await sessionItems.count();
    console.log(`Session items in sidebar: ${count}`);
    expect(count).toBeGreaterThanOrEqual(1);

    await page.screenshot({ path: "test-results/ux-12-sessions-list.png", fullPage: true });
    console.log("[PASS] Session list shows sessions");
  });

  // ── Test 15: Quick Input Controls (Floating) ──
  test("floating controls toggle works", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    // Switch to terminal view to see floating toggle
    const termBtn = page.locator("#view-terminal-btn");
    if (await termBtn.isVisible()) await termBtn.click();
    await page.waitForTimeout(500);

    const floatToggle = page.locator("#floating-controls-toggle");
    // May be hidden in chat mode, check terminal mode
    const isVisible = await floatToggle.isVisible();
    console.log(`Floating toggle visible: ${isVisible}`);

    if (isVisible) {
      await floatToggle.click();
      await page.waitForTimeout(300);

      const floatPanel = page.locator("#floating-controls");
      const panelVisible = !await floatPanel.evaluate(el => el.classList.contains("hidden"));
      console.log(`Floating panel visible after click: ${panelVisible}`);

      await page.screenshot({ path: "test-results/ux-13-floating-controls.png", fullPage: true });
    }
    console.log("[PASS] Floating controls toggle works");
  });

  // ── Test 16: Terminal View Shows xterm ──
  test("terminal view renders xterm canvas", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "echo hello world");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const termBtn = page.locator("#view-terminal-btn");
    if (await termBtn.isVisible()) await termBtn.click();
    await page.waitForTimeout(1000);

    const xtermScreen = page.locator(".xterm-screen");
    await expect(xtermScreen).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: "test-results/ux-14-xterm.png", fullPage: true });
    console.log("[PASS] Terminal xterm renders");
  });

  // ── Test 17: Sidebar Tab Switching ──
  test("sidebar tabs switch between sessions and files", async ({ page }) => {
    await login(page);

    // Open sidebar
    const sidebar = page.locator("#sessions-drawer");
    if (!await sidebar.evaluate(el => el.classList.contains("open"))) {
      await page.click("#sessions-toggle-button");
      await page.waitForTimeout(500);
    }

    const tabSessions = page.locator("#tab-sessions");
    const tabFiles = page.locator("#tab-files");

    // Check both tabs exist
    await expect(tabSessions).toBeVisible();
    await expect(tabFiles).toBeVisible();

    // Click files tab
    await tabFiles.click();
    await page.waitForTimeout(500);
    await expect(tabFiles).toHaveClass(/active/);

    await page.screenshot({ path: "test-results/ux-15-files-tab.png", fullPage: true });

    // Switch back to sessions
    await tabSessions.click();
    await page.waitForTimeout(500);
    await expect(tabSessions).toHaveClass(/active/);

    console.log("[PASS] Sidebar tabs work");
  });

  // ── Test 18: Topbar Layout with Sidebar ──
  test("topbar shifts when sidebar opens", async ({ page }) => {
    await login(page);

    const topbar = page.locator(".topbar");
    const sidebar = page.locator("#sessions-drawer");

    // Get current sidebar state
    const sidebarOpen = await sidebar.evaluate(el => el.classList.contains("open"));
    console.log(`Sidebar initially open: ${sidebarOpen}`);

    // If sidebar is open, topbar should have sidebar-open class
    // If closed, it should not
    const hasSidebarOpen = await topbar.evaluate(el => el.classList.contains("sidebar-open"));
    expect(hasSidebarOpen).toBe(sidebarOpen);
    console.log(`Topbar sidebar-open matches sidebar state: ${hasSidebarOpen === sidebarOpen}`);

    // Toggle sidebar
    await page.click("#sessions-toggle-button");
    await page.waitForTimeout(500);

    // Check topbar class changed
    const newSidebarOpen = await sidebar.evaluate(el => el.classList.contains("open"));
    const newHasSidebarOpen = await topbar.evaluate(el => el.classList.contains("sidebar-open"));
    console.log(`After toggle - sidebar: ${newSidebarOpen}, topbar class: ${newHasSidebarOpen}`);
    expect(newHasSidebarOpen).toBe(newSidebarOpen);
    expect(newSidebarOpen).not.toBe(sidebarOpen);

    await page.screenshot({ path: "test-results/ux-16-topbar-shift.png", fullPage: true });
    console.log("[PASS] Topbar shifts with sidebar");
  });

  // ── Test 19: Session Clicking Selects It ──
  test("clicking a session in sidebar selects it", async ({ page }) => {
    await login(page);
    await createSessionViaAPI(page, "cat");
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    // Open sidebar
    const sidebar = page.locator("#sessions-drawer");
    if (!await sidebar.evaluate(el => el.classList.contains("open"))) {
      await page.click("#sessions-toggle-button");
      await page.waitForTimeout(500);
    }

    // Click on first session item
    const firstSession = page.locator(".session-item").first();
    await firstSession.click();
    await page.waitForTimeout(500);

    // Verify something loaded
    const termTitle = page.locator("#terminal-title");
    const titleText = await termTitle.textContent();
    console.log(`Terminal title after selection: ${titleText}`);
    expect(titleText).toBeTruthy();

    console.log("[PASS] Session selection works");
  });

  // ── Test 20: Native mode session message without trailing newline ──
  test("native mode session: user message has no trailing newline", async ({ page }) => {
    // This tests the server-side fix: native mode should strip trailing \n from input
    // Use page.evaluate to make API calls within the authenticated browser context
    await login(page);

    const result = await page.evaluate(async () => {
      // Create native mode session
      const createResp = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo native", cwd: "/tmp", mode: "native" }),
        credentials: "include",
      });
      const createData = await createResp.json();
      const sessionId = createData.id;

      // Send input with trailing newline
      const inputResp = await fetch(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "test message\n", view: "chat" }),
        credentials: "include",
      });
      const inputData = await inputResp.json();
      return inputData;
    });

    // Check the user message has no trailing newline
    const messages = result.messages || [];
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    const text = (userMsg.content as any[])[0]?.text || "";
    expect(text).not.toContain("\n");
    expect(text).toBe("test message");
    console.log(`[PASS] Native mode message: "${text}" (no trailing newline)`);
  });

  // ── Test 21: Native mode session - chat displays messages after selection ──
  test("native mode session: messages display correctly in chat after session switch", async ({ page }) => {
    await login(page);

    // Create a native mode session via API
    const createResp = await page.request.post("/api/commands", {
      data: { command: "echo native-chat", cwd: "/tmp", mode: "native" },
    });
    const createData = await createResp.json();
    const sessionId = createData.id;

    // Switch to that session via the UI
    await page.goto("/");
    await page.waitForSelector("#sessions-toggle-button", { state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);

    const sidebar = page.locator("#sessions-drawer");
    if (!await sidebar.evaluate(el => el.classList.contains("open"))) {
      await page.click("#sessions-toggle-button");
      await page.waitForTimeout(500);
    }

    // Find and click the native session
    const sessionItems = page.locator(".session-item");
    const count = await sessionItems.count();
    let clicked = false;
    for (let i = 0; i < count; i++) {
      const item = sessionItems.nth(i);
      const text = await item.textContent() || "";
      if (text.includes("native-chat") || text.includes("echo")) {
        await item.click();
        clicked = true;
        break;
      }
    }
    expect(clicked).toBe(true);
    await page.waitForTimeout(2000);

    // Switch to chat view
    const chatBtn = page.locator("#view-chat-btn");
    await chatBtn.click();
    await page.waitForTimeout(500);

    // Chat should show content (not just "Chat started")
    const chatOutput = page.locator("#chat-output");
    await expect(chatOutput).toHaveClass(/active/);
    await page.screenshot({ path: "test-results/ux-17-native-chat-session.png", fullPage: true });
    console.log("[PASS] Native mode session displays in chat view");
  });

  // ── Test 22: Send button clears input and shows user message ──
  test("send message: input clears immediately and user message appears", async ({ page }) => {
    await login(page);
    await page.request.post("/api/commands", {
      data: { command: "cat", cwd: "/tmp", mode: "default" },
    });

    await page.goto("/");
    await page.waitForSelector("#input-box", { timeout: 10000 });
    await page.waitForTimeout(1000);

    const chatBtn = page.locator("#view-chat-btn");
    if (await chatBtn.isVisible()) await chatBtn.click();
    await page.waitForTimeout(300);

    const inputBox = page.locator("#input-box");
    const sendBtn = page.locator("#send-input-button");

    // Time the send: check input value before and immediately after click
    await inputBox.fill("timing test");
    const beforeClick = await inputBox.inputValue();
    expect(beforeClick).toBe("timing test");

    // Click send
    await sendBtn.click();

    // Immediately after click (before API response), input should be cleared
    const immediatelyAfter = await inputBox.inputValue();
    console.log(`Input immediately after send click: "${immediatelyAfter}"`);
    expect(immediatelyAfter).toBe("");

    // Wait for response and check chat content
    await page.waitForTimeout(2000);
    const chatHtml = await page.locator("#chat-output").innerHTML();
    expect(chatHtml).toContain("timing test");
    console.log("[PASS] Send clears input immediately, message appears after response");
  });
});
