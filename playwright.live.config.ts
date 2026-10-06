import { defineConfig } from '@playwright/test';

/**
 * Opt-in live suite: the real extension (`npm run build:live` → .output/chrome-mv3-live, with
 * host access to the two sites below only) in Playwright's Chromium, exporting from two PUBLIC
 * Confluence sites as an anonymous visitor:
 *
 *  - Data Center: https://cwiki.apache.org/confluence (Apache Software Foundation)
 *  - Cloud:       https://uconn.atlassian.net/wiki (University of Connecticut, "AI" space)
 *
 * These are community infrastructure: one worker, small exports, low API concurrency, no
 * crawling. Not part of the default CI run (`npm run test:live`; GitHub: "Live sites" workflow).
 * Tests skip themselves when a site cannot be reached.
 */
export default defineConfig({
  testDir: 'tests/live',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 1,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-live' }]] : [['list']],
  outputDir: 'test-results/live',
  use: {
    trace: 'retain-on-failure',
    navigationTimeout: 90_000,
    actionTimeout: 30_000,
  },
});
