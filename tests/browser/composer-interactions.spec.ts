import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

type ComposerSession = {
  id: string;
  title: string;
  sessionKind: "structured";
  sessionSource: "interactive";
  runner: string;
  provider: string;
  command: string;
  cwd: string;
  mode: string;
  status: "idle";
  exitCode: null;
  archived: false;
  startedAt: string;
  selectedModel?: string;
  thinkingEffort?: string;
  structuredState: { provider: string; runner: string; inFlight: false };
};

function composerSession(id: string, startedAt: string): ComposerSession {
  return {
    id,
    title: id,
    sessionKind: "structured",
    sessionSource: "interactive",
    runner: "codex-cli-exec",
    provider: "codex",
    command: "codex",
    cwd: "/tmp/wand-composer",
    mode: "full-access",
    status: "idle",
    exitCode: null,
    archived: false,
    startedAt,
    structuredState: {
      provider: "codex",
      runner: "codex-cli-exec",
      inFlight: false,
    },
  };
}

async function routeComposerSessions(page: Page, sessions: ComposerSession[]): Promise<void> {
  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(sessions),
  }));
  for (const session of sessions) {
    await page.route(new RegExp(`/api/sessions/${session.id}(?:\\?.*)?$`), (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...session,
        output: "",
        messages: [],
        messageOffset: 0,
        messageTotal: 0,
      }),
    }));
  }
}

async function switchSession(page: Page, sessionId: string): Promise<void> {
  await page.locator(`.session-item[data-session-id="${sessionId}"]`).evaluate((element) => {
    (element as HTMLElement).click();
  });
}

test("composer drafts and attachments stay isolated across session switches", async ({ page }) => {
  const sessionA = composerSession("composer-session-a", "2026-07-24T02:00:00.000Z");
  const sessionB = composerSession("composer-session-b", "2026-07-24T01:00:00.000Z");
  await routeComposerSessions(page, [sessionA, sessionB]);
  await login(page);

  const input = page.locator("#input-box");
  const fileInput = page.locator("#file-upload-input");
  const attachments = page.locator("#attachment-preview");

  await input.fill("draft for A");
  await fileInput.setInputFiles({
    name: "a.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A"),
  });
  await expect(attachments).toContainText("a.txt");

  await switchSession(page, sessionB.id);
  await expect(input).toHaveValue("");
  await expect(attachments).toHaveClass(/\bhidden\b/);

  await input.fill("draft for B");
  await fileInput.setInputFiles({
    name: "b.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("B"),
  });
  await expect(attachments).toContainText("b.txt");
  await expect(attachments).not.toContainText("a.txt");

  await switchSession(page, sessionA.id);
  await expect(input).toHaveValue("draft for A");
  await expect(attachments).toContainText("a.txt");
  await expect(attachments).not.toContainText("b.txt");

  await switchSession(page, sessionB.id);
  await expect(input).toHaveValue("draft for B");
  await expect(attachments).toContainText("b.txt");
});

test("composer sendability and selection replacements share one state path", async ({ page }) => {
  const session = composerSession("composer-selection", "2026-07-24T03:00:00.000Z");
  await routeComposerSessions(page, [session]);
  await login(page);

  const input = page.locator("#input-box");
  const send = page.locator("#send-input-button");
  const fileInput = page.locator("#file-upload-input");

  await expect(send).toBeDisabled();
  await input.fill("   ");
  await expect(send).toBeDisabled();

  const pasteState = await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.value = "abcdef";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    textarea.setSelectionRange(2, 4);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [],
        getData(type: string) {
          return type === "text" ? "XY" : "";
        },
      },
    });
    textarea.dispatchEvent(paste);
    return {
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      height: textarea.style.height,
      minHeight: getComputedStyle(textarea).minHeight,
      hasText: !!textarea.closest(".input-composer")?.classList.contains("has-text"),
    };
  });
  expect(pasteState.height).toBe(pasteState.minHeight);
  expect(pasteState).toMatchObject({
    value: "abXYef",
    selectionStart: 4,
    selectionEnd: 4,
    hasText: true,
  });
  await expect(send).toBeEnabled();

  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(1, 4));
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("a\nef");
  expect(await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return [textarea.selectionStart, textarea.selectionEnd];
  })).toEqual([2, 2]);

  const attach = page.locator("#attach-btn");
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(1, 2));
  await input.press("Tab");
  await expect(input).toHaveValue("a\nef");
  await expect(attach).toBeFocused();

  await input.fill("");
  await expect(send).toBeDisabled();
  await fileInput.setInputFiles({
    name: "attachment-only.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment"),
  });
  await expect(send).toBeEnabled();
});

