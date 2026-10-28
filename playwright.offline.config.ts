import { defineConfig, devices } from '@playwright/test';
import { assertPlaywrightHost } from './tests/support/playwright-host';
import { withBrowserStartup } from './tests/support/playwright-browser-startup';

assertPlaywrightHost();

// Serve the compiled app entirely through request interception. This suite has
// no web server, backend, provider configuration or live network dependency.
export default defineConfig({
  testDir: './tests/offline',
  outputDir: 'test-results/offline',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/offline', open: 'never' }],
    ['./scripts/ci-browser-failure-reporter.mjs'],
  ],
  workers: 1,
  use: {
    baseURL: 'http://mitzo-ui.test',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: withBrowserStartup([
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ]),
});
