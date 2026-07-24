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
      hasText: !!textarea.closest(".input-composer")?.classList.contains("has-text"),
    };
  });
  expect(pasteState).toEqual({
    value: "abXYef",
    selectionStart: 4,
    selectionEnd: 4,
    height: "36px",
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

  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(1, 2));
  await input.press("Tab");
  await expect(input).toHaveValue("a\tef");
  expect(await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return [textarea.selectionStart, textarea.selectionEnd];
  })).toEqual([2, 2]);

  await input.fill("");
  await expect(send).toBeDisabled();
  await fileInput.setInputFiles({
    name: "attachment-only.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment"),
  });
  await expect(send).toBeEnabled();
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
