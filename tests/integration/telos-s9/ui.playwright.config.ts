import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { assertPlaywrightHost } from '../../support/playwright-host';
import { withBrowserStartup } from '../../support/playwright-browser-startup';

assertPlaywrightHost();
export default defineConfig({
  tsconfig: resolve(import.meta.dirname, 'ui.tsconfig.json'),
  testDir: '.',
  testMatch: 'ui.contract.ts',
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 2500 },
  outputDir: '../../../test-results/s9-ui',
  reporter: [['list'], ['json', { outputFile: '../../../test-results/s9-ui/report.json' }]],
  use: {
    baseURL: 'https://mitzo-ui.test',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: withBrowserStartup([
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ]),
});
