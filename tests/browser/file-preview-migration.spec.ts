import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const textPath = "/tmp/wand-file-preview-smoke.ts";
const markdownPath = "/tmp/wand-file-preview-smoke.md";

const previewFixtures: Record<string, Record<string, unknown>> = {
  [textPath]: {
    kind: "text",
    path: textPath,
    name: "wand-file-preview-smoke.ts",
    ext: ".ts",
    size: 48,
    mime: "text/typescript",
    lang: "typescript",
    content: "const answer = 42;\nconsole.log(answer);",
  },
  [markdownPath]: {
    kind: "text",
    path: markdownPath,
    name: "wand-file-preview-smoke.md",
    ext: ".md",
    size: 72,
    mime: "text/markdown",
    lang: "markdown",
    content: "# Migration Preview\n\nMarkdown **rendered** safely.\n\n```ts\nconst ready = true;\n```",
  },
};

interface SavedWrite {
  path: string;
  content: string;
}

async function installFilePreviewFixtures(page: Page, writes: SavedWrite[]): Promise<void> {
  await page.route("**/api/file-preview?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    const fixture = previewFixtures[path];
    if (!fixture) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: `Missing preview fixture: ${path}` }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });
  });

  await page.route("**/api/file-write", async (route) => {
    const body = route.request().postDataJSON() as SavedWrite;
    writes.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: body.path,
        size: new TextEncoder().encode(body.content).byteLength,
        mtime: "2026-07-16T00:00:00.000Z",
      }),
    });
  });
}

test("React File Preview supports navigation, Markdown, editing, discard, focus, and responsive bounds", async ({ page }) => {
  const writes: SavedWrite[] = [];
  await installFilePreviewFixtures(page, writes);
  await login(page);

  const focusAnchor = page.locator("#topbar-file-button");
  await focusAnchor.focus();
  await expect(focusAnchor).toBeFocused();

  const opened = await page.evaluate(async ({ path, siblings }) => {
    const controller = (window as Window & {
      __wandReactFilePreview?: {
        open(request: unknown): Promise<boolean>;
      };
    }).__wandReactFilePreview;
    if (!controller) throw new Error("React File Preview controller is not exposed");
    return controller.open({ path, siblings });
  }, {
    path: textPath,
    siblings: [
      { path: textPath, name: "wand-file-preview-smoke.ts", type: "file" },
      { path: markdownPath, name: "wand-file-preview-smoke.md", type: "file" },
    ],
  });
  expect(opened).toBe(true);

  const dialog = page.getByTestId("file-preview-dialog");
  const shell = dialog.locator(".wand-file-preview-shell");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "wand-file-preview-smoke.ts" })).toBeVisible();
  await expect(dialog.locator(".wand-file-preview-code-content")).toContainText("const answer = 42;");
  expect(await dialog.locator(".wand-file-preview-lines").textContent()).toBe("1\n2");
  await expect(page.locator(".file-preview-overlay")).toHaveCount(0);
  await expect(shell).toBeFocused();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.top).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(viewport!.width + 1);
  expect(bounds.bottom).toBeLessThanOrEqual(viewport!.height + 1);
  if (viewport!.width <= 420) {
    expect(bounds.width).toBeLessThan(viewport!.width);
    expect(bounds.height).toBeLessThan(viewport!.height);
  }

  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("heading", { name: "wand-file-preview-smoke.md" })).toBeVisible();
  const markdown = dialog.locator(".wand-file-preview-markdown");
  await expect(markdown.getByRole("heading", { name: "Migration Preview" })).toBeVisible();
  await expect(markdown.locator("strong")).toHaveText("rendered");

  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("heading", { name: "wand-file-preview-smoke.ts" })).toBeVisible();
  await expect(dialog.locator(".wand-file-preview-code-content")).toContainText("console.log(answer);");

  await dialog.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = dialog.getByRole("textbox", { name: "编辑 wand-file-preview-smoke.ts" });
  await expect(editor).toBeFocused();
  const savedContent = "const saved = true;\nconsole.log(saved);";
  await editor.fill(savedContent);
  await expect(dialog.locator(".wand-file-preview-dirty")).toBeVisible();
  await page.keyboard.press("Control+S");
  await expect.poll(() => writes.at(-1)).toEqual({ path: textPath, content: savedContent });
  await expect(dialog.locator(".wand-file-preview-dirty")).toHaveCount(0);
  await expect(page.locator(".wand-ui-toast", { hasText: "已保存" })).toBeVisible();

  const dirtyContent = `${savedContent}\n// unsaved`;
  await editor.fill(dirtyContent);
  await expect(dialog.locator(".wand-file-preview-dirty")).toBeVisible();
  await page.keyboard.press("Escape");

  const discardHeading = page.getByRole("heading", { name: "放弃未保存的修改？" });
  await expect(discardHeading).toBeVisible();
  await page.getByRole("button", { name: "继续编辑" }).click();
  await expect(discardHeading).toHaveCount(0);
  await expect(editor).toHaveValue(dirtyContent);
  await expect(editor).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(discardHeading).toBeVisible();
  await page.getByRole("button", { name: "放弃修改" }).click();
  await expect(editor).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".wand-file-preview-code-content")).toContainText("const saved = true;");
  await expect(dialog.locator(".wand-file-preview-dirty")).toHaveCount(0);

  await shell.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(focusAnchor).toBeFocused();
});

test("competing overlay continues after dirty discard and replaces a clean preview synchronously", async ({ page }) => {
  const writes: SavedWrite[] = [];
  await installFilePreviewFixtures(page, writes);
  await login(page);

  const openPreview = async (): Promise<void> => {
    const opened = await page.evaluate(async (path) => {
      const controller = (window as Window & {
        __wandReactFilePreview?: { open(request: unknown): Promise<boolean> };
      }).__wandReactFilePreview;
      return controller?.open(path);
    }, textPath);
    expect(opened).toBe(true);
  };
  const triggerNewSession = async (): Promise<void> => {
    await page.locator("#drawer-new-session-button").evaluate(
      (element: HTMLButtonElement) => element.click(),
    );
  };

  await openPreview();
  const preview = page.getByTestId("file-preview-dialog");
  await preview.getByRole("button", { name: "编辑", exact: true }).click();
  await preview.getByRole("textbox", { name: /编辑 wand-file-preview-smoke\.ts/ }).fill("dirty");
  await triggerNewSession();

  const discard = page.getByRole("heading", { name: "放弃未保存的修改？" });
  await expect(discard).toBeVisible();
  await page.getByRole("button", { name: "放弃修改" }).click();
  const newSession = page.getByTestId("new-session-dialog");
  await expect(newSession).toBeVisible();
  await expect(preview).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(newSession).toBeHidden();

  await openPreview();
  await expect(preview).toBeVisible();
  const synchronousState = await page.locator("#drawer-new-session-button").evaluate(
    (element: HTMLButtonElement) => {
      element.click();
      const current = window as Window & {
        __wandReactFilePreview?: { isOpen(): boolean };
        __wandReactNewSession?: { isOpen(): boolean };
      };
      return {
        previewOpen: current.__wandReactFilePreview?.isOpen(),
        newSessionOpen: current.__wandReactNewSession?.isOpen(),
      };
    },
  );
  expect(synchronousState).toEqual({ previewOpen: false, newSessionOpen: true });
  await expect(newSession).toBeVisible();
  await expect(preview).toBeHidden();
});
