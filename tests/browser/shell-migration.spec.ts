import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("React shell keeps all legacy host roots, draft, and selection stable", async ({ page }) => {
  await login(page);
  await expect(page.locator("#app")).toHaveAttribute("data-react-shell", "enabled");
  await expect(page.locator("#sidebar-refresh-btn")).toBeAttached();

  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>("#input-box");
    const queueHost = document.querySelector<HTMLElement>("#cross-session-queue-host");
    if (!input) throw new Error("missing legacy composer input");
    if (!queueHost) throw new Error("missing cross-session queue host");
    const queueChild = document.createElement("div");
    queueChild.dataset.testid = "legacy-queue-child";
    queueHost.append(queueChild);
    input.value = "保留 draft selection";
    input.setSelectionRange(3, 9);
    (window as Window & { __shellIdentity?: unknown }).__shellIdentity = {
      output: document.querySelector("#output"),
      chat: document.querySelector("#chat-output"),
      composer: document.querySelector(".input-panel"),
      explorer: document.querySelector("#file-explorer"),
      queueHost,
      queueChild,
      input,
    };
  });

  await page.locator("#topbar-file-button").click();
  await expect(page.locator("#file-side-panel")).toHaveClass(/open/);
  await page.locator("#file-explorer-refresh").click();
  await expect(page.locator(".tree-item[data-type='file']").first()).toBeVisible();
  await page.locator("#file-side-panel-close").click();
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#sessions-toggle-button")?.click();
  });

  const identity = await page.evaluate(() => {
    const remembered = (window as Window & {
      __shellIdentity?: Record<string, Element>;
    }).__shellIdentity;
    const input = document.querySelector<HTMLTextAreaElement>("#input-box");
    return {
      output: remembered?.output === document.querySelector("#output"),
      chat: remembered?.chat === document.querySelector("#chat-output"),
      composer: remembered?.composer === document.querySelector(".input-panel"),
      explorer: remembered?.explorer === document.querySelector("#file-explorer"),
      queueHost: remembered?.queueHost === document.querySelector("#cross-session-queue-host"),
      queueChild: remembered?.queueChild === document.querySelector("[data-testid='legacy-queue-child']"),
      input: remembered?.input === input,
      value: input?.value,
      selectionStart: input?.selectionStart,
      selectionEnd: input?.selectionEnd,
    };
  });
  expect(identity).toEqual({
    output: true,
    chat: true,
    composer: true,
    explorer: true,
    queueHost: true,
    queueChild: true,
    input: true,
    value: "保留 draft selection",
    selectionStart: 3,
    selectionEnd: 9,
  });
});

test("sidebar overflow dismisses on outside pointer and Escape", async ({ page }) => {
  await login(page);
  const trigger = page.locator("#sidebar-more-btn");
  const intersectsViewport = () => trigger.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.top < window.innerHeight;
  });
  const revealTrigger = async () => {
    if (!await intersectsViewport()) await page.locator("#sessions-toggle-button").click();
    await expect.poll(intersectsViewport).toBe(true);
  };
  await revealTrigger();

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#sidebar-overflow-menu")).toBeVisible();
  await page.locator(".sidebar-title").click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await revealTrigger();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("sidebar history expansion persists across publishes and reload", async ({ page }) => {
  await page.route("**/api/claude-history", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      claudeSessionId: "history-expansion-smoke",
      projectDir: "-tmp-wand-history",
      cwd: "/tmp/wand-history",
      firstUserMessage: "History expansion smoke",
      timestamp: "2026-07-16T00:00:00.000Z",
      mtimeMs: new Date("2026-07-16T00:00:00.000Z").getTime(),
      hasConversation: true,
      managedByWand: false,
    }]),
  }));
  await page.route("**/api/codex-history", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await login(page);

  const details = page.locator("details.non-wand-session-group");
  const summary = details.locator("summary");
  await expect(details).toBeAttached();
  const sessionsToggle = page.locator("#sessions-toggle-button");
  if (await sessionsToggle.isVisible()) await sessionsToggle.click();
  await expect(summary).toBeInViewport();
  if (await details.getAttribute("open") !== null) {
    await summary.click();
  }
  await expect(details).not.toHaveAttribute("open", "");

  await summary.click();
  await expect(details).toHaveAttribute("open", "");
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem("wand-non-wand-sessions-expanded")
  ))).toBe("true");

  const drawerBackdrop = page.locator("#sessions-drawer-backdrop");
  if (await drawerBackdrop.evaluate((element) => element.classList.contains("open"))) {
    await page.locator("#close-drawer-button").click();
    await expect(drawerBackdrop).not.toHaveClass(/\bopen\b/);
  }
  await page.locator("#topbar-file-button").click();
  await expect(details).toHaveAttribute("open", "");

  await page.reload();
  await expect(page.locator("#settings-button")).toBeAttached();
  await expect(page.locator("details.non-wand-session-group")).toHaveAttribute("open", "");
});

