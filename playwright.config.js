import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 15_000
  },
  reporter: [["list"]]
});
