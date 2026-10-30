// End-to-end tests in mock mode (no Supabase). The mock database lives in the
// dev server's memory and is reset before each test, so tests run one at a time.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    timezoneId: "Australia/Brisbane",
    locale: "en-AU",
    permissions: ["microphone"],
    trace: "retain-on-failure",
    launchOptions: {
      // Optional: a preinstalled Chromium when it differs from Playwright's pinned build.
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NEXT_PUBLIC_DATA_MODE: "mock" },
  },
});
