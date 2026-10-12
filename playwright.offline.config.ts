import { defineConfig, devices } from '@playwright/test';
import { assertPlaywrightHost } from './tests/support/playwright-host';

assertPlaywrightHost();

// Serve the compiled app entirely through request interception. This suite has
// no web server, backend, provider configuration or live network dependency.
export default defineConfig({
  globalSetup: './tests/support/playwright-global-setup.ts',
  testDir: './tests/offline',
  workers: 2,
  use: { baseURL: 'http://mitzo-ui.test', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
