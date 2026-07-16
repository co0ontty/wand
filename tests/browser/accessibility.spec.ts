import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, revealSettingsButton } from "./helpers";

async function expectNoBlockingViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  const blocking = result.violations.filter((violation) => (
    violation.impact === "critical" || violation.impact === "serious"
  ));
  expect(blocking, blocking.map((violation) => (
    `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => node.target.join(" ")).join("\n")}`
  )).join("\n\n")).toEqual([]);
}

test("login and migrated overlay have no serious automated accessibility violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("#password")).toBeVisible();
  await expectNoBlockingViolations(page, "#app");

  await login(page);
  await page.evaluate(() => {
    void (window as Window & {
      __wandReactUi: {
        dialog(options: unknown): Promise<unknown>;
      };
    }).__wandReactUi.dialog({
      title: "Accessibility smoke",
      description: "The dialog must expose its title, description, actions, and focus lifecycle.",
      actions: [
        { label: "取消", value: false, kind: "secondary" },
        { label: "继续", value: true, kind: "primary", autoFocus: true },
      ],
    });
  });
  await expect(page.getByRole("heading", { name: "Accessibility smoke" })).toBeVisible();
  await expectNoBlockingViolations(page, "#overlay-root");
  await page.keyboard.press("Escape");

  await revealSettingsButton(page);
  await page.locator("#settings-button").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await expectNoBlockingViolations(page, "#overlay-root");
  await page.keyboard.press("Escape");
});
