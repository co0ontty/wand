import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("Folder Picker supports quick paths, parent navigation, keyboard selection, validation, and Escape", async ({ page }) => {
  await login(page);

  await page.route("**/api/folders?*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.searchParams.get("q") || "/tmp";
    if (path === "/denied") {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "访问被拒绝：测试目录不可用。" }),
      });
      return;
    }

    const items = path === "/"
      ? [{ path: "/tmp", name: "tmp", type: "dir" }]
      : path === "/tmp"
        ? [
            { path: "/", name: "..", type: "parent" },
            { path: "/tmp/wand-folder-a", name: "wand-folder-a", type: "dir" },
            { path: "/tmp/wand-folder-b", name: "wand-folder-b", type: "dir" },
          ]
        : [
            { path: "/", name: "..", type: "parent" },
            { path: `${path}/child`, name: "child", type: "dir" },
          ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ currentPath: path, items }),
    });
  });

  const trigger = page.locator("#blank-chat-cwd");
  await expect(trigger).toBeVisible();
  const initialPath = (await page.locator("#blank-chat-cwd-path").textContent())?.trim() || "";
  await trigger.click();

  const dialog = page.getByTestId("folder-picker-dialog");
  const input = dialog.getByRole("textbox", { name: "工作目录", exact: true });
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue(initialPath);
  await expect(page.locator("#folder-picker-modal")).toHaveCount(0);
  await expect(page.locator("#folder-picker-dropdown")).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: /child/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole("button", { name: "根目录 /" }).click();
  await expect(input).toHaveValue("/");
  await expect(dialog.getByRole("option", { name: /tmp/ })).toBeVisible();

  await dialog.getByRole("button", { name: "临时目录 /tmp" }).click();
  await expect(input).toHaveValue("/tmp");
  await expect(dialog.getByRole("option", { name: /wand-folder-a/ })).toBeVisible();

  await input.focus();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: /返回上级目录/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("/");

  await dialog.getByRole("button", { name: "临时目录 /tmp" }).click();
  await expect(dialog.getByRole("option", { name: /wand-folder-a/ })).toBeVisible();
  await input.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: /wand-folder-a/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(page.locator("#blank-chat-cwd-path")).toContainText("/tmp/wand-folder-a");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("wand-working-dir")))
    .toBe("/tmp/wand-folder-a");

  await trigger.click();
  await input.fill("/denied");
  await expect(dialog.getByRole("alert")).toContainText("访问被拒绝");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
