import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const ptySession = {
  id: "pty-layout-fixture",
  title: "PTY layout fixture",
  sessionKind: "pty",
  sessionSource: "interactive",
  runner: "pty",
  provider: "claude",
  command: "claude",
  cwd: "/tmp/wand-pty-layout",
  mode: "default",
  status: "idle",
  exitCode: null,
  archived: false,
  startedAt: "2026-07-29T00:00:00.000Z",
};

test("web PTY keeps its floating remote and stretches the composer to its parent", async ({ page }) => {
  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([ptySession]),
  }));
  await page.route(new RegExp(`/api/sessions/${ptySession.id}(?:\\?.*)?$`), (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...ptySession,
      output: "",
      messages: [],
      messageOffset: 0,
      messageTotal: 0,
    }),
  }));

  await login(page);

  const joystickRoot = page.locator(".wand-joystick-root");
  await expect(joystickRoot).toHaveClass(/\bvisible\b/);
  await expect(page.locator(".wand-joystick-ball")).toBeVisible();

  const composerWidths = await page.locator(".input-panel").evaluate((panel) => {
    const row = panel.querySelector<HTMLElement>(".input-composer-row");
    if (!row) throw new Error("missing composer row");
    const panelStyle = getComputedStyle(panel);
    const parentContentWidth = panel.clientWidth
      - Number.parseFloat(panelStyle.paddingLeft)
      - Number.parseFloat(panelStyle.paddingRight);
    return {
      parentContentWidth,
      rowWidth: row.getBoundingClientRect().width,
    };
  });

  expect(Math.abs(composerWidths.rowWidth - composerWidths.parentContentWidth)).toBeLessThanOrEqual(1);
});