test("IME confirmation Enter never submits the composer in WebKit event orderings", async ({ page }) => {
  const session = composerSession("composer-ime-enter", "2026-07-24T03:15:00.000Z");
  await routeComposerSessions(page, [session]);

  let messageCount = 0;
  await page.route(`**/api/structured-sessions/${session.id}/messages`, async (route) => {
    messageCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await login(page);

  const input = page.locator("#input-box");
  await input.fill("正在输入拼音");

  // Chromium-style ordering: keydown still advertises active composition.
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "pinyin",
    }));
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: true,
    }));
  });

  // Safari/WKWebView can emit compositionend first, followed in the same task
  // by an Enter whose isComposing is already false.
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "拼音",
    }));
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: false,
    }));
  });

  await page.waitForTimeout(20);
  expect(messageCount).toBe(0);
  await expect(input).toHaveValue("正在输入拼音");

  // Older WebKit exposes the IME sentinel keyCode even when isComposing=false.
  await input.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: false,
    });
    Object.defineProperty(event, "keyCode", { value: 229 });
    element.dispatchEvent(event);
  });
  await page.waitForTimeout(20);
  expect(messageCount).toBe(0);
  await expect(input).toHaveValue("正在输入拼音");

  // A new composition cycle can begin before the previous settle timer runs.
  // The old timer must not clear the guard belonging to the new cycle.
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "n" }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "h" }));
  });
  await page.waitForTimeout(20);
  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: false,
    }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "好" }));
  });
  await page.waitForTimeout(20);
  expect(messageCount).toBe(0);
  await expect(input).toHaveValue("正在输入拼音");

  // Once composition has settled, a normal Return retains the send shortcut.
  await input.press("Enter");
  await expect.poll(() => messageCount).toBe(1);
  await expect(input).toHaveValue("");
});

test("IME confirmation is suppressed before terminal-interactive capture", async ({ page }) => {
  const session = {
    id: "composer-ime-pty-capture",
    title: "PTY IME capture",
    sessionKind: "pty",
    sessionSource: "interactive",
    runner: "pty",
    provider: "codex",
    command: "codex",
    cwd: "/tmp/wand-composer",
    mode: "full-access",
    status: "running",
    exitCode: null,
    archived: false,
    startedAt: "2026-07-24T03:20:00.000Z",
    output: "",
    messages: [],
    messageOffset: 0,
    messageTotal: 0,
  };
  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([session]),
  }));

  const sentInputs: string[] = [];
  await page.route(new RegExp(`/api/sessions/${session.id}(?:\\?.*)?$`), async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });
  await page.route(`**/api/sessions/${session.id}/input`, async (route) => {
    sentInputs.push(route.request().postDataJSON().input);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await login(page);
  await switchSession(page, session.id);

  await page.locator("#attach-btn").click();
  const interactiveToggle = page.locator("#terminal-interactive-toggle-top");
  await expect(interactiveToggle).toBeVisible();
  await interactiveToggle.click();
  await expect(interactiveToggle).toHaveAttribute("aria-pressed", "true");

  const input = page.locator("#input-box");
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", {
      bubbles: true,
      data: "pinyin",
    }));
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: false,
    }));
    element.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "拼音",
    }));
    // Safari/WebKit may commit the final value after compositionend.
    (element as HTMLTextAreaElement).value = "拼音";
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: "拼音",
      inputType: "insertCompositionText",
    }));
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: false,
    }));
  });
  await page.waitForTimeout(20);

  await input.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      isComposing: false,
    });
    Object.defineProperty(event, "keyCode", { value: 229 });
    element.dispatchEvent(event);
  });
  await page.waitForTimeout(20);
  expect(sentInputs).toEqual(["拼音"]);

  // Prove terminal capture is actually active rather than the test passing
  // because the listener was never installed.
  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "x",
    }));
  });
  await expect.poll(() => sentInputs).toEqual(["拼音", "x"]);
});

