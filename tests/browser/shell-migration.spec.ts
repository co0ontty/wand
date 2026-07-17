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

test("structured session switches never reveal or restore stale PTY chat", async ({ page }) => {
  const structuredId = "structured-switch-fixture";
  const ptyId = "pty-switch-fixture";
  const baseSession = {
    sessionSource: "interactive",
    provider: "codex",
    command: "codex",
    cwd: "/tmp/wand-session-switch",
    mode: "full-access",
    status: "idle",
    exitCode: null,
    archived: false,
  };
  const structuredSession = {
    ...baseSession,
    id: structuredId,
    sessionKind: "structured",
    runner: "codex-cli-exec",
    startedAt: "2026-07-17T01:00:00.000Z",
    title: "Structured switch fixture",
    structuredState: { provider: "codex", runner: "codex-cli-exec", inFlight: false },
  };
  const ptySession = {
    ...baseSession,
    id: ptyId,
    sessionKind: "pty",
    runner: "pty",
    startedAt: "2026-07-17T00:00:00.000Z",
    title: "PTY switch fixture",
  };
  const structuredMessages = [{
    role: "assistant",
    content: [{ type: "text", text: "STRUCTURED_CURRENT" }],
  }];
  const ptyMessages = [{
    role: "assistant",
    content: [{ type: "text", text: "PTY_STALE" }],
  }];

  let ptyRequestCount = 0;
  let ptyResponseCount = 0;
  let ptyGate: Promise<void> | null = null;
  let releasePty: (() => void) | null = null;
  let structuredGate: Promise<void> | null = null;
  let releaseStructured: (() => void) | null = null;

  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([structuredSession, ptySession]),
  }));
  await page.route(new RegExp(`/api/sessions/${structuredId}(?:\\?.*)?$`), async (route) => {
    const gate = structuredGate;
    structuredGate = null;
    if (gate) await gate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...structuredSession,
        output: "",
        messages: structuredMessages,
        messageOffset: 0,
        messageTotal: structuredMessages.length,
      }),
    });
  });
  await page.route(new RegExp(`/api/sessions/${ptyId}(?:\\?.*)?$`), async (route) => {
    ptyRequestCount += 1;
    const gate = ptyGate;
    ptyGate = null;
    if (gate) await gate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...ptySession,
        output: "",
        messages: ptyMessages,
        messageOffset: 0,
        messageTotal: ptyMessages.length,
      }),
    });
    ptyResponseCount += 1;
  });

  await login(page);
  const chat = page.locator("#chat-output");
  const structuredEntry = page.locator(`.session-item[data-session-id="${structuredId}"]`);
  const ptyEntry = page.locator(`.session-item[data-session-id="${ptyId}"]`);
  const drawer = page.locator("#sessions-drawer");
  const sessionsToggle = page.locator("#sessions-toggle-button");
  const overlayLayout = await page.evaluate(() => window.innerWidth <= 768);
  const activateSession = async (entry: typeof structuredEntry) => {
    const intersectsViewport = () => entry.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < window.innerWidth
        && rect.top < window.innerHeight;
    });
    if (overlayLayout) {
      const open = await drawer.evaluate((element) => element.classList.contains("open"));
      if (!open) await sessionsToggle.click();
      await expect(drawer).toHaveClass(/\bopen\b/);
    } else if (!await intersectsViewport()) {
      await sessionsToggle.click();
    }
    await expect.poll(intersectsViewport).toBe(true);
    await entry.click();
  };
  await expect(chat).toContainText("STRUCTURED_CURRENT");

  // First populate the hidden chat host with PTY content, then hold the
  // structured response. The switch itself must synchronously remove PTY_STALE.
  await activateSession(ptyEntry);
  await expect.poll(() => ptyResponseCount).toBe(1);
  await expect(chat).toContainText("PTY_STALE");
  structuredGate = new Promise<void>((resolve) => { releaseStructured = resolve; });
  await activateSession(structuredEntry);
  await expect(chat).not.toHaveClass(/\bhidden\b/);
  await expect(chat).not.toContainText("PTY_STALE");
  releaseStructured?.();
  await expect(chat).toContainText("STRUCTURED_CURRENT");

  // Now let an older PTY request finish after the structured request. Its
  // response must not overwrite the active session's shared message buffer.
  ptyGate = new Promise<void>((resolve) => { releasePty = resolve; });
  await activateSession(ptyEntry);
  await expect.poll(() => ptyRequestCount).toBe(2);
  await activateSession(structuredEntry);
  await expect(chat).toContainText("STRUCTURED_CURRENT");
  releasePty?.();
  await expect.poll(() => ptyResponseCount).toBe(2);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(chat).toContainText("STRUCTURED_CURRENT");
  await expect(chat).not.toContainText("PTY_STALE");
});

test("voice input uses its own hold button without hijacking textarea gestures", async ({ page }) => {
  await login(page);

  const input = page.locator("#input-box");
  const voiceButton = page.locator("#voice-record-btn");
  const transcript = page.locator("#voice-transcript-bubble");

  await expect(voiceButton).toBeAttached();
  await expect(voiceButton).toHaveClass(/btn-circle-voice/);
  expect(await voiceButton.evaluate((element) => ({
    insideComposer: !!element.closest(".input-composer"),
    insideComposerRow: !!element.closest(".input-composer-row"),
    beforeSend: element.nextElementSibling?.id === "send-input-button",
  }))).toEqual({ insideComposer: true, insideComposerRow: true, beforeSend: true });
  const hitArea = await voiceButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
  });
  expect(hitArea.width).toBeGreaterThanOrEqual(44);
  expect(hitArea.height).toBeGreaterThanOrEqual(44);

  await input.dispatchEvent("pointerdown", { pointerId: 11, clientY: 240 });
  await page.waitForTimeout(220);
  await expect(transcript).toHaveClass(/hidden/);
  await expect(voiceButton).toHaveAttribute("aria-pressed", "false");

  await voiceButton.dispatchEvent("pointerdown", { pointerId: 12, clientY: 240 });
  await expect(transcript).not.toHaveClass(/hidden/);
  await expect(voiceButton).toHaveAttribute("aria-pressed", "true");
  await voiceButton.dispatchEvent("pointerup", { pointerId: 12, clientY: 240 });
  await expect(transcript).toHaveClass(/hidden/);
  await expect(voiceButton).toHaveAttribute("aria-pressed", "false");
});

test("a wrapped draft stays expanded after the mobile keyboard closes", async ({ page }) => {
  await login(page);

  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>("#input-box");
    if (!input) throw new Error("missing input box");
    document.body.append(input);
    Object.assign(input.style, {
      display: "block",
      position: "fixed",
      left: "0",
      bottom: "0",
      width: "320px",
      visibility: "visible",
      opacity: "1",
      zIndex: "9999",
    });
  });

  const input = page.locator("#input-box");
  await input.fill("第一行草稿需要完整显示\n第二行不能在键盘收起后消失\n第三行也必须保留可见");
  await input.focus();
  await input.evaluate((element) => element.blur());
  await page.waitForTimeout(700);

  const expanded = await input.evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    multiline: element.classList.contains("has-multiline-draft"),
    clipped: element.classList.contains("has-clipped-draft"),
  }));
  expect(expanded.multiline).toBe(true);
  expect(expanded.clipped).toBe(false);
  expect(expanded.height).toBeGreaterThan(36);
  expect(expanded.height).toBeGreaterThanOrEqual(expanded.scrollHeight - 1);
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
