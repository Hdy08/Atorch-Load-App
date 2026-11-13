import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/ui",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1050 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
  outputDir: "artifacts/playwright",
});
