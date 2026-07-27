import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("model refresh is a single in-flight POST and repopulates model controls", async ({ page }) => {
  const sessionId = "model-refresh-fixture";
  const session = {
    id: sessionId,
    sessionSource: "interactive",
    sessionKind: "structured",
    provider: "claude",
    command: "claude",
    runner: "claude-cli-print",
    cwd: "/tmp/wand-model-refresh",
    mode: "default",
    status: "idle",
    exitCode: null,
    archived: false,
    startedAt: "2026-07-21T00:00:00.000Z",
    title: "Model refresh fixture",
    structuredState: { provider: "claude", runner: "claude-cli-print", inFlight: false },
  };
  const initialCatalog = {
    models: [{ id: "claude-before-refresh", label: "Claude before refresh", availability: "verified" }],
    codexModels: [],
    opencodeModels: [],
    grokModels: [],
    qoderModels: [],
    defaultModel: "claude-before-refresh",
  };
  const refreshedCatalog = {
    ...initialCatalog,
    models: [{ id: "claude-after-refresh", label: "Claude after refresh", availability: "verified" }],
    defaultModel: "claude-after-refresh",
  };
  let refreshRequestCount = 0;
  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });

  await page.route("**/api/sessions", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([session]),
  }));
  await page.route(new RegExp(`/api/sessions/${sessionId}(?:\\?.*)?$`), (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...session,
      output: "",
      messages: [],
      messageOffset: 0,
      messageTotal: 0,
    }),
  }));
  await page.route(/\/api\/models(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(initialCatalog),
  }));
  await page.route(/\/api\/models\/refresh(?:\?.*)?$/, async (route) => {
    expect(route.request().method()).toBe("POST");
    refreshRequestCount += 1;
    await refreshGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(refreshedCatalog),
    });
  });

  await login(page);

  const modelSelect = page.locator(".composer-inline-config [data-mode-control='model']").first();
  await expect(modelSelect).toBeAttached();
  await expect(modelSelect.locator("option[value='claude-after-refresh']")).toHaveCount(0);

  const refreshButtons = page.locator("[data-models-refresh]");
  await expect(refreshButtons.first()).toBeVisible();
  await refreshButtons.first().click();
  await expect.poll(() => refreshRequestCount).toBe(1);
  await expect.poll(() => refreshButtons.evaluateAll((buttons) => (
    buttons.length > 0 && buttons.every((button) => (
      button.hasAttribute("disabled")
      && button.getAttribute("aria-busy") === "true"
      && button.classList.contains("is-refreshing")
    ))
  ))).toBe(true);

  // Dispatching a second delegated click while controls are disabled must not
  // issue another request; this also covers controls rendered in other trios.
  await refreshButtons.evaluateAll((buttons) => {
    for (const button of buttons) {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  expect(refreshRequestCount).toBe(1);

  releaseRefresh?.();
  await expect(modelSelect.locator("option[value='claude-after-refresh']")).toHaveCount(1);
  await expect(refreshButtons.first()).not.toBeDisabled();
  await expect.poll(() => refreshButtons.evaluateAll((buttons) => (
    buttons.length > 0 && buttons.every((button) => (
      button.getAttribute("aria-busy") === "false" && !button.classList.contains("is-refreshing")
    ))
  ))).toBe(true);
  expect(refreshRequestCount).toBe(1);
});
