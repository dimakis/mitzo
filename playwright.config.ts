import { defineConfig, devices } from '@playwright/test';
import { assertPlaywrightHost } from './tests/support/playwright-host';
import { withBrowserStartup } from './tests/support/playwright-browser-startup';

assertPlaywrightHost();

export default defineConfig({
  testDir: './tests/browser',
  outputDir: 'test-results/browser',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/browser', open: 'never' }],
    ['./scripts/ci-browser-failure-reporter.mjs'],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: withBrowserStartup([
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ]),
  webServer: {
    command:
      'npx tsc -b packages/protocol packages/client && npx vite frontend --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    timeout: 120_000,
  },
});
