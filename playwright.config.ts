import { defineConfig, devices } from "@playwright/test";

const port = 18444;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "./output/playwright-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "output/playwright-report", open: "never" }]] : "line",
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      // The Edge device profile runs on bundled Chromium by default so the
      // suite stays hermetic. Set PLAYWRIGHT_EDGE_CHANNEL=1 on a machine with
      // Edge installed to validate the branded channel as well.
      name: "edge-compat-desktop",
      use: {
        ...devices["Desktop Edge"],
        ...(process.env.PLAYWRIGHT_EDGE_CHANNEL === "1" ? { channel: "msedge" } : {}),
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "chromium-tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 900 } },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "webkit-mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit",
        viewport: { width: 375, height: 812 },
      },
    },
  ],
  webServer: {
    command: "node scripts/start-browser-test-server.js",
    url: `${baseURL}/api/session-check`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