test("React shell preserves the composer through an active IME composition", async ({ page }) => {
  await login(page);

  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>("#input-box");
    if (!input) throw new Error("missing legacy composer input");
    const browserWindow = window as Window & {
      __shellComposition?: { input: HTMLTextAreaElement; events: string[] };
    };
    const events: string[] = [];
    input.addEventListener("compositionstart", () => events.push("start"));
    input.addEventListener("compositionend", () => events.push("end"));
    input.value = "正在拼写 pinyin";
    input.setSelectionRange(5, 11);
    browserWindow.__shellComposition = { input, events };
    input.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "pinyin",
    }));
    document.querySelector<HTMLButtonElement>("#topbar-file-button")?.click();
  });

  await expect(page.locator("#file-side-panel")).toHaveClass(/open/);
  const duringComposition = await page.evaluate(() => {
    const remembered = (window as Window & {
      __shellComposition?: { input: HTMLTextAreaElement; events: string[] };
    }).__shellComposition;
    const input = document.querySelector<HTMLTextAreaElement>("#input-box");
    return {
      sameInput: remembered?.input === input,
      value: input?.value,
      selectionStart: input?.selectionStart,
      selectionEnd: input?.selectionEnd,
      events: remembered?.events.slice(),
    };
  });
  expect(duringComposition).toEqual({
    sameInput: true,
    value: "正在拼写 pinyin",
    selectionStart: 5,
    selectionEnd: 11,
    events: ["start"],
  });

  const afterComposition = await page.evaluate(() => {
    const remembered = (window as Window & {
      __shellComposition?: { input: HTMLTextAreaElement; events: string[] };
    }).__shellComposition;
    const input = document.querySelector<HTMLTextAreaElement>("#input-box");
    input?.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "拼音",
    }));
    return {
      sameInput: remembered?.input === input,
      value: input?.value,
      selectionStart: input?.selectionStart,
      selectionEnd: input?.selectionEnd,
      events: remembered?.events.slice(),
    };
  });
  expect(afterComposition).toEqual({
    sameInput: true,
    value: "正在拼写 pinyin",
    selectionStart: 5,
    selectionEnd: 11,
    events: ["start", "end"],
  });
});

test("React shell preserves legacy chat children and scroll position", async ({ page }) => {
  await login(page);

  await page.evaluate(() => {
    const chat = document.querySelector<HTMLElement>("#chat-output");
    if (!chat) throw new Error("missing legacy chat output");
    chat.classList.remove("hidden");
    chat.classList.add("active");
    chat.style.display = "block";
    chat.style.height = "80px";
    chat.style.minHeight = "80px";
    chat.style.maxHeight = "80px";
    chat.style.flex = "none";
    chat.style.overflow = "auto";
    const legacyContent = document.createElement("div");
    legacyContent.dataset.testid = "legacy-chat-scroll-content";
    legacyContent.style.height = "1200px";
    legacyContent.style.minHeight = "1200px";
    legacyContent.style.flex = "none";
    legacyContent.textContent = "legacy chat content";
    chat.append(legacyContent);
    chat.scrollTop = 420;
    (window as Window & {
      __shellChatScroll?: { chat: HTMLElement; child: HTMLElement };
    }).__shellChatScroll = { chat, child: legacyContent };
    document.querySelector<HTMLButtonElement>("#topbar-file-button")?.click();
  });

  await expect(page.locator("#file-side-panel")).toHaveClass(/open/);
  const result = await page.evaluate(() => {
    const remembered = (window as Window & {
      __shellChatScroll?: { chat: HTMLElement; child: HTMLElement };
    }).__shellChatScroll;
    const chat = document.querySelector<HTMLElement>("#chat-output");
    return {
      sameChat: remembered?.chat === chat,
      sameChild: remembered?.child === chat?.querySelector("[data-testid='legacy-chat-scroll-content']"),
      scrollTop: chat?.scrollTop,
    };
  });
  expect(result).toEqual({ sameChat: true, sameChild: true, scrollTop: 420 });
});

test("working-directory trigger opens one React dialog without a legacy dropdown", async ({ page }) => {
  await login(page);
  await page.locator("#blank-chat-cwd").click();
  await expect(page.getByRole("heading", { name: "选择工作目录" })).toBeVisible();
  await expect(page.getByTestId("folder-picker-dialog")).toHaveCount(1);
  await expect(page.locator("#blank-chat-cwd-dropdown")).toHaveCount(0);
});

test("reactShell rollback keeps the legacy shell and React overlays", async ({ page }) => {
  await page.goto("/?reactShell=0");
  await page.locator("#password").fill("change-me");
  await page.locator("#login-button").click();
  await expect(page.locator("#topbar-file-button")).toBeVisible();
  await expect(page.locator("#app")).not.toHaveAttribute("data-react-shell", "enabled");
  await expect(page.locator("#overlay-root")).toHaveAttribute("data-react-ui", "enabled");
  await expect(page.locator("#output")).toBeAttached();
});