test("composer more menu follows keyboard focus and returns it on close", async ({ page }) => {
  const session = composerSession("composer-more-menu", "2026-07-24T03:30:00.000Z");
  await routeComposerSessions(page, [session]);
  await login(page);

  const trigger = page.locator("#attach-btn");
  const popover = page.locator("#composer-plus-popover");
  const upload = page.locator("#plus-attach-item");
  const mode = popover.getByRole("combobox", { name: "模式" });

  await trigger.focus();
  await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveAttribute("aria-controls", "composer-plus-popover");
  await expect(popover).toHaveAttribute("aria-hidden", "false");
  await expect(upload).toBeFocused();

  await mode.focus();
  await expect(mode).toBeFocused();
  await mode.press("ArrowDown");
  await expect(page.getByRole("option", { name: "默认" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(popover).toHaveAttribute("aria-hidden", "false");
  await expect(mode).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(popover).toHaveAttribute("aria-hidden", "true");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});

test("component selects normalize default model and unsupported thinking before syncing mutations", async ({ page }) => {
  const session = {
    ...composerSession("composer-select-normalization", "2026-07-24T03:40:00.000Z"),
    selectedModel: "default",
    thinkingEffort: "max",
  };
  await routeComposerSessions(page, [session]);
  await page.route(/\/api\/models(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      models: [],
      codexModels: [
        {
          id: "default",
          label: "Default Codex",
          reasoningEfforts: [{ effort: "low", description: "Fast" }],
          defaultReasoningEffort: "low",
        },
        {
          id: "gpt-test",
          label: "GPT Test",
          reasoningEfforts: [{ effort: "low", description: "Fast" }],
          defaultReasoningEffort: "low",
        },
      ],
      opencodeModels: [],
      grokModels: [],
      qoderModels: [],
      defaultModel: "default",
    }),
  }));

  const modelBodies: Array<{ model?: string | null }> = [];
  const thinkingBodies: Array<{ thinkingEffort?: string }> = [];
  await page.route(new RegExp(`/api/sessions/${session.id}/model$`), async (route) => {
    const body = route.request().postDataJSON() as { model?: string | null };
    modelBodies.push(body);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...session,
        selectedModel: body.model || "default",
        thinkingEffort: "standard",
      }),
    });
  });
  await page.route(new RegExp(`/api/sessions/${session.id}/thinking-effort$`), async (route) => {
    const body = route.request().postDataJSON() as { thinkingEffort?: string };
    thinkingBodies.push(body);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...session,
        selectedModel: "default",
        thinkingEffort: body.thinkingEffort || "off",
      }),
    });
  });
  await login(page);

  const runtime = page.locator(".composer-inline-config");
  const model = runtime.getByRole("combobox", { name: "模型" });
  const thinking = runtime.getByRole("combobox", { name: "思考深度" });

  await model.click();
  const defaultModel = page.getByRole("option", { name: /默认 · Default Codex/ });
  await expect(defaultModel).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");

  await thinking.click();
  const automaticThinking = page.getByRole("option", { name: "自动（模型默认）" });
  await expect(automaticThinking).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");

  await thinking.click();
  await page.getByRole("option", { name: "低" }).click();
  await expect.poll(() => thinkingBodies).toEqual([{ thinkingEffort: "standard" }]);

  await model.click();
  await page.getByRole("option", { name: "GPT Test" }).click();
  await expect.poll(() => modelBodies).toEqual([{ model: "gpt-test" }]);

  await model.click();
  await expect(page.getByRole("option", { name: "GPT Test" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await thinking.click();
  await expect(page.getByRole("option", { name: "低" })).toHaveAttribute("aria-selected", "true");
});

test("prompt optimizer stays in the action rail and replaces the draft atomically", async ({ page }) => {
  const session = composerSession("composer-prompt-optimizer", "2026-07-24T03:45:00.000Z");
  await routeComposerSessions(page, [session]);

  let requestPayload: { text?: string; sessionId?: string } | null = null;
  let messageCount = 0;
  let markOptimizeStarted!: () => void;
  let releaseOptimize!: () => void;
  const optimizeStarted = new Promise<void>((resolve) => { markOptimizeStarted = resolve; });
  const optimizeGate = new Promise<void>((resolve) => { releaseOptimize = resolve; });
  await page.route("**/api/optimize-prompt", async (route) => {
    requestPayload = route.request().postDataJSON();
    markOptimizeStarted();
    await optimizeGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ optimized: "Use an atomic, testable implementation." }),
    });
  });
  await page.route(`**/api/structured-sessions/${session.id}/messages`, async (route) => {
    messageCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await login(page);

  const input = page.locator("#input-box");
  const optimize = page.locator("#prompt-optimize-btn");
  const send = page.locator("#send-input-button");

  await expect(optimize).toBeHidden();
  expect(await optimize.evaluate((element) => element.parentElement?.classList.contains("composer-actions-right"))).toBe(true);
  expect(await page.locator("#composer-plus-popover #prompt-optimize-btn").count()).toBe(0);

  await input.fill("   ");
  await expect(optimize).toBeHidden();
  await input.fill("rough prompt");
  await expect(optimize).toBeVisible();
  await expect(optimize).toHaveAttribute("aria-label", "优化提示词");

  await input.focus();
  await optimize.click();
  await optimizeStarted;

  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("readOnly", true);
  await expect(input).toHaveValue("rough prompt");
  await expect(optimize).toBeDisabled();
  await expect(optimize).toHaveAttribute("aria-busy", "true");
  await expect(send).toBeDisabled();

  await input.press("Tab");
  await input.evaluate((element) => {
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [],
        getData(type: string) {
          return type === "text" ? "must not be inserted" : "";
        },
      },
    });
    element.dispatchEvent(paste);
  });
  await expect(input).toHaveValue("rough prompt");

  await input.press("Enter");
  await page.waitForTimeout(50);
  expect(messageCount).toBe(0);
  await expect(input).toHaveValue("rough prompt");

  releaseOptimize();
  await expect(input).toHaveValue("Use an atomic, testable implementation.");
  await expect(input).toHaveJSProperty("readOnly", false);
  await expect(optimize).toBeEnabled();
  await expect(optimize).toHaveAttribute("aria-busy", "false");
  await expect(input).toBeFocused();
  expect(requestPayload).toEqual({ text: "rough prompt", sessionId: session.id });
});

