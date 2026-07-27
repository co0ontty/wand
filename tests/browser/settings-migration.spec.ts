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
  await expect(dialog.getByRole("heading", { name: "系统 AI 模型路由" })).toBeVisible();
  const routeList = dialog.getByRole("list", { name: "系统 AI API 调用顺序" });
  await expect(routeList.getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "上移线路 1" })).toBeDisabled();
  await dialog.getByRole("button", { name: "添加线路" }).click();
  await expect(routeList.getByRole("listitem")).toHaveCount(2);
  await dialog.locator("#settings-system-ai-0-model").fill("first-model");
  await dialog.locator("#settings-system-ai-1-model").fill("second-model");
  await dialog.getByRole("button", { name: "上移线路 2" }).click();
  await expect(dialog.locator("#settings-system-ai-0-model")).toHaveValue("second-model");
  await expect(dialog.locator("#settings-system-ai-1-model")).toHaveValue("first-model");
  await dialog.getByRole("button", { name: "删除线路 2" }).click();
  await expect(routeList.getByRole("listitem")).toHaveCount(1);
  await page.route("**/api/models/refresh", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models: [],
        codexModels: [],
        opencodeModels: [],
        grokModels: [],
        qoderModels: [],
        defaultModels: {},
      }),
    });
  });
  await dialog.getByRole("button", { name: "刷新模型列表" }).click();
  await expect(dialog.getByText(/模型列表已刷新/)).toBeVisible();
  await expect(dialog.locator("#settings-system-ai-0-model")).toHaveValue("second-model");

  let testedRoute: Record<string, unknown> | undefined;
  await page.route("**/api/settings/system-ai/test", async (route) => {
    testedRoute = (route.request().postDataJSON() as { route?: Record<string, unknown> }).route;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        source: "codex",
        requestedModel: "gpt-5.3-codex-spark",
        reasoningEffort: "low",
        latencyMs: 18,
      }),
    });
  });
  await dialog.locator("#settings-system-ai-0-url").fill("https://api.example.test/v1");
  await dialog.locator("#settings-system-ai-0-model").fill("gpt-5.3-codex-spark");
  await dialog.locator("#settings-system-ai-0-key").fill("browser-test-secret");
  await dialog.getByRole("button", { name: "测试线路" }).click();
  await expect(dialog.getByText("gpt-5.3-codex-spark 调用成功，18 ms，最低推理。")).toBeVisible();
  expect(testedRoute?.model).toBe("gpt-5.3-codex-spark");

  const commitSource = dialog.getByRole("group", { name: "生成方式" });
  await expect(commitSource.getByRole("radio")).toHaveCount(2);
  await expect(dialog.locator("#settings-commit-cli")).toHaveCount(0);
  await expect(dialog.locator("#settings-commit-model")).toHaveCount(0);
  await commitSource.getByRole("radio", { name: "CLI", exact: true }).check();
  await expect(dialog.getByText("使用当前会话的 CLI 和模型；推理固定为最低档。")).toBeVisible();
  await commitSource.getByRole("radio", { name: "直连 API", exact: true }).check();
  await expect(dialog.getByText("先按上方预设顺序以最低推理调用，再追加自动发现但尚未列出的工具 API；全部不可用时使用当前会话 CLI。")).toBeVisible();

  await dialog.getByRole("tab", { name: /安全/ }).click();
  await dialog.getByLabel("新密码").fill("123");
  await dialog.getByLabel("确认密码").fill("123");
  await dialog.getByRole("button", { name: "修改密码并重新登录" }).click();
  await expect(dialog.getByText("密码长度至少为 6 个字符。")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("App-style settings keep device controls available and require a password for admin tabs", async ({ page }) => {
  await login(page);
  let unlocked = false;
  await page.route("**/api/settings", async (route) => {
    if (unlocked) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "forbidden" }),
    });
  });
  await page.route("**/api/login", async (route) => {
    const body = route.request().postDataJSON() as { password?: string };
    if (body.password === "change-me") unlocked = true;
    await route.continue();
  });
  await revealSettingsButton(page);
  await page.locator("#settings-button").click();

  const dialog = page.getByTestId("settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab")).toHaveCount(2);
  await expect(dialog.getByRole("tab", { name: /通知/ })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /关于/ })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "通知", exact: true })).toBeVisible();
  await expect(dialog.getByText(/通知、触感、应用图标和客户端下载无需管理权限/)).toBeVisible();
  await expect(dialog.getByRole("tab", { name: /安全/ })).toHaveCount(0);

  await dialog.getByLabel("管理员密码").fill("wrong-password");
  await dialog.getByRole("button", { name: "登录管理设置" }).click();
  await expect(dialog.getByText(/密码错误/)).toBeVisible();
  await expect(dialog.getByRole("tab")).toHaveCount(2);

  await dialog.getByLabel("管理员密码").fill("change-me");
  await dialog.getByRole("button", { name: "登录管理设置" }).click();
  await expect(dialog.getByRole("tab")).toHaveCount(7);
  await expect(dialog.getByRole("tab", { name: /基本配置/ })).toHaveAttribute("data-state", "active");
});
