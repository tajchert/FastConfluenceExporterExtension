import { defineConfig } from '@playwright/test';

/**
 * E2E: the built extension (`npm run build:e2e` → .output/chrome-mv3-e2e) loaded into a real
 * Chromium, exporting from a local mock Confluence (tests/e2e/mock-confluence/server.mjs).
 * The browser and the mock servers are worker-scoped fixtures (tests/e2e/fixtures.ts), so one
 * worker runs every test against one browser profile.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
  },
});