test("prompt optimization writes back only to its owning session after a switch", async ({ page }) => {
  const sessionA = composerSession("composer-prompt-owner-a", "2026-07-24T03:49:00.000Z");
  const sessionB = composerSession("composer-prompt-owner-b", "2026-07-24T03:48:00.000Z");
  await routeComposerSessions(page, [sessionA, sessionB]);

  let markOptimizeStarted!: () => void;
  let releaseOptimize!: () => void;
  const optimizeStarted = new Promise<void>((resolve) => { markOptimizeStarted = resolve; });
  const optimizeGate = new Promise<void>((resolve) => { releaseOptimize = resolve; });
  await page.route("**/api/optimize-prompt", async (route) => {
    markOptimizeStarted();
    await optimizeGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ optimized: "optimized draft for A" }),
    });
  });
  await login(page);

  const input = page.locator("#input-box");
  await input.fill("raw draft for A");
  await page.locator("#prompt-optimize-btn").click();
  await optimizeStarted;

  await switchSession(page, sessionB.id);
  await expect(input).toHaveJSProperty("readOnly", false);
  await input.fill("untouched draft for B");
  releaseOptimize();
  await expect(input).toHaveValue("untouched draft for B");

  await switchSession(page, sessionA.id);
  await expect(input).toHaveValue("optimized draft for A");
});

test("prompt optimizer preserves the draft and recovers after a non-JSON error", async ({ page }) => {
  const session = composerSession("composer-prompt-error", "2026-07-24T03:50:00.000Z");
  await routeComposerSessions(page, [session]);
  await page.route("**/api/optimize-prompt", (route) => route.fulfill({
    status: 502,
    contentType: "text/html",
    body: "<h1>Bad gateway</h1>",
  }));
  await login(page);

  const input = page.locator("#input-box");
  const optimize = page.locator("#prompt-optimize-btn");
  await input.fill("keep this draft");
  await optimize.focus();
  await optimize.press("Enter");

  await expect(input).toHaveValue("keep this draft");
  await expect(input).toHaveJSProperty("readOnly", false);
  await expect(optimize).toBeEnabled();
  await expect(optimize).toHaveAttribute("aria-busy", "false");
  await expect(input).toBeFocused();
  await expect(page.getByText("提示词优化失败（HTTP 502）。", { exact: true })).toBeVisible();
});

test("duplicate submission is guarded and a failed send restores draft and attachments", async ({ page }) => {
  const session = composerSession("composer-failure", "2026-07-24T04:00:00.000Z");
  await routeComposerSessions(page, [session]);

  let uploadCount = 0;
  let messageCount = 0;
  await page.route(`**/api/sessions/${session.id}/upload`, async (route) => {
    uploadCount += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ files: [{ savedPath: "/tmp/failure.txt" }] }),
    });
  });
  await page.route(`**/api/structured-sessions/${session.id}/messages`, async (route) => {
    messageCount += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "fixture send failed" }),
    });
  });
  await login(page);

  const input = page.locator("#input-box");
  const fileInput = page.locator("#file-upload-input");
  const attachments = page.locator("#attachment-preview");
  await input.fill("must be restored");
  await fileInput.setInputFiles({
    name: "failure.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("failure"),
  });

  await page.locator("#send-input-button").evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });

  await expect.poll(() => messageCount).toBe(1);
  expect(uploadCount).toBe(1);
  await expect(input).toHaveValue("must be restored");
  await expect(attachments).toContainText("failure.txt");
  await expect(attachments.getByRole("button", { name: "移除附件 failure.txt" })).toBeVisible();
  await expect(page.locator("#send-input-button")).toBeEnabled();
});

test("touch submit keeps the composer focused", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "touch focus is only meaningful in mobile projects");
  const session = composerSession("composer-touch-focus", "2026-07-24T05:00:00.000Z");
  await routeComposerSessions(page, [session]);
  await page.route(`**/api/structured-sessions/${session.id}/messages`, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...session,
      messages: [{ role: "user", content: [{ type: "text", text: "keep focus" }] }],
    }),
  }));
  await login(page);

  const input = page.locator("#input-box");
  await input.fill("keep focus");
  await input.focus();
  await page.locator("#send-input-button").tap();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
});
