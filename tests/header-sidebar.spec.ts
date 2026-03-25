import { test, expect } from "@playwright/test";

const BASE_URL = "https://127.0.0.1:8443";
const PASSWORD = "change-me";

test.use({
  baseURL: BASE_URL,
  ignoreHTTPSErrors: true,
});

test("header/sidebar animation works correctly", async ({ page }) => {
  // 1. Login via API
  const loginRes = await page.request.post(`${BASE_URL}/api/login`, {
    data: { password: PASSWORD },
    ignoreHTTPSErrors: true,
  });
  expect(loginRes.status()).toBe(200);

  // 2. Navigate to the main page
  await page.goto(BASE_URL);
  await page.waitForLoadState("networkidle");

  const toggleBtn = page.locator("#sessions-toggle-button");
  const sidebar = page.locator("#sessions-drawer");
  const topbar = page.locator("header.topbar");

  // The sidebar starts open by default; close it first
  await expect(toggleBtn).toBeVisible();
  await expect(sidebar).toHaveClass(/open/);
  await toggleBtn.click();
  await page.waitForTimeout(400);

  // 3. Screenshot: sidebar closed
  await expect(sidebar).not.toHaveClass(/open/);
  await page.screenshot({ path: "/tmp/header-test-closed.png", fullPage: true });
  console.log("Saved closed-state screenshot to /tmp/header-test-closed.png");

  // 4. Click the sidebar toggle button to open it
  await toggleBtn.click();

  // 5. Wait for sidebar animation (300ms)
  await page.waitForTimeout(400);

  // 6. Screenshot: sidebar open
  await page.screenshot({ path: "/tmp/header-test-open.png", fullPage: true });
  console.log("Saved open-state screenshot to /tmp/header-test-open.png");

  // 7. Verify sidebar (#sessions-drawer) has class "open"
  await expect(sidebar).toHaveClass(/open/);

  // 8. Verify toggle button has class "active" (hamburger -> X animation)
  await expect(toggleBtn).toHaveClass(/active/);

  // 9. Verify topbar does NOT have class "sidebar-open"
  //    (sidebar-open is applied to .main-layout, not the topbar itself)
  const topbarClasses = await topbar.getAttribute("class") || "";
  expect(topbarClasses).not.toContain("sidebar-open");

  // 10. Verify sidebar's CSS top is NOT 0px (should be below topbar, e.g. 52px)
  const sidebarTop = await sidebar.evaluate((el) => {
    return window.getComputedStyle(el).top;
  });
  console.log(`Sidebar CSS top: ${sidebarTop}`);
  expect(sidebarTop).not.toBe("0px");

  // Log topbar height for reference
  const topbarHeight = await topbar.evaluate((el) => {
    return window.getComputedStyle(el).height;
  });
  console.log(`Topbar height: ${topbarHeight}`);
});
