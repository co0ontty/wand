import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 8544;
const TEST_CONFIG_PATH = resolve(__dirname, "tests", "test-config.json");
const BASE_URL = `https://localhost:${TEST_PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run build && node dist/cli.js web --config ${TEST_CONFIG_PATH}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120 * 1000,
    ignoreHTTPSErrors: true,
  },
});
