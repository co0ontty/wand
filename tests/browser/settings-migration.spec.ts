import { expect, test } from "@playwright/test";
import { login, revealSettingsButton } from "./helpers";

test("Settings exposes all admin tabs, keyboard navigation, validation, and nested Escape order", async ({ page }) => {
  await login(page);
  await revealSettingsButton(page);
  const trigger = page.locator("#settings-button");
  await trigger.click();

  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  const tabs = dialog.getByRole("tab");
  await expect(tabs).toHaveCount(7);
  const generalTab = dialog.getByRole("tab", { name: /基本配置/ });
  await expect(generalTab).toHaveAttribute("data-state", "active");

  await generalTab.focus();
  await page.keyboard.press("End");
  await expect(dialog.getByRole("tab", { name: /关于/ })).toHaveAttribute("data-state", "active");
  await expect(dialog.getByRole("heading", { name: "关于 Wand" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(generalTab).toHaveAttribute("data-state", "active");

  const port = dialog.getByLabel("端口");
  const originalPort = await port.inputValue();
  await port.fill("70000");
  await dialog.getByRole("button", { name: "保存基本配置" }).click();
  await expect(dialog.getByText("端口必须是 1–65535 的整数。")).toBeVisible();
  await port.fill(originalPort);

  await dialog.getByRole("button", { name: "查看将注入的环境变量" }).click();
  const environmentDialog = page.getByTestId("settings-environment-dialog");
  await expect(environmentDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(environmentDialog).toBeHidden();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("tab", { name: /AI 与模型/ }).click();
  const commitSource = dialog.getByRole("group", { name: "生成方式" });
  await expect(commitSource.getByRole("radio")).toHaveCount(2);
  await expect(dialog.locator("#settings-commit-cli")).toHaveCount(0);
  await expect(dialog.locator("#settings-commit-model")).toHaveCount(0);
  await commitSource.getByRole("radio", { name: "CLI", exact: true }).check();
  await expect(dialog.getByText("使用当前会话的 CLI 和模型；推理固定为最低档。")).toBeVisible();
  await commitSource.getByRole("radio", { name: "直连 API", exact: true }).check();
  await expect(dialog.getByText("自动读取各工具的 API 配置并逐个尝试；全部不可用时使用当前会话 CLI。")).toBeVisible();

  await dialog.getByRole("tab", { name: /安全/ }).click();
  await dialog.getByLabel("新密码").fill("123");
  await dialog.getByLabel("确认密码").fill("123");
  await dialog.getByRole("button", { name: "修改密码并重新登录" }).click();
  await expect(dialog.getByText("密码长度至少为 6 个字符。")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Settings falls back to read-only About without leaking admin tabs", async ({ page }) => {
  await login(page);
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) });
  });
  await revealSettingsButton(page);
  await page.locator("#settings-button").click();

  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab")).toHaveCount(1);
  await expect(dialog.getByRole("tab", { name: /关于/ })).toBeVisible();
  await expect(dialog.getByText(/仅展示版本与客户端下载信息/)).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /安全/ })).toHaveCount(0);
});
