import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("macOS PTY embed exposes only the terminal canvas to the native shell", async ({ page }) => {
  await login(page);
  await page.goto("/?embed=terminal&nativeInput=1");
  await expect(page.locator("#settings-button")).toBeAttached();

  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const header = document.querySelector<HTMLElement>(".main-header-row");
    const composer = document.querySelector<HTMLElement>(".input-panel");
    const filePanel = document.querySelector<HTMLElement>(".file-side-panel");
    const mainContent = document.querySelector<HTMLElement>(".main-content");
    mainContent?.classList.add("file-panel-open");
    return {
      embedClass: root.classList.contains("is-wand-embed-terminal"),
      nativeInputClass: root.classList.contains("is-wand-native-input"),
      sidebarDisplay: sidebar && getComputedStyle(sidebar).display,
      headerDisplay: header && getComputedStyle(header).display,
      composerDisplay: composer && getComputedStyle(composer).display,
      filePanelDisplay: filePanel && getComputedStyle(filePanel).display,
      mainContentMarginRight: mainContent && getComputedStyle(mainContent).marginRight,
    };
  });

  expect(layout).toEqual({
    embedClass: true,
    nativeInputClass: true,
    sidebarDisplay: "none",
    headerDisplay: "none",
    composerDisplay: "none",
    filePanelDisplay: "none",
    mainContentMarginRight: "0px",
  });
});
