import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    },
  },
  webServer: [
    {
      command: "pnpm dev",
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: !process.env.CI,
      env: { RECORDER_HEADLESS: "true" },
    },
    {
      command: "pnpm web",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
